import type { Context } from "@likego/context"
import type { Server } from "@likego/core"
import { waitForContext } from "@likego/core/lifecycle"
import type { Subscription } from "@nats-io/transport-node"

/** Creates one official NATS Core Subscription for lifecycle ownership at start time. */
export type NatsCoreSubscriptionFactory = () => Subscription | PromiseLike<Subscription>

/** Supplies an official Subscription directly or through a start-time factory. */
export type NatsCoreSubscriptionSource = Subscription | NatsCoreSubscriptionFactory

/** Describes a rejected attempt to restart a one-shot NATS Core server. */
export interface NatsCoreAlreadyStartedError extends Error {
  readonly name: "NatsCoreAlreadyStartedError"
  readonly code: "LIKEGO_NATS_CORE_ALREADY_STARTED"
  readonly status: Exclude<NatsCoreServerState, "idle">
}

/** Describes an official Subscription that closed outside its owner stop. */
export interface NatsCoreUnexpectedExitError extends Error {
  readonly name: "NatsCoreUnexpectedExitError"
  readonly code: "LIKEGO_NATS_CORE_UNEXPECTED_EXIT"
  readonly cause: Error | null
}

/** Describes a Subscription that required unsubscribe after its drain boundary. */
export interface NatsCoreDrainTimeoutError extends Error {
  readonly name: "NatsCoreDrainTimeoutError"
  readonly code: "LIKEGO_NATS_CORE_DRAIN_TIMEOUT"
  readonly timeoutMs: number
  readonly forced: true
}

interface NatsCoreConfig {
  drainTimeoutMs: number
}

/** Applies one construction-time lifecycle option to a NATS Core server. */
type NatsCoreOption = (config: NatsCoreConfig) => void

type NatsCoreServerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"
type NativeOperation = "startup" | "closed" | "drain" | "unsubscribe"

interface NatsCoreStopOperation {
  readonly owner: Promise<void>
  readonly terminal: Promise<Error | null>
}

const alreadyStartedName: NatsCoreAlreadyStartedError["name"] = "NatsCoreAlreadyStartedError"
const alreadyStartedCode: NatsCoreAlreadyStartedError["code"] = "LIKEGO_NATS_CORE_ALREADY_STARTED"
const unexpectedExitName: NatsCoreUnexpectedExitError["name"] = "NatsCoreUnexpectedExitError"
const unexpectedExitCode: NatsCoreUnexpectedExitError["code"] = "LIKEGO_NATS_CORE_UNEXPECTED_EXIT"
const drainTimeoutName: NatsCoreDrainTimeoutError["name"] = "NatsCoreDrainTimeoutError"
const drainTimeoutCode: NatsCoreDrainTimeoutError["code"] = "LIKEGO_NATS_CORE_DRAIN_TIMEOUT"
const forced: NatsCoreDrainTimeoutError["forced"] = true
const maximumTimerDelayMs = 2_147_483_647

/**
 * Configures the NATS Core drain boundary before requesting native unsubscribe.
 *
 * The provider boundary is necessary because Subscription.drain() has no AbortSignal.
 */
export function natsCoreDrainTimeout(timeoutMs: number): NatsCoreOption {
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > maximumTimerDelayMs
  ) {
    throw new RangeError(
      "NATS Core drain timeout must be an integer from 0 to 2147483647 milliseconds"
    )
  }
  return (config) => {
    config.drainTimeoutMs = timeoutMs
  }
}

/** Deliberately observes an internally retained rejection. */
function consumeFailure(_value: unknown): void {}

/** Preserves native Error identity while normalizing invalid rejection values. */
function normalizeError(operation: NativeOperation, value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(`NATS Core ${operation} rejected with a non-Error value`, { cause: value })
}

/** Reports whether an untrusted factory result has the lifecycle surface of Subscription. */
function isSubscription(value: unknown): value is Subscription {
  if (typeof value !== "object" || value === null) return false
  return (
    typeof Reflect.get(value, "drain") === "function" &&
    typeof Reflect.get(value, "unsubscribe") === "function" &&
    "closed" in value
  )
}

/** Resolves one direct or factory-provided official Subscription. */
async function acquireSubscription(source: NatsCoreSubscriptionSource): Promise<Subscription> {
  const value: unknown = typeof source === "function" ? await source() : source
  if (!isSubscription(value)) {
    throw new TypeError("NATS Core source must provide an official Subscription")
  }
  return value
}

/** Builds an immutable one-shot lifecycle error. */
function newAlreadyStartedError(
  status: Exclude<NatsCoreServerState, "idle">
): NatsCoreAlreadyStartedError {
  const error = Object.assign(new Error("NATS Core subscription server has already started"), {
    name: alreadyStartedName,
    code: alreadyStartedCode,
    status
  })
  return Object.freeze(error)
}

/** Builds an immutable passive-terminal lifecycle error. */
function newUnexpectedExitError(exitCause: Error | null): NatsCoreUnexpectedExitError {
  const error = Object.assign(
    new Error("NATS Core subscription closed outside its owner stop", { cause: exitCause }),
    {
      name: unexpectedExitName,
      code: unexpectedExitCode,
      cause: exitCause
    }
  )
  return Object.freeze(error)
}

/** Builds an immutable forced-unsubscribe lifecycle error. */
function newDrainTimeoutError(timeoutMs: number): NatsCoreDrainTimeoutError {
  const error = Object.assign(
    new Error(`NATS Core subscription exceeded drain timeout of ${timeoutMs}ms`),
    {
      name: drainTimeoutName,
      code: drainTimeoutCode,
      timeoutMs,
      forced
    }
  )
  return Object.freeze(error)
}

/** Returns one exact failure or one ordered aggregate without duplicating identity. */
function combinedFailure(failures: readonly Error[]): Error | null {
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  return new AggregateError(
    failures,
    "NATS Core drain, unsubscribe, or terminal observation failed",
    { cause: first }
  )
}

/** Observes the official native terminal without consuming the Subscription iterator. */
function observeClosed(subscription: Subscription): Promise<Error | null> {
  let operation: PromiseLike<void | Error>
  try {
    operation = subscription.closed
  } catch (value) {
    return Promise.resolve(normalizeError("closed", value))
  }
  return Promise.resolve(operation).then(
    (value) => (value instanceof Error ? value : null),
    (value: unknown) => normalizeError("closed", value)
  )
}

/** Releases an acquired but unaccepted Subscription without waiting forever for terminal. */
function releaseUnaccepted(subscription: Subscription, primary: Error): Error {
  try {
    subscription.unsubscribe()
  } catch (value) {
    const cleanup = normalizeError("unsubscribe", value)
    void observeClosed(subscription).catch(consumeFailure)
    return new AggregateError(
      [primary, cleanup],
      "NATS Core startup and Subscription rollback failed",
      { cause: primary }
    )
  }
  void observeClosed(subscription).catch(consumeFailure)
  return primary
}

/** Releases a Subscription whose factory settled after the startup caller abandoned waiting. */
function releaseLateSubscription(operation: Promise<Subscription>, primary: Error): void {
  void operation.then((subscription) => {
    void releaseUnaccepted(subscription, primary)
  }, consumeFailure)
}

/** Owns one bounded waiter and a separate true native terminal barrier. */
function ownSubscriptionStop(
  subscription: Subscription,
  closed: Promise<Error | null>,
  timeoutMs: number
): NatsCoreStopOperation {
  let ownerPublished = false
  let drainSettled = false
  let closedSettled = false
  let forceRequested = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  let resolveOwner: (value: undefined) => void = consumeFailure
  let rejectOwner: (error: Error) => void = consumeFailure
  let resolveTerminal: (failure: Error | null) => void = consumeFailure
  const deadline = performance.now() + timeoutMs
  const failures: Error[] = []
  const owner = new Promise<void>((resolve, reject) => {
    resolveOwner = resolve
    rejectOwner = reject
  })
  const terminal = new Promise<Error | null>((resolve) => {
    resolveTerminal = resolve
  })

  /** Retains each independent native failure once by identity. */
  const admitFailure = (error: Error): void => {
    if (!failures.includes(error)) failures.push(error)
  }

  /** Publishes the bounded owner-wait result exactly once. */
  const publishOwner = (): void => {
    if (ownerPublished) return
    ownerPublished = true
    if (timeout !== null) clearTimeout(timeout)
    const failure = combinedFailure(failures)
    if (failure === null) resolveOwner(undefined)
    else rejectOwner(failure)
  }

  /** Publishes terminal only after drain and the official closed Promise settle. */
  const publishTerminal = (): void => {
    if (!drainSettled || !closedSettled) return
    publishOwner()
    resolveTerminal(combinedFailure(failures))
  }

  /** Requests native unsubscribe without claiming that terminal has happened. */
  const requestForce = (primary: Error): void => {
    admitFailure(primary)
    if (forceRequested) return
    forceRequested = true
    try {
      subscription.unsubscribe()
    } catch (value) {
      admitFailure(normalizeError("unsubscribe", value))
    }
  }

  /** Applies the provider boundary and releases only the owner waiter. */
  const timedOut = (): void => {
    if (ownerPublished) return
    requestForce(newDrainTimeoutError(timeoutMs))
    publishOwner()
  }

  /** Records drain completion, including failures that arrive after owner timeout. */
  const finishDrain = (error: Error | null): void => {
    if (!ownerPublished && performance.now() >= deadline) timedOut()
    if (error !== null) requestForce(error)
    drainSettled = true
    publishTerminal()
  }

  closed.then((error) => {
    if (error !== null) admitFailure(error)
    closedSettled = true
    publishTerminal()
  })

  if (timeoutMs > 0) timeout = setTimeout(timedOut, timeoutMs)

  let drain: Promise<void>
  try {
    drain = Promise.resolve(subscription.drain())
  } catch (value) {
    drain = Promise.reject(normalizeError("drain", value))
  }
  drain.then(
    () => {
      finishDrain(null)
    },
    (value: unknown) => {
      finishDrain(normalizeError("drain", value))
    }
  )

  if (timeoutMs === 0 || performance.now() >= deadline) timedOut()
  return Object.freeze({ owner, terminal })
}

/** Creates a one-shot structural Server that owns only a native Subscription lifecycle. */
export function newNatsCoreServer(
  source: NatsCoreSubscriptionSource,
  ...options: readonly NatsCoreOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): Server {
  const config: NatsCoreConfig = { drainTimeoutMs: 25_000 }
  for (const option of options) option(config)
  const factorySource = typeof source === "function"

  let state: NatsCoreServerState = "idle"
  let acceptedSubscription: Subscription | null = null
  let closedObservation: Promise<Error | null> | null = null
  let admission: Promise<void> | null = null
  let ownerStop: Promise<void> | null = null
  const completion = new AbortController()
  const doneSucceeded = Object.freeze({ kind: "succeeded" })
  const donePromise = new Promise<void>((resolve, reject) => {
    completion.signal.addEventListener(
      "abort",
      () => {
        const reason: unknown = completion.signal.reason
        if (reason === doneSucceeded) resolve()
        else reject(reason)
      },
      { once: true }
    )
  })
  void donePromise.catch(consumeFailure)

  /** Settles the stable terminal successfully exactly once. */
  const succeed = (): void => {
    state = "stopped"
    completion.abort(doneSucceeded)
  }

  /** Settles the stable terminal with one exact lifecycle failure. */
  const fail = (error: Error): void => {
    state = "failed"
    completion.abort(error)
  }

  /** Starts or joins the owner stop after any in-flight admission completes. */
  const beginOwnerStop = (): Promise<void> => {
    if (ownerStop !== null) return ownerStop
    const starting = admission
    if (starting === null) return Promise.resolve()
    ownerStop = starting.then(() => {
      if (state === "failed" || state === "stopped") return donePromise
      const subscription = acceptedSubscription
      const closed = closedObservation
      if (subscription === null || closed === null) return donePromise
      state = "stopping"
      const operation = ownSubscriptionStop(subscription, closed, config.drainTimeoutMs)
      void operation.terminal.then((failure) => {
        if (failure === null) succeed()
        else fail(failure)
      })
      return operation.owner
    })
    void ownerStop.catch(consumeFailure)
    return ownerStop
  }

  return Object.freeze({
    /** Acquires one official Subscription and remains pending for its full native runtime. */
    start(ctx: Context): Promise<void> {
      if (state !== "idle") return Promise.reject(newAlreadyStartedError(state))
      state = "starting"
      admission = (async (): Promise<void> => {
        let unacceptedFactorySubscription: Subscription | null = null
        let acquisition: Promise<Subscription> | null = null
        try {
          await waitForContext(ctx, Promise.resolve())
          acquisition = acquireSubscription(source)
          let subscription: Subscription
          try {
            subscription = await waitForContext(ctx, acquisition)
            if (factorySource) unacceptedFactorySubscription = subscription
          } catch (value) {
            if (factorySource) {
              releaseLateSubscription(acquisition, normalizeError("startup", value))
            }
            throw value
          }
          await waitForContext(ctx, Promise.resolve())

          const closed = observeClosed(subscription)
          acceptedSubscription = subscription
          closedObservation = closed
          state = "running"

          closed.then((error) => {
            if (state === "running") fail(newUnexpectedExitError(error))
          })
        } catch (value) {
          const primary = normalizeError("startup", value)
          const failure =
            unacceptedFactorySubscription === null
              ? primary
              : releaseUnaccepted(unacceptedFactorySubscription, primary)
          fail(failure)
          throw failure
        }
      })()
      void admission.catch(consumeFailure)
      const running = admission.then(() => donePromise)
      void running.catch(consumeFailure)
      return running
    },
    /** Starts native drain while allowing only this caller to abandon its wait. */
    stop(stopContext: Context): Promise<void> {
      if (state === "idle") return Promise.resolve()
      return waitForContext(stopContext, beginOwnerStop())
    }
  })
}

import type { BrokerEvent, Subscriber } from "@likego/broker"
import { registerSubscriberTerminal } from "@likego/broker/provider"
import { background, type Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"

type NativeBrokerKind = "core" | "jetstream"
type NativeBrokerOperation = "closed" | "drain" | "unsubscribe" | "close" | "stop"

export interface NativeBrokerLifecycle {
  /** Identifies the native lifecycle whose exact semantics are retained. */
  readonly kind: NativeBrokerKind
  /** Starts the provider's graceful subscription shutdown. */
  graceful(): void | Error | PromiseLike<void | Error>
  /** Returns the provider's true terminal barrier. */
  terminal(): PromiseLike<void | Error>
  /** Forces only this subscription to stop after graceful shutdown fails or times out. */
  force(): void
}

interface NativeBrokerStopOperation {
  readonly owner: Promise<void>
  readonly terminal: Promise<Error | null>
}

const nativeBrokerShutdownTimeoutMs = 25_000

interface NativeBrokerRuntime {
  /** Private true-native terminal used only for delivery cleanup. */
  readonly running: Promise<void>
  /** Starts or joins the provider subscription shutdown. */
  unsubscribe(ctx: Context): Promise<void>
}

/** Preserves Error identity while normalizing invalid rejection values. */
function normalizeError(operation: string, value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(`NATS Broker ${operation} rejected with a non-Error value`, { cause: value })
}

/** Builds the provider-specific immutable passive-terminal lifecycle error. */
function newUnexpectedExitError(kind: NativeBrokerKind, exitCause: Error | null): Error {
  if (kind === "core") {
    return Object.freeze(
      Object.assign(
        new Error("NATS Core subscription closed outside its owner stop", { cause: exitCause }),
        {
          name: "NatsCoreUnexpectedExitError",
          code: "LIKEGO_NATS_CORE_UNEXPECTED_EXIT",
          cause: exitCause
        }
      )
    )
  }
  return Object.freeze(
    Object.assign(
      new Error("NATS JetStream ConsumerMessages closed outside their owner stop", {
        cause: exitCause
      }),
      {
        name: "NatsJetStreamUnexpectedExitError",
        code: "LIKEGO_NATS_JETSTREAM_UNEXPECTED_EXIT",
        cause: exitCause
      }
    )
  )
}

/** Builds the provider-specific immutable shutdown-timeout error. */
function newDrainTimeoutError(kind: NativeBrokerKind): Error {
  if (kind === "core") {
    return Object.freeze(
      Object.assign(
        new Error(
          `NATS Core subscription exceeded drain timeout of ${nativeBrokerShutdownTimeoutMs}ms`
        ),
        {
          name: "NatsCoreDrainTimeoutError",
          code: "LIKEGO_NATS_CORE_DRAIN_TIMEOUT",
          timeoutMs: nativeBrokerShutdownTimeoutMs,
          forced: true
        }
      )
    )
  }
  return Object.freeze(
    Object.assign(
      new Error(
        `NATS JetStream ConsumerMessages exceeded close timeout of ${nativeBrokerShutdownTimeoutMs}ms`
      ),
      {
        name: "NatsJetStreamCloseTimeoutError",
        code: "LIKEGO_NATS_JETSTREAM_CLOSE_TIMEOUT",
        timeoutMs: nativeBrokerShutdownTimeoutMs,
        forced: true
      }
    )
  )
}

/** Combines distinct failures without replacing the only exact failure. */
function combinedFailure(failures: readonly Error[]): Error | null {
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  return new AggregateError(failures, "NATS Broker delivery or lifecycle failed", { cause: first })
}

/** Deliberately observes an internally retained rejection. */
function consumeFailure(_value: unknown): void {}

/** Observes the provider terminal without consuming its delivery iterator. */
function observeNativeTerminal(lifecycle: NativeBrokerLifecycle): Promise<Error | null> {
  let operation: PromiseLike<void | Error>
  try {
    operation = lifecycle.terminal()
  } catch (value) {
    return Promise.resolve(normalizeError("closed", value))
  }
  return Promise.resolve(operation).then(
    (value) => (value instanceof Error ? value : null),
    (value: unknown) => normalizeError("closed", value)
  )
}

/** Rejects provisional admission after force cleanup reaches terminal or its provider boundary. */
export async function rejectNativeBrokerAdmission(
  lifecycle: NativeBrokerLifecycle,
  primary: Error
): Promise<never> {
  const failures: Error[] = [primary]
  const nativeTerminal = observeNativeTerminal(lifecycle)
  try {
    lifecycle.force()
  } catch (value) {
    const operation: NativeBrokerOperation = lifecycle.kind === "core" ? "unsubscribe" : "stop"
    failures.push(normalizeError(operation, value))
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () => resolve(newDrainTimeoutError(lifecycle.kind)),
      nativeBrokerShutdownTimeoutMs
    )
  })
  const terminalFailure = await Promise.race([nativeTerminal, timeout])
  if (timer !== null) clearTimeout(timer)
  if (terminalFailure !== null && !failures.includes(terminalFailure))
    failures.push(terminalFailure)
  if (failures.length === 1) throw primary
  throw new AggregateError(failures, "NATS Broker admission and native rollback failed", {
    cause: primary
  })
}

/** Owns one bounded graceful waiter and one separate true native terminal barrier. */
function ownNativeStop(
  lifecycle: NativeBrokerLifecycle,
  nativeTerminal: Promise<Error | null>
): NativeBrokerStopOperation {
  let ownerPublished = false
  let gracefulSettled = false
  let terminalSettled = false
  let forceRequested = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  let resolveOwner: (value: undefined) => void = consumeFailure
  let rejectOwner: (error: Error) => void = consumeFailure
  let resolveTerminal: (failure: Error | null) => void = consumeFailure
  const deadline = performance.now() + nativeBrokerShutdownTimeoutMs
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

  /** Publishes the bounded owner result exactly once. */
  const publishOwner = (): void => {
    if (ownerPublished) return
    ownerPublished = true
    if (timeout !== null) clearTimeout(timeout)
    const failure = combinedFailure(failures)
    if (failure === null) resolveOwner(undefined)
    else rejectOwner(failure)
  }

  /** Publishes terminal only after graceful shutdown and native terminal both settle. */
  const publishTerminal = (): void => {
    if (!gracefulSettled || !terminalSettled) return
    publishOwner()
    resolveTerminal(combinedFailure(failures))
  }

  /** Forces only this subscription without claiming that terminal has happened. */
  const requestForce = (primary: Error): void => {
    admitFailure(primary)
    if (forceRequested) return
    forceRequested = true
    try {
      lifecycle.force()
    } catch (value) {
      admitFailure(normalizeError(lifecycle.kind === "core" ? "unsubscribe" : "stop", value))
    }
  }

  /** Applies the provider owner boundary while preserving the true terminal barrier. */
  const timedOut = (): void => {
    if (ownerPublished) return
    requestForce(newDrainTimeoutError(lifecycle.kind))
    publishOwner()
  }

  /** Records graceful settlement, including failures that arrive after owner timeout. */
  const finishGraceful = (error: Error | null): void => {
    if (!ownerPublished && performance.now() >= deadline) timedOut()
    if (error !== null) requestForce(error)
    gracefulSettled = true
    publishTerminal()
  }

  nativeTerminal.then((error) => {
    if (error !== null) admitFailure(error)
    terminalSettled = true
    publishTerminal()
  })
  timeout = setTimeout(timedOut, nativeBrokerShutdownTimeoutMs)

  let graceful: Promise<void | Error>
  try {
    graceful = Promise.resolve(lifecycle.graceful())
  } catch (value) {
    const operation: NativeBrokerOperation = lifecycle.kind === "core" ? "drain" : "close"
    graceful = Promise.reject(normalizeError(operation, value))
  }
  graceful.then(
    (value) => {
      finishGraceful(value instanceof Error ? value : null)
    },
    (value: unknown) => {
      const operation: NativeBrokerOperation = lifecycle.kind === "core" ? "drain" : "close"
      finishGraceful(normalizeError(operation, value))
    }
  )
  return Object.freeze({ owner, terminal })
}

/** Creates one private runtime that owns only an already accepted native subscription. */
export function nativeBrokerRuntime(lifecycle: NativeBrokerLifecycle): NativeBrokerRuntime {
  let state: "running" | "stopping" | "stopped" | "failed" = "running"
  let ownerStop: Promise<void> | null = null
  const nativeTerminal = observeNativeTerminal(lifecycle)
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

  /** Starts or joins the owner stop independently of caller cancellation. */
  const beginOwnerStop = (): Promise<void> => {
    if (ownerStop !== null) return ownerStop
    if (state !== "running") return donePromise
    state = "stopping"
    const operation = ownNativeStop(lifecycle, nativeTerminal)
    ownerStop = operation.owner
    void operation.terminal.then((failure) => {
      if (failure === null) succeed()
      else fail(failure)
    })
    return ownerStop
  }

  nativeTerminal.then((error) => {
    if (state === "running") fail(newUnexpectedExitError(lifecycle.kind, error))
  })

  return Object.freeze({
    running: donePromise,
    /** Starts owner shutdown while allowing only this caller to abandon its wait. */
    unsubscribe(stopContext: Context): Promise<void> {
      return waitForContext(stopContext, beginOwnerStop())
    }
  })
}

/** Resolves only when both delivery and native lifecycle terminate, preserving all failures. */
async function observeCompletion(
  nativeDone: Promise<void>,
  consuming: Promise<void>
): Promise<void> {
  const results = await Promise.allSettled([nativeDone, consuming])
  const failures: Error[] = []
  for (const result of results) {
    if (result.status !== "rejected") continue
    const failure = normalizeError("completion", result.reason)
    if (!failures.includes(failure)) failures.push(failure)
  }
  const failure = combinedFailure(failures)
  if (failure !== null) throw failure
}

/**
 * Couples one native async iterable to its captured private runtime without owning the NATS
 * connection or implementing a second drain path.
 */
export function managedSubscriber<Native>(
  ctx: Context,
  topic: string,
  stream: AsyncIterable<Native>,
  runtime: NativeBrokerRuntime,
  event: (native: Native) => BrokerEvent<Native>,
  handler: (ctx: Context, event: BrokerEvent<Native>) => void | PromiseLike<void>
): Subscriber {
  if (
    runtime === null ||
    typeof runtime !== "object" ||
    !(runtime.running instanceof Promise) ||
    typeof runtime.unsubscribe !== "function"
  ) {
    throw new TypeError("NATS Broker lifecycle runtime is invalid")
  }
  let deliveryFailure: Error | null = null

  /** Consumes native deliveries serially and requests the existing owner stop after failure. */
  async function consume(): Promise<void> {
    try {
      for await (const native of stream) await handler(ctx, event(native))
    } catch (value) {
      const primary = normalizeError("handler", value)
      deliveryFailure = primary
      try {
        const stopping = Promise.resolve(runtime.unsubscribe(background()))
        void stopping.catch(consumeFailure)
      } catch (stopValue) {
        const stopFailure = normalizeError("stop", stopValue)
        if (stopFailure !== primary) {
          throw new AggregateError(
            [primary, stopFailure],
            "NATS Broker handler and lifecycle stop failed",
            { cause: primary }
          )
        }
      }
      throw primary
    }
  }

  const consuming = consume()
  const completion = observeCompletion(runtime.running, consuming)
  void completion.catch(consumeFailure)

  return registerSubscriberTerminal(
    Object.freeze({
      topic,
      /** Delegates upstream-style unsubscribe and preserves an observed handler failure. */
      unsubscribe(stopContext: Context): Promise<void> {
        try {
          return Promise.resolve(runtime.unsubscribe(stopContext)).then(
            () => {
              if (deliveryFailure !== null) throw deliveryFailure
            },
            (value: unknown) => {
              const stopFailure = normalizeError("unsubscribe", value)
              if (deliveryFailure === null || deliveryFailure === stopFailure) throw stopFailure
              throw new AggregateError(
                [deliveryFailure, stopFailure],
                "NATS Broker handler and unsubscribe failed",
                { cause: deliveryFailure }
              )
            }
          )
        } catch (value) {
          const stopFailure = normalizeError("unsubscribe", value)
          if (deliveryFailure === null || deliveryFailure === stopFailure) {
            return Promise.reject(stopFailure)
          }
          return Promise.reject(
            new AggregateError(
              [deliveryFailure, stopFailure],
              "NATS Broker handler and unsubscribe failed",
              { cause: deliveryFailure }
            )
          )
        }
      }
    }),
    completion
  )
}

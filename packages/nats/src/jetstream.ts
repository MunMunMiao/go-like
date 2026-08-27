import type { Context } from "@go-like/context"
import type { Server } from "@go-like/core"
import { waitForContext } from "@go-like/core/lifecycle"
import type { ConsumerMessages } from "@nats-io/jetstream"

/** Creates official ConsumerMessages for lifecycle ownership at start time. */
export type NatsJetStreamMessagesFactory = () => ConsumerMessages | PromiseLike<ConsumerMessages>

/** Supplies official ConsumerMessages directly or through a start-time factory. */
export type NatsJetStreamMessagesSource = ConsumerMessages | NatsJetStreamMessagesFactory

/** Describes a rejected attempt to restart a one-shot JetStream server. */
export interface NatsJetStreamAlreadyStartedError extends Error {
  readonly name: "NatsJetStreamAlreadyStartedError"
  readonly code: "GO_LIKE_NATS_JETSTREAM_ALREADY_STARTED"
  readonly status: Exclude<NatsJetStreamServerState, "idle">
}

/** Describes ConsumerMessages that closed outside their owner stop. */
export interface NatsJetStreamUnexpectedExitError extends Error {
  readonly name: "NatsJetStreamUnexpectedExitError"
  readonly code: "GO_LIKE_NATS_JETSTREAM_UNEXPECTED_EXIT"
  readonly cause: Error | null
}

/** Describes ConsumerMessages that required stop after their close boundary. */
export interface NatsJetStreamCloseTimeoutError extends Error {
  readonly name: "NatsJetStreamCloseTimeoutError"
  readonly code: "GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT"
  readonly timeoutMs: number
  readonly forced: true
}

interface NatsJetStreamConfig {
  closeTimeoutMs: number
}

/** Applies one construction-time lifecycle option to a JetStream server. */
type NatsJetStreamOption = (config: NatsJetStreamConfig) => void

type NatsJetStreamServerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"
type NativeOperation = "startup" | "closed" | "close" | "stop"

interface NatsJetStreamStopOperation {
  readonly owner: Promise<void>
  readonly terminal: Promise<Error | null>
}

const alreadyStartedName: NatsJetStreamAlreadyStartedError["name"] =
  "NatsJetStreamAlreadyStartedError"
const alreadyStartedCode: NatsJetStreamAlreadyStartedError["code"] =
  "GO_LIKE_NATS_JETSTREAM_ALREADY_STARTED"
const unexpectedExitName: NatsJetStreamUnexpectedExitError["name"] =
  "NatsJetStreamUnexpectedExitError"
const unexpectedExitCode: NatsJetStreamUnexpectedExitError["code"] =
  "GO_LIKE_NATS_JETSTREAM_UNEXPECTED_EXIT"
const closeTimeoutName: NatsJetStreamCloseTimeoutError["name"] = "NatsJetStreamCloseTimeoutError"
const closeTimeoutCode: NatsJetStreamCloseTimeoutError["code"] =
  "GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT"
const forced: NatsJetStreamCloseTimeoutError["forced"] = true
const maximumTimerDelayMs = 2_147_483_647

/**
 * Configures the JetStream close boundary before requesting native stop.
 *
 * The provider boundary is necessary because ConsumerMessages.close() has no AbortSignal.
 */
export function natsJetStreamCloseTimeout(timeoutMs: number): NatsJetStreamOption {
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > maximumTimerDelayMs
  ) {
    throw new RangeError(
      "NATS JetStream close timeout must be an integer from 0 to 2147483647 milliseconds"
    )
  }
  return (config) => {
    config.closeTimeoutMs = timeoutMs
  }
}

/** Deliberately observes an internally retained rejection. */
function consumeFailure(_value: unknown): void {}

/** Preserves native Error identity while normalizing invalid rejection values. */
function normalizeError(operation: NativeOperation, value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(`NATS JetStream ${operation} rejected with a non-Error value`, { cause: value })
}

/** Reports whether an untrusted factory result has the ConsumerMessages lifecycle surface. */
function isConsumerMessages(value: unknown): value is ConsumerMessages {
  if (typeof value !== "object" || value === null) return false
  return (
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "closed") === "function" &&
    typeof Reflect.get(value, "stop") === "function"
  )
}

/** Resolves one direct or factory-provided official ConsumerMessages instance. */
async function acquireMessages(source: NatsJetStreamMessagesSource): Promise<ConsumerMessages> {
  const value: unknown = typeof source === "function" ? await source() : source
  if (!isConsumerMessages(value)) {
    throw new TypeError("NATS JetStream source must provide official ConsumerMessages")
  }
  return value
}

/** Builds an immutable one-shot lifecycle error. */
function newAlreadyStartedError(
  status: Exclude<NatsJetStreamServerState, "idle">
): NatsJetStreamAlreadyStartedError {
  const error = Object.assign(new Error("NATS JetStream messages server has already started"), {
    name: alreadyStartedName,
    code: alreadyStartedCode,
    status
  })
  return Object.freeze(error)
}

/** Builds an immutable passive-terminal lifecycle error. */
function newUnexpectedExitError(exitCause: Error | null): NatsJetStreamUnexpectedExitError {
  const error = Object.assign(
    new Error("NATS JetStream ConsumerMessages closed outside their owner stop", {
      cause: exitCause
    }),
    {
      name: unexpectedExitName,
      code: unexpectedExitCode,
      cause: exitCause
    }
  )
  return Object.freeze(error)
}

/** Builds an immutable forced-stop lifecycle error. */
function newCloseTimeoutError(timeoutMs: number): NatsJetStreamCloseTimeoutError {
  const error = Object.assign(
    new Error(`NATS JetStream ConsumerMessages exceeded close timeout of ${timeoutMs}ms`),
    {
      name: closeTimeoutName,
      code: closeTimeoutCode,
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
    "NATS JetStream close, stop, or terminal observation failed",
    { cause: first }
  )
}

/** Observes the official terminal without consuming the ConsumerMessages iterator. */
function observeClosed(messages: ConsumerMessages): Promise<Error | null> {
  let operation: PromiseLike<void | Error>
  try {
    operation = messages.closed()
  } catch (value) {
    return Promise.resolve(normalizeError("closed", value))
  }
  return Promise.resolve(operation).then(
    (value) => (value instanceof Error ? value : null),
    (value: unknown) => normalizeError("closed", value)
  )
}

/** Releases acquired but unaccepted ConsumerMessages without waiting forever for terminal. */
function releaseUnaccepted(messages: ConsumerMessages, primary: Error): Error {
  try {
    messages.stop()
  } catch (value) {
    const cleanup = normalizeError("stop", value)
    void observeClosed(messages).catch(consumeFailure)
    return new AggregateError(
      [primary, cleanup],
      "NATS JetStream startup and ConsumerMessages rollback failed",
      { cause: primary }
    )
  }
  void observeClosed(messages).catch(consumeFailure)
  return primary
}

/** Releases ConsumerMessages whose factory settled after startup waiting was abandoned. */
function releaseLateMessages(operation: Promise<ConsumerMessages>, primary: Error): void {
  void operation.then((messages) => {
    void releaseUnaccepted(messages, primary)
  }, consumeFailure)
}

/** Owns one bounded close waiter and a separate true native terminal barrier. */
function ownMessagesStop(
  messages: ConsumerMessages,
  closed: Promise<Error | null>,
  timeoutMs: number
): NatsJetStreamStopOperation {
  let ownerPublished = false
  let closeSettled = false
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

  /** Publishes terminal only after close and the official closed Promise settle. */
  const publishTerminal = (): void => {
    if (!closeSettled || !closedSettled) return
    publishOwner()
    resolveTerminal(combinedFailure(failures))
  }

  /** Requests native stop without claiming that terminal has happened. */
  const requestForce = (primary: Error): void => {
    admitFailure(primary)
    if (forceRequested) return
    forceRequested = true
    try {
      messages.stop()
    } catch (value) {
      admitFailure(normalizeError("stop", value))
    }
  }

  /** Applies the provider boundary and releases only the owner waiter. */
  const timedOut = (): void => {
    if (ownerPublished) return
    requestForce(newCloseTimeoutError(timeoutMs))
    publishOwner()
  }

  /** Records close completion, including failures that arrive after owner timeout. */
  const finishClose = (error: Error | null): void => {
    if (!ownerPublished && performance.now() >= deadline) timedOut()
    if (error !== null) requestForce(error)
    closeSettled = true
    publishTerminal()
  }

  closed.then((error) => {
    if (error !== null) admitFailure(error)
    closedSettled = true
    publishTerminal()
  })

  if (timeoutMs > 0) timeout = setTimeout(timedOut, timeoutMs)

  let close: Promise<void | Error>
  try {
    close = Promise.resolve(messages.close())
  } catch (value) {
    close = Promise.reject(normalizeError("close", value))
  }
  close.then(
    (value) => {
      finishClose(value instanceof Error ? value : null)
    },
    (value: unknown) => {
      finishClose(normalizeError("close", value))
    }
  )

  if (timeoutMs === 0 || performance.now() >= deadline) timedOut()
  return Object.freeze({ owner, terminal })
}

/** Creates a one-shot structural Server that owns only ConsumerMessages lifecycle. */
export function newNatsJetStreamServer(
  source: NatsJetStreamMessagesSource,
  ...options: readonly NatsJetStreamOption[] /* go-like-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): Server {
  const config: NatsJetStreamConfig = { closeTimeoutMs: 25_000 }
  for (const option of options) option(config)
  const factorySource = typeof source === "function"

  let state: NatsJetStreamServerState = "idle"
  let acceptedMessages: ConsumerMessages | null = null
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

  /** Starts or joins owner close after any in-flight acquisition completes. */
  const beginOwnerStop = (): Promise<void> => {
    if (ownerStop !== null) return ownerStop
    const starting = admission
    if (starting === null) return Promise.resolve()
    ownerStop = starting.then(() => {
      if (state === "failed" || state === "stopped") return donePromise
      const messages = acceptedMessages
      const closed = closedObservation
      if (messages === null || closed === null) return donePromise
      state = "stopping"
      const operation = ownMessagesStop(messages, closed, config.closeTimeoutMs)
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
    /** Acquires ConsumerMessages and remains pending for the full native runtime. */
    start(ctx: Context): Promise<void> {
      if (state !== "idle") return Promise.reject(newAlreadyStartedError(state))
      state = "starting"
      admission = (async (): Promise<void> => {
        let unacceptedFactoryMessages: ConsumerMessages | null = null
        let acquisition: Promise<ConsumerMessages> | null = null
        try {
          await waitForContext(ctx, Promise.resolve())
          acquisition = acquireMessages(source)
          let messages: ConsumerMessages
          try {
            messages = await waitForContext(ctx, acquisition)
            if (factorySource) unacceptedFactoryMessages = messages
          } catch (value) {
            if (factorySource) releaseLateMessages(acquisition, normalizeError("startup", value))
            throw value
          }
          await waitForContext(ctx, Promise.resolve())

          const closed = observeClosed(messages)
          acceptedMessages = messages
          closedObservation = closed
          state = "running"

          closed.then((error) => {
            if (state === "running") fail(newUnexpectedExitError(error))
          })
        } catch (value) {
          const primary = normalizeError("startup", value)
          const failure =
            unacceptedFactoryMessages === null
              ? primary
              : releaseUnaccepted(unacceptedFactoryMessages, primary)
          fail(failure)
          throw failure
        }
      })()
      void admission.catch(consumeFailure)
      const running = admission.then(() => donePromise)
      void running.catch(consumeFailure)
      return running
    },
    /** Starts native close while allowing only this caller to abandon its wait. */
    stop(stopContext: Context): Promise<void> {
      if (state === "idle") return Promise.resolve()
      return waitForContext(stopContext, beginOwnerStop())
    }
  })
}

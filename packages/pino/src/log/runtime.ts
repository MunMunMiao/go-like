import { cause, type Context, waitForContext } from "@go-like/core/context"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"
import { resourceFromContext } from "@go-like/core/telemetry/provider"
import { symbols, type Logger } from "pino"

import {
  combinePinoErrors,
  newPinoAlreadyStartedError,
  newPinoDestinationClosedError,
  newPinoDrainTimeoutError,
  normalizePinoError
} from "./errors"
import type { PinoHandlerConfig, PinoHandlerOption } from "./types"

/** Private drain budget. Adding a public export later is additive (D39). */
const defaultPinoDrainTimeoutMs = 25_000

/** Package-private seam for the one borrowed logger operation consumed by the runtime. */
interface LoggerFlushLifecycle {
  flush(callback?: (error?: Error) => void): void
  isLevelEnabled(level: string): boolean
  child(bindings: Record<string, unknown>): Logger
}

/** Package-private seam for native destination ownership and deterministic test doubles. */
interface DestinationLifecycle {
  end(): void
  destroy?(): void
  once(
    event: string,
    listener: (
      ...values: unknown[] /* go-like-typed-rest: preserves Pino DestinationStream's EventEmitter-compatible listener ABI. */
    ) => void
  ): this
  on(
    event: string,
    listener: (
      ...values: unknown[] /* go-like-typed-rest: preserves Pino DestinationStream's EventEmitter-compatible listener ABI. */
    ) => void
  ): this
  removeListener(
    event: string,
    listener: (
      ...values: unknown[] /* go-like-typed-rest: preserves Pino DestinationStream's EventEmitter-compatible listener ABI. */
    ) => void
  ): this
}

export type OfficialPinoDestination =
  | ReturnType<typeof import("pino").destination>
  | ReturnType<typeof import("pino").transport>

interface FileDestinationLifecycle extends DestinationLifecycle {
  /** Pino's file destination state set synchronously when end starts. */
  readonly _ending: boolean
  readonly destroyed: boolean
  readonly writable: boolean
  /** Immediately closes the Pino file destination. */
  destroy(): void
}

interface ThreadStreamLifecycle extends DestinationLifecycle {
  readonly destroyed: boolean
  readonly closed: boolean
  readonly writable: boolean
  readonly writableEnded: boolean
  readonly writableFinished: boolean
  readonly writableErrored: unknown
}

type OfficialDestinationLifecycle = FileDestinationLifecycle | ThreadStreamLifecycle

/** One captured destination force operation with its native receiver restored at invocation. */
type DestinationDestroyOperation = () => void

interface OwnerOperations {
  readonly loggerFlush: LoggerFlushLifecycle["flush"]
  readonly destinationEnd: DestinationLifecycle["end"]
  readonly destinationDestroy: DestinationDestroyOperation | null
}

type RuntimeState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

interface Deferred {
  readonly promise: Promise<void>
  /** Resolves this signal at most once. */
  resolve(): void
  /** Rejects this signal at most once. */
  reject(error: Error): void
}

interface DeferredCallbacks {
  resolve?: () => void
  reject?: (error: Error) => void
}

/** Creates one idempotent Promise settlement primitive. */
function deferred(): Deferred {
  const callbacks: DeferredCallbacks = {}
  const promise = new Promise<void>(
    /** Captures one Promise's settlement callbacks synchronously. */
    function capture(resolve, reject) {
      callbacks.resolve = resolve
      callbacks.reject = reject
    }
  )
  return Object.freeze({
    promise,
    /** Resolves this signal through the Promise's native idempotent settlement. */
    resolve(): void {
      callbacks.resolve?.()
    },
    /** Rejects this signal through the Promise's native idempotent settlement. */
    reject(error: Error): void {
      callbacks.reject?.(error)
    }
  })
}

/** Deliberately observes one internally retained rejection. */
function consumeFailure(_error: unknown): void {}

/** Returns the exact cancellation cause carried by one terminal Context. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  if (failure === null) return null
  return cause(ctx) ?? failure
}

/** Rejects before accepting work from an already canceled caller. */
function throwIfCanceled(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Reports whether one candidate exposes only the borrowed Logger lifecycle operation. */
function loggerLifecycle(logger: unknown): logger is LoggerFlushLifecycle {
  return (
    logger !== null &&
    typeof logger === "object" &&
    "flush" in logger &&
    typeof logger.flush === "function" &&
    "isLevelEnabled" in logger &&
    typeof logger.isLevelEnabled === "function" &&
    "child" in logger &&
    typeof logger.child === "function"
  )
}

/** Validates the official logger operation and its exact transferred stream identity. */
function requireLogger(logger: unknown, destination: DestinationLifecycle): LoggerFlushLifecycle {
  if (!loggerLifecycle(logger)) {
    throw new TypeError("Pino server requires an official Logger")
  }
  if (!(symbols.streamSym in logger) || logger[symbols.streamSym] !== destination) {
    throw new TypeError("Pino Logger must be bound to the transferred destination")
  }
  return logger
}

/** Requires the borrowed Logger to remain bound to the transferred destination. */
function requireLoggerBinding(logger: object, destination: DestinationLifecycle): void {
  if (!(symbols.streamSym in logger) || logger[symbols.streamSym] !== destination) {
    throw new TypeError("Pino Logger stream binding changed after ownership transfer")
  }
}

/** Reports whether one candidate exposes the transferred native lifecycle operations. */
function destinationLifecycle(destination: unknown): destination is DestinationLifecycle {
  return (
    destination !== null &&
    typeof destination === "object" &&
    "end" in destination &&
    typeof destination.end === "function" &&
    "once" in destination &&
    typeof destination.once === "function" &&
    "on" in destination &&
    typeof destination.on === "function" &&
    "removeListener" in destination &&
    typeof destination.removeListener === "function" &&
    (!("destroy" in destination) || typeof destination.destroy === "function")
  )
}

/** Recognizes Pino's structural file-destination lifecycle and terminal state surface. */
function fileDestinationLifecycle(
  destination: DestinationLifecycle
): destination is FileDestinationLifecycle {
  return (
    destination.destroy !== undefined &&
    "_ending" in destination &&
    typeof destination._ending === "boolean" &&
    "destroyed" in destination &&
    typeof destination.destroyed === "boolean" &&
    "writable" in destination &&
    typeof destination.writable === "boolean"
  )
}

/** Recognizes Pino's structural ThreadStream lifecycle and terminal state surface. */
function threadStreamLifecycle(
  destination: DestinationLifecycle
): destination is ThreadStreamLifecycle {
  return (
    destination.destroy === undefined &&
    "destroyed" in destination &&
    typeof destination.destroyed === "boolean" &&
    "closed" in destination &&
    typeof destination.closed === "boolean" &&
    "writable" in destination &&
    typeof destination.writable === "boolean" &&
    "writableEnded" in destination &&
    typeof destination.writableEnded === "boolean" &&
    "writableFinished" in destination &&
    typeof destination.writableFinished === "boolean" &&
    "writableErrored" in destination
  )
}

/** Validates the lifecycle and terminal state surfaces exposed by Pino destinations. */
function requireDestination(destination: unknown): OfficialDestinationLifecycle {
  if (
    !destinationLifecycle(destination) ||
    (!fileDestinationLifecycle(destination) && !threadStreamLifecycle(destination))
  ) {
    throw new TypeError("Pino server requires an official destination state and lifecycle")
  }
  return destination
}

/** Returns the exact native startup failure, or synthesizes a clean terminal rejection. */
function destinationStartupFailure(destination: OfficialDestinationLifecycle): Error | null {
  if (threadStreamLifecycle(destination)) {
    if (destination.writableErrored !== null) {
      return normalizePinoError(destination.writableErrored, "Pino transport startup")
    }
    if (
      destination.destroyed ||
      destination.closed ||
      !destination.writable ||
      destination.writableEnded ||
      destination.writableFinished
    ) {
      return newPinoDestinationClosedError()
    }
    return null
  }
  if (destination._ending || destination.destroyed || !destination.writable) {
    return newPinoDestinationClosedError()
  }
  return null
}

/** Captures the first stable owner operation set during synchronous construction. */
function snapshotOwnerOperations(
  logger: LoggerFlushLifecycle,
  destination: OfficialDestinationLifecycle
): OwnerOperations {
  const loggerFlush = logger.flush
  const destinationEnd = destination.end
  const destinationDestroy = destination.destroy ?? null
  const stableDestination = requireDestination(destination)
  const stableLogger = requireLogger(logger, stableDestination)
  if (
    stableLogger.flush !== loggerFlush ||
    stableDestination.end !== destinationEnd ||
    (stableDestination.destroy ?? null) !== destinationDestroy
  ) {
    throw new TypeError("Pino lifecycle methods changed during server construction")
  }
  return Object.freeze({ loggerFlush, destinationEnd, destinationDestroy })
}

/** Requires lifecycle operations to remain identical to the construction snapshot. */
function validateOwnerOperations(
  logger: LoggerFlushLifecycle,
  destination: OfficialDestinationLifecycle,
  operations: OwnerOperations
): void {
  if (
    logger.flush !== operations.loggerFlush ||
    destination.end !== operations.destinationEnd ||
    (destination.destroy ?? null) !== operations.destinationDestroy
  ) {
    throw new TypeError("Pino lifecycle methods changed during ownership admission")
  }
}

/** Configures the Pino destination drain boundary without configuring logging. */
export function pinoDrainTimeout(timeoutMs: number): PinoHandlerOption {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("pinoDrainTimeout must be an integer from 0 through 2147483647")
  }
  /** Applies the captured owner boundary to one private configuration. */
  function configure(config: PinoHandlerConfig): void {
    config.drainTimeoutMs = timeoutMs
  }
  return configure
}

/** Flushes the official Logger through its callback contract. */
function flushLogger(
  logger: LoggerFlushLifecycle,
  destination: DestinationLifecycle,
  operation: LoggerFlushLifecycle["flush"]
): Promise<void> {
  return new Promise<void>(
    /** Invokes the native Logger flush exactly once. */
    function waitForFlush(resolve, reject) {
      /** Settles from the native Pino callback once. */
      function flushed(error?: Error): void {
        if (error === undefined) resolve()
        else reject(error)
      }
      try {
        requireLoggerBinding(logger, destination)
        operation.call(logger, flushed)
      } catch (value) {
        reject(normalizePinoError(value, "Pino logger flush"))
      }
    }
  )
}

/** Constructs the destination lifecycle around an application-created Logger and destination. */
export function createPinoLifecycle(
  logger: Logger,
  destination: OfficialPinoDestination,
  options: readonly PinoHandlerOption[],
  adopt?: (logger: Logger) => void
): TelemetryLifecycle {
  const lifecycleDestination = requireDestination(destination)
  const lifecycleLogger = requireLogger(logger, lifecycleDestination)
  const constructionOperations = snapshotOwnerOperations(lifecycleLogger, lifecycleDestination)
  const config: PinoHandlerConfig = { drainTimeoutMs: defaultPinoDrainTimeoutMs }
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Pino server option must be a function")
    option(config)
  }

  let state: RuntimeState = "idle"
  let listenersInstalled = false
  let closeObserved = false
  let stopStarted = false
  let stopWaiterSettled = false
  let terminalSettled = false
  let timeoutAdmitted = false
  let forceInProgress = false
  let ownerStop: ((primary: Error | null) => Promise<void>) | null = null
  const closeSignal = deferred()
  const stopSignal = deferred()
  const terminalSignal = deferred()
  const failures: Error[] = []
  let terminalFailure: Error | null = null

  void stopSignal.promise.catch(consumeFailure)
  void terminalSignal.promise.catch(consumeFailure)

  /** Adds one distinct native or synthesized lifecycle failure in observation order. */
  function admitFailure(error: Error): void {
    if (!failures.includes(error)) failures.push(error)
  }

  /** Observes native destination failure and begins cleanup after ownership transfer. */
  function nativeError(value?: unknown): void {
    const error = normalizePinoError(value, "Pino destination")
    admitFailure(error)
    const stop = ownerStop
    if (stop !== null && !stopStarted) void stop(error).catch(consumeFailure)
  }

  /** Observes native close as clean only after the owner initiated shutdown. */
  function nativeClose(): void {
    closeObserved = true
    closeSignal.resolve()
    const stop = ownerStop
    if (stop !== null && !stopStarted) {
      void stop(newPinoDestinationClosedError()).catch(consumeFailure)
    } else if (stopStarted && timeoutAdmitted && !forceInProgress) {
      publishTerminal()
    }
  }

  /** Installs the two lifecycle listeners only at the ownership-transfer point. */
  function installListeners(): void {
    try {
      lifecycleDestination.on("error", nativeError)
      lifecycleDestination.once("close", nativeClose)
    } catch (value) {
      lifecycleDestination.removeListener("error", nativeError)
      lifecycleDestination.removeListener("close", nativeClose)
      throw value
    }
    listenersInstalled = true
  }

  /** Removes every adapter listener after terminal ownership has settled. */
  function removeListeners(): void {
    if (!listenersInstalled) return
    listenersInstalled = false
    lifecycleDestination.removeListener("error", nativeError)
    lifecycleDestination.removeListener("close", nativeClose)
  }

  /** Attempts the optional official force primitive only after the owner deadline wins. */
  function forceDestination(operations: OwnerOperations): void {
    if (operations.destinationDestroy === null) return
    try {
      operations.destinationDestroy.call(lifecycleDestination)
    } catch (value) {
      admitFailure(normalizePinoError(value, "Pino destination destroy"))
    }
  }

  /** Flushes, ends, and waits for native close while preserving every observed failure. */
  async function gracefulDrain(operations: OwnerOperations): Promise<void> {
    if (closeObserved) return
    try {
      await flushLogger(lifecycleLogger, lifecycleDestination, operations.loggerFlush)
    } catch (value) {
      admitFailure(normalizePinoError(value, "Pino logger flush"))
    }
    if (!closeObserved) {
      try {
        operations.destinationEnd.call(lifecycleDestination)
      } catch (value) {
        admitFailure(normalizePinoError(value, "Pino destination end"))
      }
    }
    if (!closeObserved) await closeSignal.promise
  }

  /** Settles the shared stop operation without claiming native terminal completion. */
  function settleStopWaiter(failure: Error | null): void {
    stopWaiterSettled = true
    if (failure === null) stopSignal.resolve()
    else stopSignal.reject(failure)
  }

  /** Publishes the stable terminal result only after native close was observed. */
  function publishTerminal(): Error | null {
    if (terminalSettled) return terminalFailure
    terminalSettled = true
    removeListeners()
    terminalFailure = combinePinoErrors(failures)
    if (terminalFailure === null) {
      state = "stopped"
      terminalSignal.resolve()
    } else {
      state = "failed"
      terminalSignal.reject(terminalFailure)
    }
    return terminalFailure
  }

  /** Runs graceful drain against one owner timer while retaining the native terminal observer. */
  function startOwnerDrain(admittedOperations: OwnerOperations): void {
    const startedAt = performance.now()
    /** Admits the owner timeout and invokes only an available official force primitive. */
    function drainTimedOut(): void {
      if (stopWaiterSettled || terminalSettled) return
      timeoutAdmitted = true
      admitFailure(
        newPinoDrainTimeoutError(
          config.drainTimeoutMs,
          admittedOperations.destinationDestroy !== null
        )
      )
      forceInProgress = true
      if (!closeObserved) forceDestination(admittedOperations)
      forceInProgress = false
      if (closeObserved) {
        settleStopWaiter(publishTerminal())
        return
      }
      settleStopWaiter(combinePinoErrors(failures))
    }
    const timeout = setTimeout(drainTimedOut, config.drainTimeoutMs)
    gracefulDrain(admittedOperations).then(
      /** Completes only if native work stayed inside the monotonic owner budget. */
      function drained(): void {
        clearTimeout(timeout)
        if (terminalSettled || stopWaiterSettled) return
        if (performance.now() - startedAt > config.drainTimeoutMs) {
          drainTimedOut()
          return
        }
        settleStopWaiter(publishTerminal())
      }
    )
  }

  /** Starts or joins the single adapter-owned destination shutdown operation. */
  function beginStop(primary: Error | null, operations: OwnerOperations): Promise<void> {
    if (primary !== null) admitFailure(primary)
    if (stopStarted) return stopSignal.promise
    stopStarted = true
    state = "stopping"
    startOwnerDrain(operations)
    return stopSignal.promise
  }

  return Object.freeze({
    /** Transfers ownership only when start accepts an active caller Context. */
    start(startupCtx: Context): Promise<void> {
      if (state !== "idle") return Promise.reject(newPinoAlreadyStartedError(state))
      state = "starting"
      try {
        throwIfCanceled(startupCtx)
        const startingDestination = requireDestination(lifecycleDestination)
        const startingLogger = requireLogger(lifecycleLogger, startingDestination)
        const preexistingFailure = destinationStartupFailure(startingDestination)
        if (preexistingFailure !== null) throw preexistingFailure
        validateOwnerOperations(startingLogger, startingDestination, constructionOperations)
        installListeners()
        const registrationFailure =
          failures[0] ?? (closeObserved ? newPinoDestinationClosedError() : null)
        if (registrationFailure !== null) throw registrationFailure
        const admittedDestination = requireDestination(lifecycleDestination)
        const admittedLogger = requireLogger(lifecycleLogger, admittedDestination)
        validateOwnerOperations(admittedLogger, admittedDestination, constructionOperations)
        const admissionFailure = destinationStartupFailure(admittedDestination)
        if (admissionFailure !== null) throw admissionFailure
        const capturedDestination = requireDestination(lifecycleDestination)
        const capturedLogger = requireLogger(lifecycleLogger, capturedDestination)
        validateOwnerOperations(capturedLogger, capturedDestination, constructionOperations)
        const captureStateFailure = destinationStartupFailure(capturedDestination)
        const captureFailure =
          failures[0] ?? (closeObserved ? newPinoDestinationClosedError() : captureStateFailure)
        if (captureFailure !== null) throw captureFailure
        /** Joins every native and caller stop path to the admitted operations. */
        function stopOwner(primary: Error | null): Promise<void> {
          return beginStop(primary, constructionOperations)
        }
        ownerStop = stopOwner
        state = "running"
        const resource = resourceFromContext(startupCtx)
        if (adopt !== undefined && Object.keys(resource).length > 0) {
          const bindings: Record<string, unknown> = {}
          for (const key of Object.keys(resource)) bindings[key] = resource[key]
          adopt(logger.child(bindings as never))
        }
        return terminalSignal.promise
      } catch (value) {
        state = "failed"
        removeListeners()
        const failure = normalizePinoError(value, "Pino destination startup")
        terminalSettled = true
        terminalFailure = failure
        terminalSignal.reject(failure)
        return terminalSignal.promise
      }
    },
    /** Requests the shared owner stop while scoping only this caller's wait. */
    stop(stopCtx: Context): Promise<void> {
      if (state === "idle") {
        try {
          installListeners()
          const registrationFailure =
            failures[0] ?? (closeObserved ? newPinoDestinationClosedError() : null)
          if (registrationFailure !== null) throw registrationFailure
          /** Joins every native and caller stop path to the admitted operations. */
          function stopBeforeStart(primary: Error | null): Promise<void> {
            return beginStop(primary, constructionOperations)
          }
          ownerStop = stopBeforeStart
          state = "running"
        } catch (value) {
          state = "failed"
          removeListeners()
          const failure = normalizePinoError(value, "Pino destination startup")
          terminalSettled = true
          terminalFailure = failure
          terminalSignal.reject(failure)
          return waitForContext(stopCtx, terminalSignal.promise)
        }
      }
      const stop = ownerStop
      if (stop === null) return waitForContext(stopCtx, terminalSignal.promise)
      return waitForContext(stopCtx, stop(null))
    }
  })
}

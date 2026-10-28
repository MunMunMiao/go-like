import { cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import type { Logger } from "winston"

import {
  combineWinstonErrors,
  newWinstonAlreadyStartedError,
  newWinstonLoggerClosedError,
  newWinstonLoggerFinishedError,
  normalizeWinstonError
} from "./errors"
import type { WinstonServer } from "./types"

type ServerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

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
    /** Delegates idempotent settlement to the native Promise resolver. */
    resolve(): void {
      callbacks.resolve?.()
    },
    /** Delegates idempotent settlement to the native Promise rejector. */
    reject(error: Error): void {
      callbacks.reject?.(error)
    }
  })
}

/** Deliberately observes one internally retained rejection. */
function consumeFailure(_value: unknown): void {}

/** Returns the exact failure carried by one already terminal Context. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  if (failure === null) return null
  return cause(ctx) ?? failure
}

/** Rejects before touching the application-owned logger for a canceled startup. */
function throwIfCanceled(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Validates only the official Winston lifecycle operations consumed here. */
function validateLogger(logger: Logger): void {
  if (
    logger === null ||
    typeof logger !== "object" ||
    typeof logger.end !== "function" ||
    typeof logger.once !== "function" ||
    typeof logger.on !== "function" ||
    typeof logger.removeListener !== "function"
  ) {
    throw new TypeError("Winston server requires an official Logger lifecycle")
  }
}

/** Constructs a one-shot Server around an application-created Winston Logger. */
export function newWinstonServer(logger: Logger): WinstonServer {
  validateLogger(logger)

  let state: ServerState = "idle"
  let transferred = false
  let errorListenerInstalled = false
  let finishListenerInstalled = false
  let closeListenerInstalled = false
  let finished = false
  let closed = false
  let terminalSettled = false
  let stopStarted = false
  let ownerStop: Promise<void> | null = null
  const nativeTerminalSignal = deferred()
  const terminalSignal = deferred()
  const failures: Error[] = []

  void terminalSignal.promise.catch(consumeFailure)

  /** Adds one distinct native or synthesized lifecycle failure in observation order. */
  function admitFailure(error: Error): void {
    if (!failures.includes(error)) failures.push(error)
  }

  /** Removes every listener installed by this adapter, including partial installation. */
  function removeNativeListeners(): void {
    if (errorListenerInstalled) {
      errorListenerInstalled = false
      logger.removeListener("error", nativeError)
    }
    if (finishListenerInstalled) {
      finishListenerInstalled = false
      logger.removeListener("finish", nativeFinish)
    }
    if (closeListenerInstalled) {
      closeListenerInstalled = false
      logger.removeListener("close", nativeClose)
    }
  }

  /** Publishes the stable terminal result exactly once after a real native terminal. */
  function publishTerminal(): void {
    terminalSettled = true
    removeNativeListeners()
    const failure = combineWinstonErrors(failures)
    if (failure === null) {
      state = "stopped"
      terminalSignal.resolve()
      return
    }
    state = "failed"
    terminalSignal.reject(failure)
  }

  /** Observes every native Winston logger error after listener installation. */
  function nativeError(value?: unknown): void {
    const error = normalizeWinstonError(value, "Winston logger error")
    admitFailure(error)
    if (transferred && !stopStarted) void beginStop(error).catch(consumeFailure)
  }

  /** Treats finish as clean only after go-like initiated logger.end(). */
  function nativeFinish(): void {
    if (finished) return
    finished = true
    if (state !== "stopping") admitFailure(newWinstonLoggerFinishedError())
    nativeTerminalSignal.resolve()
    if (!transferred) return
    removeNativeListeners()
    if (state === "running") publishTerminal()
  }

  /** Treats close before finish as a separate unexpected native terminal. */
  function nativeClose(): void {
    if (closed) return
    closed = true
    admitFailure(newWinstonLoggerClosedError())
    nativeTerminalSignal.resolve()
    if (!transferred) return
    removeNativeListeners()
    if (state === "running") publishTerminal()
  }

  /** Installs every lifecycle listener atomically at the ownership-transfer point. */
  function installNativeListeners(): void {
    try {
      errorListenerInstalled = true
      logger.on("error", nativeError)
      finishListenerInstalled = true
      logger.once("finish", nativeFinish)
      closeListenerInstalled = true
      logger.once("close", nativeClose)
    } catch (value) {
      removeNativeListeners()
      throw value
    }
  }

  /** Detects a logger that reached terminal state before lifecycle transfer. */
  function startupTerminalFailure(): Error | null {
    const observed = failures[0]
    if (observed !== undefined) return observed
    if (logger.closed === true) return newWinstonLoggerClosedError()
    if (logger.writableFinished === true) return newWinstonLoggerFinishedError()
    return null
  }

  /** Calls official writable end once and waits for an actual finish or close event. */
  async function drainLogger(): Promise<void> {
    try {
      logger.end()
    } catch (value) {
      admitFailure(normalizeWinstonError(value, "Winston logger end"))
    }
    if (!finished && !closed) await nativeTerminalSignal.promise
  }

  /** Starts or joins the one owner drain independently of caller cancellation. */
  function beginStop(primary: Error | null): Promise<void> {
    if (primary !== null) admitFailure(primary)
    if (terminalSettled || stopStarted) return terminalSignal.promise
    stopStarted = true
    state = "stopping"
    ownerStop = drainLogger().then(publishTerminal)
    void ownerStop.catch(consumeFailure)
    return terminalSignal.promise
  }

  return Object.freeze({
    /** Transfers lifecycle control only after cancellation checks and atomic listener install. */
    start(startupCtx: Context): Promise<void> {
      if (state !== "idle") return Promise.reject(newWinstonAlreadyStartedError(state))
      state = "starting"
      try {
        throwIfCanceled(startupCtx)
        const beforeInstall = startupTerminalFailure()
        if (beforeInstall !== null) throw beforeInstall
        installNativeListeners()
        const afterInstall = startupTerminalFailure()
        if (afterInstall !== null) throw afterInstall
      } catch (value) {
        removeNativeListeners()
        state = "failed"
        const failure = normalizeWinstonError(value, "Winston logger startup")
        terminalSettled = true
        terminalSignal.reject(failure)
        return Promise.reject(failure)
      }

      transferred = true
      state = "running"
      return terminalSignal.promise
    },
    /** Requests owner drain while limiting only this caller's wait. */
    stop(stopCtx: Context): Promise<void> {
      if (state === "idle") return Promise.resolve()
      return waitForContext(stopCtx, beginStop(null))
    }
  })
}

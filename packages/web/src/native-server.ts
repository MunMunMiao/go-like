import { canceled, cause, type Context } from "@go-like/context"
import type { Endpointer, Server } from "@go-like/core"
import { waitForContext } from "@go-like/core/lifecycle"
import type { Handler } from "@go-like/web"

import {
  newAlreadyStartedError,
  newForceCloseError,
  newUnexpectedCloseError,
  type NativeRuntimeTag
} from "./native-errors"
import {
  captureNativeOptions,
  defaultNativeOptions,
  type NativeServerOption,
  type NativeServerOptions
} from "./native-options"
import { normalizeError } from "./node-errors"

/** Synchronous bind result that connects one native runtime host to the shared lifecycle core. */
export interface NativeBinding {
  /** Actual bound TCP port, or undefined when the host reports none. */
  readonly port: number | undefined
  /** Counts requests currently executing application code. */
  activeRequests(): number
  /** Requests graceful drain; never terminal evidence. */
  drain(): void
  /** Requests immediate force; never terminal evidence. */
  force(): void
  /** Settles when the native host reaches its terminal state. */
  readonly closed: Promise<void>
}

/** Binds one native listener synchronously around the exact one-argument Fetch ABI. */
export type NativeBind = (
  handler: Handler,
  options: NativeServerOptions,
  report: (error: unknown) => void
) => NativeBinding

export interface NativeWebServer extends Server, Endpointer {
  /** Returns the stable HTTP publication discriminator. */
  protocol(): string

  /** Binds once and returns the actual HTTP endpoint used by App registration. */
  endpoint(ctx: Context): Promise<string>
}

type NativeServerStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

interface Startup {
  readonly admission: Promise<void>
  readonly running: Promise<void>
}

interface Runtime {
  readonly tag: NativeRuntimeTag<string>
  status: NativeServerStatus
  startClaimed: boolean
  startup: Startup | null
  binding: NativeBinding | null
  port: number
  terminalStarted: boolean
  forceStarted: boolean
  ownerDeadlineClaimed: boolean
  closeObserved: boolean
  terminalSettled: boolean
  donePromise: Promise<void>
  /** Resolves the stable terminal promise after the native host is terminal. */
  resolveDone(): void
  /** Rejects the stable terminal promise with the complete admitted failure ledger. */
  rejectDone(error: Error): void
  ownerDrain: Promise<void> | null
  ownerDeadline: number | null
  ownerTimeoutMs: number
  primaryFailure: Error | null
  cleanupFailures: Error[]
}

/** Maps a failed handler outcome to the empty-body status policy shared with the Node bridge. */
export function failureResponse(error: unknown): Response {
  const isTimeout =
    error instanceof Error &&
    (error.name === "TimeoutError" || error.constructor.name === "TimeoutError")
  return new Response(null, { status: isTimeout ? 504 : 500 })
}

/** Reads the Go-style cancellation cause while preserving custom failure identity. */
function canceledError(ctx: Context): Error {
  return cause(ctx) ?? ctx.err() ?? canceled
}

/** Reads Context cancellation without letting a failing Context replace the startup failure. */
function readCancellation(ctx: Context): unknown {
  try {
    return canceledError(ctx)
  } catch (value) {
    return value
  }
}

/** Reports whether the native host advertised a real bound TCP port. */
function isBoundPort(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/** Returns the actual HTTP endpoint after the native listener binds. */
function advertisedEndpoint(runtime: Runtime, config: NativeServerOptions): string {
  if (runtime.status !== "running") throw new Error(`${runtime.tag.id} web server is not bound`)
  const hostname =
    config.hostname.includes(":") && !config.hostname.startsWith("[")
      ? `[${config.hostname}]`
      : config.hostname
  return new URL(`http://${hostname}:${runtime.port}`).toString()
}

/** Observes the stable terminal promise so owner-independent failure is never unhandled. */
function observeDone(runtime: Runtime): void {
  void runtime.donePromise.catch(() => {})
}

/** Reports whether one Error identity already owns a primary or cleanup position. */
function failureAlreadyAdmitted(runtime: Runtime, error: Error): boolean {
  if (runtime.primaryFailure === error) return true
  return runtime.cleanupFailures.includes(error)
}

/** Admits exactly the first abnormal lifecycle cause as the primary terminal failure. */
function admitPrimaryFailure(runtime: Runtime, error: Error): void {
  if (runtime.primaryFailure !== null) return
  if (runtime.cleanupFailures.includes(error)) return
  runtime.primaryFailure = error
}

/** Admits one independent cleanup failure in observation order and by Error identity. */
function admitCleanupFailure(runtime: Runtime, value: unknown, message: string): void {
  if (runtime.terminalSettled) return
  const error = normalizeError(value, message)
  if (failureAlreadyAdmitted(runtime, error)) return
  runtime.cleanupFailures.push(error)
}

/** Builds the exact terminal failure while preserving primary and cleanup ordering. */
function terminalFailure(runtime: Runtime): Error | null {
  const failures: Error[] = []
  if (runtime.primaryFailure !== null) failures.push(runtime.primaryFailure)
  for (const failure of runtime.cleanupFailures) failures.push(failure)
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  return Object.freeze(
    new AggregateError(failures, `${runtime.tag.id} web server lifecycle failed`, {
      cause: first
    })
  )
}

/** Settles the stable terminal promise exactly once from the admitted failure ledger. */
function settleTerminal(runtime: Runtime): void {
  runtime.terminalSettled = true
  const failure = terminalFailure(runtime)
  if (failure === null) {
    runtime.status = "stopped"
    runtime.resolveDone()
  } else {
    runtime.status = "failed"
    runtime.rejectDone(failure)
  }
}

/** Checks the owner deadline against a monotonic clock after synchronous native work. */
function ownerDeadlineExpired(runtime: Runtime): boolean {
  return runtime.ownerDeadline !== null && performance.now() >= runtime.ownerDeadline
}

/** Settles only after the native host itself reports its terminal state. */
function maybeFinish(runtime: Runtime): void {
  if (runtime.terminalSettled || !runtime.terminalStarted) return
  if (!runtime.ownerDeadlineClaimed && ownerDeadlineExpired(runtime)) {
    forceAtOwnerDeadline(runtime)
    return
  }
  if (!runtime.closeObserved) return
  settleTerminal(runtime)
}

/** Requests the idempotent immediate-force sequence without claiming native terminal. */
function force(runtime: Runtime): void {
  if (runtime.terminalSettled) return
  if (!runtime.forceStarted) {
    runtime.forceStarted = true
    try {
      runtime.binding?.force()
    } catch (value) {
      admitCleanupFailure(runtime, value, `${runtime.tag.id} web force failed`)
    }
  }
  maybeFinish(runtime)
}

/** Admits the configured hard-timeout primary and requests force exactly once. */
function forceAtOwnerDeadline(runtime: Runtime): void {
  if (runtime.terminalSettled || runtime.ownerDeadlineClaimed) return
  runtime.ownerDeadlineClaimed = true
  const error = newForceCloseError(
    runtime.tag,
    runtime.ownerTimeoutMs,
    runtime.binding?.activeRequests() ?? 0
  )
  admitPrimaryFailure(runtime, error)
  force(runtime)
}

/** Starts terminal convergence once: requests graceful drain and optionally forces at once. */
function beginTerminal(runtime: Runtime, forceNow: boolean): Promise<void> {
  if (!runtime.terminalStarted) {
    runtime.terminalStarted = true
    runtime.status = runtime.primaryFailure === null ? "stopping" : "failed"
    const binding = runtime.binding
    if (binding === null) {
      runtime.closeObserved = true
    } else {
      try {
        binding.drain()
      } catch (value) {
        admitCleanupFailure(runtime, value, `${runtime.tag.id} web drain failed`)
        force(runtime)
      }
    }
  }
  if (forceNow) force(runtime)
  maybeFinish(runtime)
  return runtime.donePromise
}

/** Starts the owner-scoped graceful drain and hard force timer exactly once. */
function ownerDrain(runtime: Runtime, config: NativeServerOptions): Promise<void> {
  if (runtime.ownerDrain !== null) return runtime.ownerDrain
  runtime.ownerTimeoutMs = config.shutdownTimeoutMs
  runtime.ownerDeadline = performance.now() + config.shutdownTimeoutMs
  runtime.ownerDrain = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      forceAtOwnerDeadline(runtime)
    }, config.shutdownTimeoutMs)
    const terminal = beginTerminal(runtime, false)
    /** Resolves the owner drain after either stable terminal outcome. */
    const finishOwnerDrain = (): void => {
      clearTimeout(timeout)
      resolve()
    }
    void terminal.then(finishOwnerDrain, finishOwnerDrain)
  })
  return runtime.ownerDrain
}

/** Records native terminal evidence; an unrequested close is an unexpected terminal exit. */
function onNativeClosed(runtime: Runtime): void {
  if (!runtime.terminalStarted) {
    runtime.terminalStarted = true
    admitPrimaryFailure(runtime, newUnexpectedCloseError(runtime.tag))
  }
  runtime.closeObserved = true
  maybeFinish(runtime)
}

/** Records a rejected native terminal; it is the primary cause only when no owner drain began. */
function onNativeCloseFailed(runtime: Runtime, value: unknown): void {
  const message = `${runtime.tag.id} web server close failed`
  if (runtime.terminalStarted) {
    admitCleanupFailure(runtime, value, message)
  } else {
    runtime.terminalStarted = true
    admitPrimaryFailure(runtime, normalizeError(value, message))
  }
  runtime.closeObserved = true
  maybeFinish(runtime)
}

/** Creates isolated one-shot runtime state and its stable observed terminal promise. */
function makeRuntime(tag: NativeRuntimeTag<string>): Runtime {
  const settlement: {
    /** Resolves clean terminal convergence. */
    resolve?: () => void
    /** Rejects abnormal terminal convergence. */
    reject?: (error: Error) => void
  } = {}
  const donePromise = new Promise<void>((resolve, reject) => {
    settlement.resolve = resolve
    settlement.reject = reject
  })
  const runtime: Runtime = {
    tag,
    status: "idle",
    startClaimed: false,
    startup: null,
    binding: null,
    port: 0,
    terminalStarted: false,
    forceStarted: false,
    ownerDeadlineClaimed: false,
    closeObserved: false,
    terminalSettled: false,
    donePromise,
    /** Resolves clean terminal convergence. */
    resolveDone(): void {
      settlement.resolve?.()
    },
    /** Rejects abnormal terminal convergence. */
    rejectDone(error: Error): void {
      settlement.reject?.(error)
    },
    ownerDrain: null,
    ownerDeadline: null,
    ownerTimeoutMs: defaultNativeOptions.shutdownTimeoutMs,
    primaryFailure: null,
    cleanupFailures: []
  }
  observeDone(runtime)
  return runtime
}

/** Binds synchronously once and runs until the native host reaches its terminal state. */
function startServer(
  ctx: Context,
  runtime: Runtime,
  config: NativeServerOptions,
  handler: Handler,
  bind: NativeBind
): Startup {
  const admission = new Promise<void>((resolve, reject) => {
    /** Admits one startup failure and rejects admission after native cleanup converges. */
    const fail = (value: unknown, message: string): void => {
      admitPrimaryFailure(runtime, normalizeError(value, message))
      void beginTerminal(runtime, true).catch(reject)
    }

    let initialError: Error | null
    try {
      initialError = ctx.err()
    } catch (value) {
      fail(value, `${runtime.tag.id} web startup Context.err failed`)
      return
    }
    if (initialError !== null) {
      fail(readCancellation(ctx), `${runtime.tag.id} web startup canceled`)
      return
    }

    let binding: NativeBinding
    try {
      binding = bind(handler, config, (value: unknown): void => {
        admitCleanupFailure(runtime, value, `${runtime.tag.id} web host failed`)
      })
    } catch (value) {
      fail(value, `${runtime.tag.id} web server bind failed`)
      return
    }
    runtime.binding = binding
    void binding.closed.then(
      () => {
        onNativeClosed(runtime)
      },
      (value: unknown) => {
        onNativeCloseFailed(runtime, value)
      }
    )
    const boundPort = binding.port
    if (!isBoundPort(boundPort)) {
      fail(
        new Error(`${runtime.tag.id} web server did not report a bound TCP port`),
        `${runtime.tag.id} web server did not report a bound TCP port`
      )
      return
    }
    runtime.port = boundPort
    runtime.status = "running"
    resolve()
  })
  const running = admission.then(() => runtime.donePromise)
  void running.catch(() => {})
  return Object.freeze({ admission, running })
}

/** Constructs one managed server from already validated construction dependencies. */
function managedServer(
  tag: NativeRuntimeTag<string>,
  handler: Handler,
  bind: NativeBind,
  config: NativeServerOptions
): NativeWebServer {
  const runtime = makeRuntime(tag)

  /** Binds once for either endpoint discovery or application start. */
  function ensureStarted(ctx: Context): Startup {
    if (runtime.startup === null) runtime.startup = startServer(ctx, runtime, config, handler, bind)
    return runtime.startup
  }

  return Object.freeze({
    /** Returns the stable HTTP publication discriminator. */
    protocol(): string {
      return "http"
    },
    /** Claims the one-shot server and binds the native listener under the supplied Context. */
    start(ctx: Context): Promise<void> {
      if (runtime.startClaimed) {
        const status = runtime.status === "idle" ? "starting" : runtime.status
        return Promise.reject(newAlreadyStartedError(tag, status))
      }
      runtime.startClaimed = true
      return ensureStarted(ctx).running
    },
    /** Starts or joins the native graceful shutdown while limiting only this caller's wait. */
    stop(ctx: Context): Promise<void> {
      if (runtime.status === "idle") return Promise.resolve()
      if (runtime.terminalStarted) return waitForContext(ctx, runtime.donePromise)
      return waitForContext(ctx, ownerDrain(runtime, config))
    },
    /** Binds once and returns the actual HTTP endpoint used by App registration. */
    async endpoint(ctx: Context): Promise<string> {
      await waitForContext(ctx, ensureStarted(ctx).admission)
      return advertisedEndpoint(runtime, config)
    }
  })
}

/**
 * Constructs one managed native host server around a runtime-specific synchronous binder.
 *
 * @param tag - The runtime that owns the server.
 * @param handler - Standard Fetch handler owned by the application or HTTP framework.
 * @param bind - Runtime-specific synchronous listener binder.
 * @param options - Go-style hostname, port, and drain options.
 * @returns An immutable structural Core server.
 */
export function newNativeServer(
  tag: NativeRuntimeTag<string>,
  handler: Handler,
  bind: NativeBind,
  options: readonly NativeServerOption[]
): NativeWebServer {
  if (typeof handler !== "function") throw new TypeError("handler must be callable")
  return managedServer(tag, handler, bind, captureNativeOptions(tag.id, options))
}

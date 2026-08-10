import type { Socket } from "node:net"
import { afterFunc, canceled, cause, type Context, type StopFunc } from "@go-like/context"
import type { Endpointer, Server } from "@go-like/core"
import { waitForContext } from "@go-like/core/lifecycle"
import type { Handler } from "@go-like/web"

import {
  isError,
  newAlreadyStartedError,
  newForceCloseError,
  newUnexpectedCloseError,
  normalizeError,
  type NodeServerAlreadyStartedError,
  type NodeServerForceCloseError,
  type NodeServerUnexpectedCloseError
} from "./node-errors"
import { createAdaptorServer, type ServerType } from "./node-fetch-bridge"

export interface NodeServer extends Server, Endpointer {
  /** Binds once and returns the actual HTTP endpoint used by App registration. */
  endpoint(ctx: Context): Promise<string>
}

export type {
  NodeServerAlreadyStartedError,
  NodeServerForceCloseError,
  NodeServerUnexpectedCloseError
}

export interface NodeServerOptions {
  readonly hostname: string
  readonly port: number
  readonly shutdownTimeoutMs: number
}

/** Produces the next immutable Node host options snapshot. */
export type NodeServerOption = (options: NodeServerOptions) => NodeServerOptions

/** Creates one unlistened native server around the exact one-argument Fetch ABI. */
export type NativeFactory = (handler: Handler, hostname: string) => ServerType

type NodeServerStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

interface Runtime {
  status: NodeServerStatus
  startClaimed: boolean
  nativeServer: ServerType | null
  sockets: Set<Socket>
  terminalStarted: boolean
  forceStarted: boolean
  ownerDeadlineClaimed: boolean
  listenerAccepted: boolean
  closeObserved: boolean
  terminalSettled: boolean
  settlementHolds: number
  donePromise: Promise<void>
  admissionPromise: Promise<void> | null
  runningPromise: Promise<void> | null
  /** Resolves pending startup admission when clean stop wins the listen race. */
  settleStartupStop: (() => void) | null
  /** Resolves the stable terminal promise after every native barrier clears. */
  resolveDone(): void
  /** Rejects the stable terminal promise with the complete admitted failure ledger. */
  rejectDone(error: Error): void
  ownerDrain: Promise<void> | null
  ownerDeadline: number | null
  ownerTimeoutMs: number
  primaryFailure: Error | null
  cleanupFailures: Error[]
}

const DefaultConfig: NodeServerOptions = Object.freeze({
  hostname: "127.0.0.1",
  port: 0,
  shutdownTimeoutMs: 25_000
})
const maximumTimerDelayMs = 2_147_483_647

/** Validates and freezes one structural options snapshot returned by application code. */
function snapshotOptions(options: NodeServerOptions): NodeServerOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("node server options must be an object")
  }
  const capturedHostname = options.hostname
  const capturedPort = options.port
  const capturedTimeout = options.shutdownTimeoutMs
  if (typeof capturedHostname !== "string" || capturedHostname === "") {
    throw new TypeError("hostname must be a non-empty string")
  }
  if (!Number.isInteger(capturedPort) || capturedPort < 0 || capturedPort > 65_535) {
    throw new TypeError("port must be an integer in 0..65535")
  }
  if (
    !Number.isFinite(capturedTimeout) ||
    capturedTimeout < 0 ||
    capturedTimeout > maximumTimerDelayMs
  ) {
    throw new RangeError(`shutdownTimeoutMs must be finite and from 0 to ${maximumTimerDelayMs}`)
  }
  return Object.freeze({
    hostname: capturedHostname,
    port: capturedPort,
    shutdownTimeoutMs: capturedTimeout
  })
}

/**
 * Configures the TCP hostname captured by a Node Web server.
 *
 * @param value - Non-empty hostname passed to the native listener.
 * @returns A functional construction option.
 * @throws TypeError when the hostname is empty or not a string.
 */
export function hostname(value: string): NodeServerOption {
  if (typeof value !== "string" || value === "")
    throw new TypeError("hostname must be a non-empty string")
  /** Replaces only the hostname in one validated immutable snapshot. */
  function configureHostname(options: NodeServerOptions): NodeServerOptions {
    const current = snapshotOptions(options)
    return snapshotOptions({
      hostname: value,
      port: current.port,
      shutdownTimeoutMs: current.shutdownTimeoutMs
    })
  }
  return configureHostname
}

/**
 * Configures the TCP port captured by a Node Web server.
 *
 * @param value - Integer port in the inclusive range 0..65535.
 * @returns A functional construction option.
 * @throws TypeError when the port is outside the accepted range.
 */
export function port(value: number): NodeServerOption {
  if (!Number.isInteger(value) || value < 0 || value > 65_535)
    throw new TypeError("port must be an integer in 0..65535")
  /** Replaces only the port in one validated immutable snapshot. */
  function configurePort(options: NodeServerOptions): NodeServerOptions {
    const current = snapshotOptions(options)
    return snapshotOptions({
      hostname: current.hostname,
      port: value,
      shutdownTimeoutMs: current.shutdownTimeoutMs
    })
  }
  return configurePort
}

/**
 * Configures the maximum graceful-drain duration before lifecycle force begins.
 *
 * @param timeoutMs - Finite timeout from 0 through the portable Node timer maximum in milliseconds.
 * @returns A functional construction option.
 * @throws RangeError when the timeout is non-finite or outside the supported timer range.
 */
export function nodeShutdownTimeout(timeoutMs: number): NodeServerOption {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > maximumTimerDelayMs) {
    throw new RangeError(`nodeShutdownTimeout must be finite and from 0 to ${maximumTimerDelayMs}`)
  }
  /** Replaces only the native Node shutdown timeout in one validated immutable snapshot. */
  function configureNodeShutdownTimeout(options: NodeServerOptions): NodeServerOptions {
    const current = snapshotOptions(options)
    return snapshotOptions({
      hostname: current.hostname,
      port: current.port,
      shutdownTimeoutMs: timeoutMs
    })
  }
  return configureNodeShutdownTimeout
}

/**
 * Creates the upstream Node Web adaptor without starting its listener.
 * HTTP conversion, streaming, headers, and request cleanup remain upstream responsibilities.
 *
 * @param handler - Exact go-like one-argument Fetch handler.
 * @param host - Hostname used by the upstream request URL adapter.
 * @returns An unlistened native Node server.
 */
function createNativeServer(handler: Handler, host: string): ServerType {
  /** Delegates exactly one standard Request to application code. */
  function fetch(request: Request): Response | Promise<Response> {
    return handler(request)
  }
  return createAdaptorServer({ fetch, hostname: host })
}

/** Reads the Go-style cancellation cause while preserving custom failure identity. */
function canceledError(ctx: Context): Error {
  return cause(ctx) ?? ctx.err() ?? canceled
}

/** Verifies that native listen admitted a TCP address. */
function assertTcpAddress(nativeServer: ServerType): void {
  const address = nativeServer.address()
  if (address === null || typeof address === "string")
    throw new Error("node web server address is not a TCP address")
}

/** Returns the actual HTTP endpoint after the native listener binds. */
function advertisedEndpoint(runtime: Runtime, config: NodeServerOptions): string {
  const nativeServer = runtime.nativeServer
  if (nativeServer === null) throw new Error("node web server is not bound")
  const address = nativeServer.address()
  if (address === null || typeof address === "string")
    throw new Error("node web server address is not a TCP address")
  const hostname =
    config.hostname.includes(":") && !config.hostname.startsWith("[")
      ? `[${config.hostname}]`
      : config.hostname
  return new URL(`http://${hostname}:${address.port}`).toString()
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
    new AggregateError(failures, "node web server lifecycle failed", {
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

/** Settles only after the native listener and every admitted socket report terminal. */
function maybeFinish(runtime: Runtime): void {
  if (runtime.terminalSettled || runtime.settlementHolds > 0 || !runtime.terminalStarted) return
  if (!runtime.ownerDeadlineClaimed && ownerDeadlineExpired(runtime)) {
    forceAtOwnerDeadline(runtime)
    return
  }
  if (!runtime.closeObserved || runtime.sockets.size > 0) return
  settleTerminal(runtime)
}

/** Calls the HTTP/1 force primitive when the upstream factory returned one. */
function closeAllConnections(nativeServer: ServerType): void {
  if (
    !("closeAllConnections" in nativeServer) ||
    typeof nativeServer.closeAllConnections !== "function"
  )
    return
  nativeServer.closeAllConnections()
}

/** Requests the idempotent immediate-force sequence without claiming native terminal. */
function force(runtime: Runtime): void {
  if (runtime.terminalSettled) return
  if (!runtime.forceStarted) {
    runtime.forceStarted = true
    runtime.settlementHolds += 1
    try {
      const nativeServer = runtime.nativeServer
      if (nativeServer !== null) {
        try {
          closeAllConnections(nativeServer)
        } catch (value) {
          admitCleanupFailure(runtime, value, "node web closeAllConnections failed")
        }
      }
      for (const socket of runtime.sockets) {
        try {
          socket.destroy()
        } catch (value) {
          admitCleanupFailure(runtime, value, "node web socket destroy failed")
        }
      }
    } finally {
      runtime.settlementHolds -= 1
    }
  }
  maybeFinish(runtime)
}

/** Admits the configured hard-timeout primary and requests force exactly once. */
function forceAtOwnerDeadline(runtime: Runtime): void {
  if (runtime.terminalSettled || runtime.ownerDeadlineClaimed) return
  runtime.ownerDeadlineClaimed = true
  const error = newForceCloseError(runtime.ownerTimeoutMs, runtime.sockets.size)
  admitPrimaryFailure(runtime, error)
  force(runtime)
}

/** Admits terminal convergence and optionally forces every tracked connection. */
function admitTerminal(
  runtime: Runtime,
  causeError: Error | null,
  forceNow: boolean
): Promise<void> {
  if (causeError !== null) admitPrimaryFailure(runtime, causeError)
  if (!runtime.terminalStarted) {
    const cleanStartupStop = runtime.status === "starting" && causeError === null
    runtime.terminalStarted = true
    runtime.status = runtime.primaryFailure === null ? "stopping" : "failed"
    runtime.settlementHolds += 1
    try {
      if (cleanStartupStop) runtime.settleStartupStop?.()
      const nativeServer = runtime.nativeServer
      if (nativeServer === null || runtime.closeObserved) {
        runtime.closeObserved = true
      } else {
        try {
          nativeServer.close((value?: Error) => {
            if (value !== undefined) {
              admitCleanupFailure(runtime, value, "node web close failed")
              if (!runtime.listenerAccepted && runtime.sockets.size === 0)
                runtime.closeObserved = true
              force(runtime)
            } else {
              runtime.closeObserved = true
            }
            maybeFinish(runtime)
          })
        } catch (value) {
          admitCleanupFailure(runtime, value, "node web close failed")
          if (!runtime.listenerAccepted && runtime.sockets.size === 0) runtime.closeObserved = true
          force(runtime)
        }
      }
    } finally {
      runtime.settlementHolds -= 1
    }
  }
  if (forceNow) force(runtime)
  maybeFinish(runtime)
  return runtime.donePromise
}

/** Starts the owner-scoped graceful drain and hard force timer exactly once. */
function ownerDrain(runtime: Runtime, config: NodeServerOptions): Promise<void> {
  if (runtime.ownerDrain !== null) return runtime.ownerDrain
  runtime.ownerTimeoutMs = config.shutdownTimeoutMs
  runtime.ownerDeadline = performance.now() + config.shutdownTimeoutMs
  runtime.ownerDrain = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      forceAtOwnerDeadline(runtime)
    }, config.shutdownTimeoutMs)
    runtime.settlementHolds += 1
    const terminal = admitTerminal(runtime, null, false)
    runtime.settlementHolds -= 1
    if (ownerDeadlineExpired(runtime)) forceAtOwnerDeadline(runtime)
    else maybeFinish(runtime)
    /** Resolves the owner drain after either stable terminal outcome. */
    const finishOwnerDrain = (): void => {
      clearTimeout(timeout)
      resolve()
    }
    void terminal.then(finishOwnerDrain, finishOwnerDrain)
  })
  return runtime.ownerDrain
}

/** Creates isolated one-shot runtime state and its stable observed terminal promise. */
function makeRuntime(): Runtime {
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
    status: "idle",
    startClaimed: false,
    nativeServer: null,
    sockets: new Set(),
    terminalStarted: false,
    forceStarted: false,
    ownerDeadlineClaimed: false,
    listenerAccepted: false,
    closeObserved: false,
    terminalSettled: false,
    settlementHolds: 0,
    donePromise,
    admissionPromise: null,
    runningPromise: null,
    settleStartupStop: null,
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
    ownerTimeoutMs: DefaultConfig.shutdownTimeoutMs,
    primaryFailure: null,
    cleanupFailures: []
  }
  observeDone(runtime)
  return runtime
}

/** Claims startup once and runs until the native listener reaches terminal state. */
function startServer(
  ctx: Context,
  runtime: Runtime,
  config: NodeServerOptions,
  handler: Handler,
  factory: NativeFactory
): Promise<void> {
  runtime.status = "starting"
  const admission = new Promise<void>((resolve, reject) => {
    const aborter = new AbortController()
    let stop: StopFunc | null = null
    let stopClaimed = false
    let startupFailed = false

    /** Claims and invokes startup cancellation cleanup at most once. */
    const stopStartup = (): boolean => {
      if (stop === null || stopClaimed) return false
      stopClaimed = true
      return stop()
    }
    /** Releases cancellation registration without replacing an admitted failure. */
    const stopStartupWithoutReplacingCause = (): void => {
      try {
        stopStartup()
      } catch {
        // Startup failure already owns public rejection identity.
      }
    }
    /** Reads or normalizes Context cancellation without throwing into native callbacks. */
    const readCancellationError = (): Error => {
      try {
        const value: unknown = canceledError(ctx)
        return isError(value)
          ? value
          : normalizeError(value, "node web startup canceled with a non-Error value")
      } catch (value) {
        return normalizeError(value, "node web startup cancellation lookup failed")
      }
    }
    /** Admits one startup failure and rejects after native cleanup converges. */
    const fail = (value: unknown, message: string): void => {
      if (startupFailed || runtime.status !== "starting") return
      startupFailed = true
      const error = normalizeError(value, message)
      runtime.status = "failed"
      runtime.settleStartupStop = null
      aborter.signal.removeEventListener("abort", onStartupAbort)
      stopStartupWithoutReplacingCause()
      const terminal = admitTerminal(runtime, error, true)
      void terminal.catch(reject)
    }
    /** Converts startup AbortSignal cancellation into the one-shot failure path. */
    const onStartupAbort = (): void => {
      fail(readCancellationError(), "node web startup cancellation failed")
    }
    aborter.signal.addEventListener("abort", onStartupAbort, { once: true })
    runtime.settleStartupStop = () => {
      runtime.settleStartupStop = null
      aborter.signal.removeEventListener("abort", onStartupAbort)
      try {
        if (stop !== null && !stopStartup()) {
          admitPrimaryFailure(runtime, readCancellationError())
        }
      } catch (value) {
        admitCleanupFailure(runtime, value, "node web startup cancellation StopFunc failed")
      }
      resolve()
    }

    let initialError: Error | null
    try {
      initialError = ctx.err()
    } catch (value) {
      fail(value, "node web startup Context.err failed")
      return
    }
    if (initialError !== null) {
      fail(readCancellationError(), "node web startup canceled")
      return
    }

    try {
      stop = afterFunc(ctx, () => {
        const error = readCancellationError()
        aborter.abort(error)
      })
    } catch (value) {
      fail(value, "node web startup cancellation registration failed")
      return
    }

    /** Delegates exactly one standard Request to the captured application handler. */
    function fetch(request: Request): Response | Promise<Response> {
      return handler(request)
    }

    let nativeServer: ServerType
    try {
      nativeServer = factory(fetch, config.hostname)
      runtime.nativeServer = nativeServer
    } catch (value) {
      fail(value, "node web native server factory failed")
      return
    }

    try {
      nativeServer.on("connection", (socket: Socket) => {
        runtime.sockets.add(socket)
        socket.on("close", () => {
          runtime.sockets.delete(socket)
          maybeFinish(runtime)
        })
        if (runtime.forceStarted) {
          try {
            socket.destroy()
          } catch (value) {
            admitCleanupFailure(runtime, value, "node web socket destroy failed")
          }
        }
      })
      nativeServer.on("error", (value: Error) => {
        if (runtime.status === "starting") {
          fail(value, "node web listen failed")
        } else if (runtime.status === "running" || runtime.status === "stopping") {
          void admitTerminal(runtime, value, true)
        }
      })
      nativeServer.on("close", () => {
        runtime.closeObserved = true
        if (runtime.status === "starting") {
          fail(
            new Error("node web server closed during startup"),
            "node web server closed during startup"
          )
        } else if (!runtime.terminalStarted) {
          void admitTerminal(runtime, newUnexpectedCloseError(), true)
        }
        maybeFinish(runtime)
      })
      nativeServer.listen(
        {
          host: config.hostname,
          port: config.port,
          signal: aborter.signal
        },
        () => {
          if (startupFailed || runtime.status !== "starting" || aborter.signal.aborted) return
          runtime.listenerAccepted = true
          try {
            assertTcpAddress(nativeServer)
          } catch (value) {
            fail(value, "node web server address is unavailable")
            return
          }
          let stopped: boolean
          try {
            stopped = stopStartup()
          } catch (value) {
            fail(value, "node web startup cancellation StopFunc failed")
            return
          }
          if (!stopped) {
            fail(readCancellationError(), "node web startup cancellation won the listen race")
            return
          }
          runtime.settleStartupStop = null
          aborter.signal.removeEventListener("abort", onStartupAbort)
          runtime.status = "running"
          resolve()
        }
      )
    } catch (value) {
      fail(value, "node web listen failed")
    }
  })
  const running = admission.then(() => runtime.donePromise)
  void running.catch(() => {})
  runtime.admissionPromise = admission
  runtime.runningPromise = running
  return running
}

/** Captures and validates functional options into private immutable configuration. */
function captureConfig(options: readonly NodeServerOption[]): NodeServerOptions {
  let config = DefaultConfig
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("node server option must be callable")
    config = snapshotOptions(option(config))
  }
  return config
}

/** Constructs one managed server from already validated construction dependencies. */
function managedServer(
  handler: Handler,
  factory: NativeFactory,
  config: NodeServerOptions
): NodeServer {
  const runtime = makeRuntime()

  /** Starts the native listener once for either endpoint discovery or application start. */
  function ensureStarted(ctx: Context): Promise<void> {
    if (runtime.runningPromise === null) return startServer(ctx, runtime, config, handler, factory)
    return runtime.runningPromise
  }

  return Object.freeze({
    /** Claims the one-shot server and starts native listen under the supplied Context. */
    start(ctx: Context): Promise<void> {
      if (runtime.startClaimed) {
        const status = runtime.status === "idle" ? "starting" : runtime.status
        return Promise.reject(newAlreadyStartedError(status))
      }
      runtime.startClaimed = true
      return ensureStarted(ctx)
    },
    /** Starts or joins the native graceful shutdown while limiting only this caller's wait. */
    stop(ctx: Context): Promise<void> {
      if (runtime.status === "idle") return Promise.resolve()
      if (runtime.terminalStarted) return waitForContext(ctx, runtime.donePromise)
      return waitForContext(ctx, ownerDrain(runtime, config))
    },
    /** Binds once and returns the actual HTTP endpoint used by App registration. */
    async endpoint(ctx: Context): Promise<string> {
      ensureStarted(ctx)
      const admission = runtime.admissionPromise
      if (admission === null) throw new Error("node web server admission is unavailable")
      await waitForContext(ctx, admission)
      return advertisedEndpoint(runtime, config)
    }
  })
}

/**
 * Constructs a one-shot managed Node host for a standard one-argument Fetch handler.
 *
 * @param handler - Standard Fetch handler owned by the application or HTTP framework.
 * @param options - Go-style hostname, port, and drain options.
 * @returns An immutable structural Core server.
 */
export function newNodeServer(
  handler: Handler,
  ...options: readonly NodeServerOption[] // Go-style functional options require this single variadic construction boundary.
): NodeServer {
  if (typeof handler !== "function") throw new TypeError("handler must be callable")
  return managedServer(handler, createNativeServer, captureConfig(options))
}

/**
 * Constructs the same managed server with only its unlistened native factory replaced for tests.
 *
 * @param handler - Standard Fetch handler.
 * @param factory - Native host factory injected by package-internal tests.
 * @param options - The same Go-style lifecycle options as the public constructor.
 * @returns An immutable structural Core server.
 */
export function newNodeServerWithFactory(
  handler: Handler,
  factory: NativeFactory,
  ...options: readonly NodeServerOption[] // Go-style functional options require this single variadic construction boundary.
): NodeServer {
  if (typeof handler !== "function") throw new TypeError("handler must be callable")
  if (typeof factory !== "function") throw new TypeError("native factory must be callable")
  return managedServer(handler, factory, captureConfig(options))
}

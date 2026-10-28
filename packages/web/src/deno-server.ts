import type { Handler } from "@go-like/web"

import type {
  NativeRuntimeTag,
  NativeServerAlreadyStartedError,
  NativeServerForceCloseError,
  NativeServerUnexpectedCloseError
} from "./native-errors"
import {
  nativeHostname,
  nativePort,
  nativeShutdownTimeout,
  type NativeServerOption,
  type NativeServerOptions
} from "./native-options"
import {
  failureResponse,
  newNativeServer,
  type NativeBind,
  type NativeBinding,
  type NativeWebServer
} from "./native-server"

export type DenoServer = NativeWebServer

export type DenoServerOptions = NativeServerOptions

/** Produces the next immutable Deno host options snapshot. */
export type DenoServerOption = NativeServerOption

export type DenoServerAlreadyStartedError = NativeServerAlreadyStartedError<"deno">

export type DenoServerForceCloseError = NativeServerForceCloseError<"deno">

export type DenoServerUnexpectedCloseError = NativeServerUnexpectedCloseError<"deno">

/** Minimal structural view of the per-request info Deno passes to a serve handler. */
export interface DenoServeInfo {
  readonly completed: Promise<void>
}

/** Minimal structural view of the Deno.serve options this adapter passes. */
export interface DenoServeOptions {
  readonly hostname: string
  readonly port: number
  readonly signal: AbortSignal
  onListen(): void
  onError(error: unknown): Response
}

/** Minimal structural view of the Deno HTTP server members this adapter uses. */
export interface DenoServerHandle {
  readonly addr: unknown
  readonly finished: Promise<void>
  shutdown(): Promise<void>
}

/** Minimal structural view of the Deno global so published declarations need no Deno types. */
export interface DenoRuntime {
  serve(
    options: DenoServeOptions,
    handler: (request: Request, info: DenoServeInfo) => Response | Promise<Response>
  ): DenoServerHandle
}

const denoTag: NativeRuntimeTag<"deno"> = Object.freeze({
  id: "deno",
  name: "Deno",
  code: "DENO"
})

/**
 * Configures the TCP hostname captured by a Deno Web server.
 *
 * @param value - Non-empty hostname passed to the native listener.
 * @returns A functional construction option.
 * @throws TypeError when the hostname is empty or not a string.
 */
export function hostname(value: string): DenoServerOption {
  return nativeHostname("deno", value)
}

/**
 * Configures the TCP port captured by a Deno Web server.
 *
 * @param value - Integer port in the inclusive range 0..65535.
 * @returns A functional construction option.
 * @throws TypeError when the port is outside the accepted range.
 */
export function port(value: number): DenoServerOption {
  return nativePort("deno", value)
}

/**
 * Configures the maximum graceful-drain duration before lifecycle force begins.
 *
 * @param timeoutMs - Finite timeout from 0 through the portable timer maximum in milliseconds.
 * @returns A functional construction option.
 * @throws RangeError when the timeout is non-finite or outside the supported timer range.
 */
export function denoShutdownTimeout(timeoutMs: number): DenoServerOption {
  return nativeShutdownTimeout("deno", timeoutMs)
}

/** Narrows an unknown global to the minimal Deno runtime shape this adapter uses. */
function isDenoRuntime(value: unknown): value is DenoRuntime {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "serve") === "function"
  )
}

/**
 * Accepts only a Deno-shaped runtime object.
 *
 * @param candidate - Value read from the Deno global.
 * @returns The same object narrowed to the structural Deno runtime.
 * @throws Error when the candidate does not provide Deno.serve.
 */
export function denoRuntimeFrom(candidate: unknown): DenoRuntime {
  if (!isDenoRuntime(candidate)) throw new Error("@go-like/web/deno requires the Deno runtime")
  return candidate
}

/** Reads the TCP port from the address Deno reports, or undefined for any other address. */
function boundPort(addr: unknown): number | undefined {
  if (typeof addr !== "object" || addr === null) return undefined
  const value: unknown = Reflect.get(addr, "port")
  return typeof value === "number" ? value : undefined
}

/** Creates the synchronous Deno.serve binder around one runtime-owned serve function. */
function denoBinder(runtime: DenoRuntime): NativeBind {
  /** Binds one Deno.serve listener around the exact one-argument Fetch ABI. */
  function bind(
    handler: Handler,
    options: NativeServerOptions,
    report: (error: unknown) => void
  ): NativeBinding {
    const controller = new AbortController()
    let activeRequests = 0
    let draining = false
    let shutdownCalled = false

    /** Starts Deno's graceful shutdown once; it can no longer be forced with abort. */
    function shutdown(): void {
      try {
        const stopped = server.shutdown()
        shutdownCalled = true
        void stopped.catch(report)
      } catch (value) {
        report(value)
      }
    }

    /** Releases one finished request and completes the drain when the last one is gone. */
    function release(): void {
      activeRequests -= 1
      if (!draining || activeRequests > 0) return
      shutdown()
    }

    /** Delegates exactly one standard Request to application code unless the drain began. */
    function fetch(request: Request, info: DenoServeInfo): Response | Promise<Response> {
      if (draining) return new Response(null, { status: 503, headers: { connection: "close" } })
      activeRequests += 1
      void info.completed.then(release, release)
      return handler(request)
    }

    const server = runtime.serve(
      {
        hostname: options.hostname,
        port: options.port,
        signal: controller.signal,
        onListen(): void {},
        onError: failureResponse
      },
      fetch
    )

    return Object.freeze({
      port: boundPort(server.addr),
      closed: server.finished,
      /** Counts requests whose response Deno has not completed. */
      activeRequests(): number {
        return activeRequests
      },
      /** Refuses new requests and shuts down once the last in-flight request completes. */
      drain(): void {
        draining = true
        if (activeRequests === 0) shutdown()
      },
      /** Aborts the server only while a graceful shutdown has not started. */
      force(): void {
        if (!shutdownCalled) controller.abort()
      }
    })
  }
  return bind
}

/**
 * Constructs the same managed Deno server with only its runtime object replaced for tests.
 *
 * @param handler - Standard Fetch handler.
 * @param runtime - Structural Deno runtime injected by package-internal tests.
 * @param options - The same Go-style lifecycle options as the public constructor.
 * @returns An immutable structural Core server.
 */
export function newDenoServerWithRuntime(
  handler: Handler,
  runtime: DenoRuntime,
  ...options: readonly DenoServerOption[] // Go-style functional options require this single variadic construction boundary.
): DenoServer {
  return newNativeServer(denoTag, handler, denoBinder(runtime), options)
}

/**
 * Constructs a one-shot managed Deno host for a standard one-argument Fetch handler.
 *
 * @param handler - Standard Fetch handler owned by the application or HTTP framework.
 * @param options - Go-style hostname, port, and drain options.
 * @returns An immutable structural Core server.
 * @throws Error when the Deno runtime is unavailable.
 */
export function newDenoServer(
  handler: Handler,
  ...options: readonly DenoServerOption[] // Go-style functional options require this single variadic construction boundary.
): DenoServer {
  return newDenoServerWithRuntime(
    handler,
    denoRuntimeFrom(Reflect.get(globalThis, "Deno")),
    ...options
  )
}

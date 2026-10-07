import type { Handler } from "@go-like/web"

import type {
  NativeRuntimeTag,
  NativeServerAlreadyStartedError,
  NativeServerForceCloseError
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

export type BunServer = NativeWebServer

export type BunServerOptions = NativeServerOptions

/** Produces the next immutable Bun host options snapshot. */
export type BunServerOption = NativeServerOption

export type BunServerAlreadyStartedError = NativeServerAlreadyStartedError<"bun">

export type BunServerForceCloseError = NativeServerForceCloseError<"bun">

/** Minimal structural view of the Bun.serve options this adapter passes. */
export interface BunServeOptions {
  readonly hostname: string
  readonly port: number
  readonly reusePort: boolean
  readonly development: boolean
  readonly id: null
  fetch(request: Request): Response | Promise<Response>
  error(error: unknown): Response
}

/** Minimal structural view of the Bun server members this adapter uses. */
export interface BunServerHandle {
  readonly port: number | undefined
  readonly pendingRequests: number
  stop(closeActiveConnections?: boolean): Promise<void>
}

/** Minimal structural view of the Bun global so published declarations need no Bun types. */
export interface BunRuntime {
  serve(options: BunServeOptions): BunServerHandle
}

const bunTag: NativeRuntimeTag<"bun"> = Object.freeze({ id: "bun", name: "Bun", code: "BUN" })

/**
 * Configures the TCP hostname captured by a Bun Web server.
 *
 * @param value - Non-empty hostname passed to the native listener.
 * @returns A functional construction option.
 * @throws TypeError when the hostname is empty or not a string.
 */
export function hostname(value: string): BunServerOption {
  return nativeHostname("bun", value)
}

/**
 * Configures the TCP port captured by a Bun Web server.
 *
 * @param value - Integer port in the inclusive range 0..65535.
 * @returns A functional construction option.
 * @throws TypeError when the port is outside the accepted range.
 */
export function port(value: number): BunServerOption {
  return nativePort("bun", value)
}

/**
 * Configures the maximum graceful-drain duration before lifecycle force begins.
 *
 * @param timeoutMs - Finite timeout from 0 through the portable timer maximum in milliseconds.
 * @returns A functional construction option.
 * @throws RangeError when the timeout is non-finite or outside the supported timer range.
 */
export function bunShutdownTimeout(timeoutMs: number): BunServerOption {
  return nativeShutdownTimeout("bun", timeoutMs)
}

/** Narrows an unknown global to the minimal Bun runtime shape this adapter uses. */
function isBunRuntime(value: unknown): value is BunRuntime {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "serve") === "function"
  )
}

/**
 * Accepts only a Bun-shaped runtime object.
 *
 * @param candidate - Value read from the Bun global.
 * @returns The same object narrowed to the structural Bun runtime.
 * @throws Error when the candidate does not provide Bun.serve.
 */
export function bunRuntimeFrom(candidate: unknown): BunRuntime {
  if (!isBunRuntime(candidate)) throw new Error("@go-like/web/bun requires the Bun runtime")
  return candidate
}

/** Requires the Fetch handler contract because Bun would answer a non-Response with an empty 204. */
function requireResponse(value: unknown): Response {
  if (value instanceof Response) return value
  throw new TypeError("handler must return a Response")
}

/** Creates the synchronous Bun.serve binder around one runtime-owned serve function. */
function bunBinder(runtime: BunRuntime): NativeBind {
  /** Binds one Bun.serve listener around the exact one-argument Fetch ABI. */
  function bind(handler: Handler, options: NativeServerOptions): NativeBinding {
    /** Delegates exactly one standard Request to application code. */
    function fetch(request: Request): Response | Promise<Response> {
      if (!URL.canParse(request.url)) return new Response(null, { status: 400 })
      const result = handler(request)
      if (result instanceof Response) return result
      return Promise.resolve(result).then(requireResponse)
    }

    const server = runtime.serve({
      hostname: options.hostname,
      port: options.port,
      reusePort: false,
      development: false,
      id: null,
      fetch,
      error: failureResponse
    })
    const closed = Promise.withResolvers<void>()

    /** Requests one Bun stop; its promise is the only terminal evidence. */
    function stop(closeActiveConnections: boolean): void {
      void server.stop(closeActiveConnections).then(closed.resolve, closed.reject)
    }

    return Object.freeze({
      port: server.port,
      closed: closed.promise,
      /** Counts requests Bun still considers pending. */
      activeRequests(): number {
        return server.pendingRequests
      },
      /** Refuses new connections and waits for in-flight requests. */
      drain(): void {
        stop(false)
      },
      /** Escalates the same Bun stop to closing active connections. */
      force(): void {
        stop(true)
      }
    })
  }
  return bind
}

/**
 * Constructs the same managed Bun server with only its runtime object replaced for tests.
 *
 * @param handler - Standard Fetch handler.
 * @param runtime - Structural Bun runtime injected by package-internal tests.
 * @param options - The same Go-style lifecycle options as the public constructor.
 * @returns An immutable structural Core server.
 */
export function newBunServerWithRuntime(
  handler: Handler,
  runtime: BunRuntime,
  ...options: readonly BunServerOption[] // Go-style functional options require this single variadic construction boundary.
): BunServer {
  return newNativeServer(bunTag, handler, bunBinder(runtime), options)
}

/**
 * Constructs a one-shot managed Bun host for a standard one-argument Fetch handler.
 *
 * @param handler - Standard Fetch handler owned by the application or HTTP framework.
 * @param options - Go-style hostname, port, and drain options.
 * @returns An immutable structural Core server.
 * @throws Error when the Bun runtime is unavailable.
 */
export function newBunServer(
  handler: Handler,
  ...options: readonly BunServerOption[] // Go-style functional options require this single variadic construction boundary.
): BunServer {
  return newBunServerWithRuntime(
    handler,
    bunRuntimeFrom(Reflect.get(globalThis, "Bun")),
    ...options
  )
}

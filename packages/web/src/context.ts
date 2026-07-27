import {
  background,
  canceled,
  withCancelCause,
  withTimeout,
  type CancelFunc,
  type Context
} from "@likego/context"

/** Handles one standard Web request without exposing a runtime-specific server contract. */
export type Handler = (request: Request) => Response | Promise<Response>

/** Handles one standard Fetch request with its explicit request-scoped Go-style Context. */
export type ContextHandler = (ctx: Context, request: Request) => Response | Promise<Response>

export interface ContextHandlerOptions {
  readonly timeoutMs?: number
}

/**
 * Recognizes built-in Error objects across realms while retaining an instanceof fallback for runtimes
 * whose standard Error constructor does not yet expose Error.isError.
 */
function isError(value: unknown): value is Error {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  const candidate: unknown = descriptor?.value
  if (typeof candidate === "function") return candidate(value) === true
  return value instanceof Error
}

/** Converts an AbortSignal reason into the Error cause used by the request Context. */
function requestAbortCause(reason: unknown): Error {
  if (isError(reason)) return reason
  if (reason === undefined) return canceled
  return Object.freeze(new Error("request aborted with a non-Error reason", { cause: reason }))
}

/** Distinguishes an asynchronous handler result without relying on the local Response constructor. */
function isResponsePromise(value: Response | Promise<Response>): value is Promise<Response> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
  return "then" in value && typeof value.then === "function"
}

/**
 * Adapts an explicit Context-first handler to the standard single-argument Web handler ABI.
 *
 * Each request receives an independent Context. Request abort and an optional timeout cancel that
 * Context without replacing the handler's own synchronous or asynchronous result. All private Context
 * listeners and timers are released when the handler settles.
 */
export function contextHandler(handler: ContextHandler, options?: ContextHandlerOptions): Handler {
  if (typeof handler !== "function") throw new TypeError("handler must be callable")
  const capturedHandler = handler
  const timeoutMs = options?.timeoutMs
  if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
    throw new RangeError("timeoutMs must be finite")
  }

  /** Runs one Web request with request-scoped Context ownership and deterministic cleanup. */
  function webHandler(request: Request): Response | Promise<Response> {
    const signal = request.signal
    const [requestContext, cancelRequest] = withCancelCause(background())
    let handlerContext = requestContext
    let cancelTimeout: CancelFunc | null = null
    try {
      if (timeoutMs !== undefined) {
        const timedContext = withTimeout(requestContext, timeoutMs)
        handlerContext = timedContext[0]
        cancelTimeout = timedContext[1]
      }
    } catch (error) {
      cancelRequest(canceled)
      throw error
    }
    let listening = false
    let requestCanceled = false

    /** Propagates the request's first abort reason into its private Context exactly once. */
    function cancelFromRequest(): void {
      if (requestCanceled) return
      requestCanceled = true
      cancelRequest(requestAbortCause(signal.reason))
    }

    /** Releases the request listener, timeout Context, and request Context without replacing outcomes. */
    function cleanup(): void {
      requestCanceled = true
      if (listening) {
        listening = false
        try {
          signal.removeEventListener("abort", cancelFromRequest)
        } catch {
          // Request listener cleanup is best-effort.
        }
      }
      if (cancelTimeout !== null) {
        cancelTimeout()
      }
      cancelRequest(canceled)
    }

    /** Cleans private request resources before returning an asynchronous handler response. */
    function resolveResponse(response: Response): Response {
      cleanup()
      return response
    }

    /** Cleans private request resources while preserving an asynchronous handler rejection identity. */
    function rejectResponse(error: unknown): never {
      cleanup()
      throw error
    }

    try {
      if (signal.aborted) {
        cancelFromRequest()
      } else {
        listening = true
        signal.addEventListener("abort", cancelFromRequest, { once: true })
        if (signal.aborted) cancelFromRequest()
      }
    } catch (error) {
      cleanup()
      throw error
    }

    let result: Response | Promise<Response>
    try {
      result = capturedHandler(handlerContext, request)
    } catch (error) {
      cleanup()
      throw error
    }

    let asynchronous: boolean
    try {
      asynchronous = isResponsePromise(result)
    } catch (error) {
      cleanup()
      throw error
    }
    if (!asynchronous) {
      cleanup()
      return result
    }
    return Promise.resolve(result).then(resolveResponse, rejectResponse)
  }

  return webHandler
}

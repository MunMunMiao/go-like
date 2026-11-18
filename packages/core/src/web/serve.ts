import { canceled, withCancelCause, type CancelCauseFunc, type Context } from "../context"
import { isError } from "../internal/errors"
import {
  beginCoreUnit,
  detachSpan,
  endAtBodyEnd,
  ignoredRequest
} from "../telemetry/internal/instrument"
import { observeResponseBody } from "../transport/response-body"

import type { Handler } from "./context"
import { bindRequestContext } from "./request-context"

/** Serves one host request, recording http.server unless ignoreRequest matches. */
export function serveWebRequest(
  hostCtx: Context,
  handler: Handler,
  request: Request
): Response | Promise<Response> {
  if (ignoredRequest(hostCtx, request)) return deliverPlain(hostCtx, handler, request)
  let scheme: "http" | "https" = "http"
  try {
    scheme = new URL(request.url).protocol === "https:" ? "https" : "http"
  } catch {
    scheme = "http"
  }
  const scope = beginCoreUnit(
    hostCtx,
    { kind: "http.server", method: request.method, scheme },
    request.headers
  )
  const [ctx, cancel] = withCancelCause(scope.ctx)
  bindRequestContext(request, ctx)
  const stopAbort = watchAbort(request, cancel)
  try {
    const result = scope.run(() => handler(request))
    if (isPromise(result)) {
      return Promise.resolve(result).then(
        (response) =>
          response instanceof Response
            ? complete(scope, response, request, cancel, stopAbort)
            : rejectHandlerResult(scope, cancel, stopAbort),
        (error: unknown) => {
          // Classify the handler failure before cancellation, or it looks like a client abort.
          scope.end({ error })
          release(cancel, stopAbort)
          throw error
        }
      )
    }
    if (!(result instanceof Response)) return rejectHandlerResult(scope, cancel, stopAbort)
    return complete(scope, result, request, cancel, stopAbort)
  } catch (error) {
    scope.end({ error })
    release(cancel, stopAbort)
    throw error
  }
}

/** Rejects a handler result that is not a Response without throwing out of Fetch. */
function rejectHandlerResult(
  scope: ReturnType<typeof beginCoreUnit>,
  cancel: CancelCauseFunc,
  stopAbort: () => void
): Promise<Response> {
  const error = new TypeError("handler must return a Response")
  scope.end({ error })
  release(cancel, stopAbort)
  return Promise.reject(error)
}

/** Delivers an ignored request with host values and no http.server unit. */
function deliverPlain(
  hostCtx: Context,
  handler: Handler,
  request: Request
): Response | Promise<Response> {
  const [ctx, cancel] = withCancelCause(detachSpan(hostCtx))
  bindRequestContext(request, ctx)
  const stopAbort = watchAbort(request, cancel)
  try {
    const result = handler(request)
    if (isPromise(result)) {
      return Promise.resolve(result).then(
        (response) => ownIgnoredBody(response, request, cancel, stopAbort),
        (error: unknown) => {
          release(cancel, stopAbort)
          throw error
        }
      )
    }
    return ownIgnoredBody(result, request, cancel, stopAbort)
  } catch (error) {
    release(cancel, stopAbort)
    throw error
  }
}

/** Keeps an ignored request's Context until the body ends, without recording a unit. */
function ownIgnoredBody(
  result: Response,
  request: Request,
  cancel: CancelCauseFunc,
  stopAbort: () => void
): Response {
  if (!(result instanceof Response)) {
    release(cancel, stopAbort)
    return result
  }
  return observeResponseBody(
    result,
    function ended(): void {
      release(cancel, stopAbort)
    },
    { signal: request.signal, rpcStream: false }
  )
}

/** Ends the unit when the response body ends and cancels the request Context. */
function complete(
  scope: ReturnType<typeof beginCoreUnit>,
  response: Response,
  request: Request,
  cancel: CancelCauseFunc,
  stopAbort: () => void
): Response {
  return endAtBodyEnd(scope, response, {
    signal: request.signal,
    /** Cancels the request Context at the first terminal body event. */
    onEnd(): void {
      release(cancel, stopAbort)
    }
  })
}

/** Drops the abort listener and ends the request Context once. */
function release(cancel: CancelCauseFunc, stopAbort: () => void): void {
  stopAbort()
  cancel(canceled)
}

/** Cancels the request Context when the Fetch signal aborts. Returns a removal for the listener. */
function watchAbort(request: Request, cancel: CancelCauseFunc): () => void {
  const signal = request.signal
  if (signal.aborted) {
    cancel(abortCause(signal.reason))
    return function removeAborted(): void {}
  }
  /** Ends the request Context with the abort reason. */
  function onAbort(): void {
    cancel(abortCause(signal.reason))
  }
  signal.addEventListener("abort", onAbort, { once: true })
  return function removeAbort(): void {
    signal.removeEventListener("abort", onAbort)
  }
}

/** Converts an abort reason into an Error. */
function abortCause(reason: unknown): Error {
  if (isError(reason)) return reason
  if (reason === undefined) return canceled
  return new Error("request aborted with a non-Error reason", { cause: reason })
}

/** Distinguishes a thenable handler result from a Response. */
function isPromise(value: Response | Promise<Response>): value is Promise<Response> {
  return (
    value instanceof Promise || (typeof value === "object" && value !== null && "then" in value)
  )
}

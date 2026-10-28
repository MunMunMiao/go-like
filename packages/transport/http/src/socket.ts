import { canceled, withCancelCause, type Context } from "@go-like/context"
import {
  observeResponseBody,
  type TransportHandler,
  type TransportLogger
} from "@go-like/transport"

import { limitResponse } from "./bounded-body"
import { normalizeHTTPError } from "./errors"
import { defaultHTTPMaxMessageBytes } from "./options"
import { withHTTPServerTransportInfo } from "./transport-info"
import type { HTTPHostRequest } from "./types"

const InternalServerErrorBody = "Internal Server Error"

/** Returns one secret-safe generic server failure response. */
function internalServerError(): Response {
  return new Response(
    InternalServerErrorBody,
    Object.freeze({
      status: 500,
      headers: Object.freeze({ "content-type": "text/plain; charset=utf-8" })
    })
  )
}

/** Returns an Error abort reason, or the shared cancellation error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : canceled
}

/** Dispatches one host Request to a Fetch handler and returns its Response. */
export async function dispatchHTTPHostRequest(
  owner: Context,
  handler: TransportHandler,
  input: HTTPHostRequest,
  logger: TransportLogger | null = null,
  endpoint = "",
  maxMessageBytes = defaultHTTPMaxMessageBytes
): Promise<Response> {
  const [requestContext, cancelRequest] = withCancelCause(owner)
  const requestSignal = input.request.signal
  let released = false
  /** Detaches this request and cancels its Context once. The first cause wins. */
  function releaseRequest(ctxCause: Error): void {
    if (released) return
    released = true
    requestSignal.removeEventListener("abort", onAbort)
    cancelRequest(ctxCause)
  }
  /** Cancels the request Context when the host Request aborts. */
  function onAbort(): void {
    releaseRequest(abortReason(requestSignal))
  }
  /** Binds request-Context cleanup to the delivered Response body. */
  function observeOwned(response: Response): Response {
    return observeResponseBody(response, function bodyEnded(): void {
      releaseRequest(canceled)
    })
  }
  if (requestSignal.aborted) onAbort()
  else requestSignal.addEventListener("abort", onAbort, { once: true })
  const reply: { current: Response | null } = { current: null }
  const identity = input.peerIdentity
  const peerIdentity = typeof identity === "string" && identity.length > 0 ? identity : null
  const handlerContext = withHTTPServerTransportInfo(
    requestContext,
    endpoint,
    input.request,
    function currentResponse(): Response | null {
      return reply.current
    },
    peerIdentity
  )
  try {
    const produced = await handler(handlerContext, input.request)
    if (!(produced instanceof Response)) return observeOwned(internalServerError())
    // limitResponse already reports the first terminal body event; no second stream wrapper.
    const response = limitResponse(produced, maxMessageBytes, function bodyEnded(): void {
      releaseRequest(canceled)
    })
    reply.current = response
    return response
  } catch (error) {
    const failure = normalizeHTTPError(error, "HTTP transport handler rejected")
    logger?.log("error", "HTTP transport handler rejected", Object.freeze({ cause: failure }))
    return observeOwned(internalServerError())
  }
}

import { observeResponseBody as observeResponseBodyInternal } from "./response-body"

export {
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  newUnsupportedTransportCapabilityError
} from "./errors"
export { newServerContext } from "./transport-info"

/** Why a response body reached a terminal state. */
export type ResponseBodyEndReason = "end" | "error" | "cancel"

/**
 * The first terminal response-body event visible to a Listener.
 * RPC stream classification and timing stay inside core.
 */
export interface ResponseBodyEnd {
  readonly reason: ResponseBodyEndReason
  /** The read error or cancel reason. Null on "end". */
  readonly cause: unknown
}

/** Options for observeResponseBody. Timing and source cancellation stay inside core. */
export interface ObserveResponseBodyOptions {
  /** Aborts the unread source. A later read fails with the signal's reason. */
  readonly signal?: AbortSignal
}

/**
 * Returns a response that reports the first terminal body event once.
 * A null body reports "end" synchronously. An onEnd failure is isolated.
 */
export function observeResponseBody(
  response: Response,
  onEnd: (end: ResponseBodyEnd) => void,
  options?: ObserveResponseBodyOptions
): Response {
  return observeResponseBodyInternal(response, onEnd, options)
}

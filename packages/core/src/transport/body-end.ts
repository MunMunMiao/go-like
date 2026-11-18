import { deadlineExceeded, type Context } from "../context"
import {
  endAtBodyEnd,
  suppressCompletion,
  unitClock,
  type BodyEndOptions
} from "../telemetry/internal/body"
import { isHealthResponse } from "../telemetry/internal/resource"
import type { UnitResult, UnitScope } from "../telemetry/provider"

import { observeResponseBody, type ResponseBodyEnd } from "./response-body"

/**
 * Ends a unit at the protocol terminal event for an event stream, and at byte EOF otherwise.
 * Handshake timing is the header clock, not the time spent reading the body.
 */
export function endResponseUnit(
  scope: UnitScope,
  response: Response,
  options?: BodyEndOptions
): Response {
  if (!(response instanceof Response)) throw new TypeError("endResponseUnit requires a Response")
  if (!isEventStream(response)) return endAtBodyEnd(scope, response, options)
  const startedAt = options?.startedAt ?? unitClock(scope) ?? performance.now()
  const headersAt = options?.headersAt ?? performance.now()
  let ended = false
  /** Ends the unit once, after the caller's terminal callback. */
  const finish = (result: UnitResult): void => {
    if (ended) return
    ended = true
    try {
      options?.onEnd?.()
    } catch {
      // The protocol terminal still ends the unit when the caller throws.
    }
    if (isHealthResponse(response)) suppressCompletion(scope)
    scope.end(result)
  }
  try {
    return observeResponseBody(
      response,
      function endedOnProtocol(end: ResponseBodyEnd): void {
        finish(unitFromStream(scope, end))
      },
      {
        startedAt,
        headersAt,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        /** The unit span stays current across the read that produces the next frame. */
        enter(fn) {
          return scope.run(() => fn())
        }
      }
    )
  } catch (error) {
    const handshakeMs = headersAt - startedAt
    finish({
      error,
      httpStatus: response.status,
      stream: {
        messages: 0,
        handshakeMs: Number.isFinite(handshakeMs) ? Math.max(0, handshakeMs) : 0,
        status: "error",
        code: null
      }
    })
    return response
  }
}

/** Reports whether the response is an SSE RPC stream. Parameters are ignored. */
function isEventStream(response: Response): boolean {
  const raw = response.headers.get("content-type")
  return ((raw ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "") === "text/event-stream"
}

/** Maps one observed SSE body onto the unit result. A terminal frame wins over later cleanup. */
function unitFromStream(scope: UnitScope, end: ResponseBodyEnd): UnitResult {
  const stream = {
    messages: end.messageCount,
    handshakeMs: end.handshakeMs,
    status: "success" as const,
    code: null
  }
  if (end.status.kind === "success") {
    return { rpcStatusCode: "ok", stream }
  }
  if (end.status.kind === "error") {
    return {
      error: serviceFailure(end.status.code, end.status.status),
      rpcStatusCode: end.status.code,
      stream: { ...stream, status: "error", code: end.status.code }
    }
  }
  if (end.status.kind === "truncated" && end.reason !== "error") {
    return { stream: { ...stream, status: "truncated" } }
  }
  const failure = readContextError(scope.ctx)
  if (failure === deadlineExceeded || end.cause === deadlineExceeded) {
    return { error: deadlineExceeded, stream: { ...stream, status: "error" } }
  }
  if (end.reason === "cancel" || end.status.kind === "canceled") {
    return end.cause === null || end.cause === undefined
      ? { stream: { ...stream, status: "canceled" } }
      : { error: end.cause, stream: { ...stream, status: "canceled" } }
  }
  return end.cause === null || end.cause === undefined
    ? { stream: { ...stream, status: "error" } }
    : { error: end.cause, stream: { ...stream, status: "error" } }
}

/** Builds the ServiceError shape the outcome classifier already recognizes. */
function serviceFailure(
  code: string,
  status: number
): { readonly name: "ServiceError"; readonly code: string; readonly status: number } {
  return Object.freeze({ name: "ServiceError", code, status })
}

/** Reads ctx.err() without letting a broken Context choose the stream outcome. */
function readContextError(ctx: Context): Error | null {
  try {
    return ctx.err()
  } catch {
    return null
  }
}

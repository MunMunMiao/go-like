import type { Context } from "@go-like/context"

import { observeResponseBody, withResponseObserver, type ResponseBodyEnd } from "./response-body"

/** Couples a call Context with probes of what its response observer has seen. */
interface ArmedBody {
  /** Child Context whose response observer wraps each Response passed to applyResponseObservers. */
  readonly ctx: Context
  /** Reports whether a terminal body event has already been delivered to the callback. */
  recorded(): boolean
  /** Reports whether the response observer has wrapped at least one Response. */
  attached(): boolean
}

/** Derives a Context whose response observer forwards only the first body end to onEnd. */
function armBody(
  ctx: Context,
  startedAt: number,
  onEnd: (end: ResponseBodyEnd) => void
): ArmedBody {
  let recorded = false
  let attached = false
  const observed = withResponseObserver(ctx, function observe(response: Response): Response {
    attached = true
    return observeResponseBody(
      response,
      function ended(end: ResponseBodyEnd): void {
        if (recorded) return
        recorded = true
        onEnd(end)
      },
      { startedAt, headersAt: performance.now(), cancelSource: true }
    )
  })
  return {
    ctx: observed,
    recorded(): boolean {
      return recorded
    },
    attached(): boolean {
      return attached
    }
  }
}

/** Wraps a returned Response that no observer or body end has touched, else returns result. */
function finishBody(
  result: unknown,
  armed: ArmedBody,
  startedAt: number,
  onEnd: (end: ResponseBodyEnd) => void
): unknown {
  if (armed.recorded() || !(result instanceof Response) || armed.attached()) return result
  return observeResponseBody(
    result,
    function ended(end: ResponseBodyEnd): void {
      onEnd(end)
    },
    { startedAt, headersAt: performance.now(), cancelSource: true }
  )
}

/** Reports whether value has an async iterator and a close method, the shape of a ServerStream. */
function isServerStream(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  return (
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function" &&
    typeof (value as { close?: unknown }).close === "function"
  )
}

/**
 * Runs one call and publishes its outcome to record at most once.
 *
 * invoke receives a child of ctx whose response observer wraps every Response the callee passes to
 * applyResponseObservers; a returned unread Response that bypassed that step is wrapped here, and
 * any other result is returned unchanged. startedAt is a performance.now() timestamp taken before
 * the call.
 *
 * record receives the first terminal body event seen (end, null when there is none) and the value
 * invoke threw (failure, null when it returned; a thrown null reads the same). It runs as soon as
 * invoke throws or returns something other than an unread Response body or a server stream. For
 * those two it runs when the body reaches a terminal event, at once if that already happened, and
 * never if the body is neither read nor canceled. record should not throw: on an immediate outcome
 * its error rejects the call and record is not run again; on a deferred outcome the body observer
 * discards it.
 */
export async function observeCall(
  ctx: Context,
  startedAt: number,
  invoke: (ctx: Context) => Promise<unknown>,
  record: (end: ResponseBodyEnd | null, failure: unknown) => void
): Promise<unknown> {
  let pending: ResponseBodyEnd | null = null
  let open = false
  let done = false
  /** Publishes the first settled outcome. */
  function commit(failure: unknown): void {
    if (done) return
    done = true
    record(pending, failure)
  }
  /** Stores a body event and publishes it once the call has returned an open body. */
  function note(end: ResponseBodyEnd): void {
    pending = end
    if (open) commit(null)
  }
  const armed = armBody(ctx, startedAt, note)
  try {
    const result = await invoke(armed.ctx)
    const settled = finishBody(result, armed, startedAt, note)
    const waiting =
      (settled instanceof Response && settled.body !== null && !settled.bodyUsed) ||
      isServerStream(result)
    if (waiting) {
      open = true
      if (pending !== null) commit(null)
      return settled
    }
    commit(null)
    return settled
  } catch (value) {
    commit(value)
    throw value
  }
}

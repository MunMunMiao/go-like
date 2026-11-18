import type { Context } from "../../context/index"
import type { UnitResult, UnitScope } from "../provider"

import { isHealthResponse } from "./resource"
import { enterScope } from "./state"

/** Options for ending a unit at the first terminal body event. */
export interface BodyEndOptions {
  /** Clock reading captured when the unit began. Defaults to the time `endAtBodyEnd` is called. */
  readonly startedAt?: number
  /** Clock reading when the response head became available. */
  readonly headersAt?: number
  /** Caller abort signal. Abort ends the unit as canceled. */
  readonly signal?: AbortSignal
  /** Called once, together with the unit end. */
  readonly onEnd?: () => void
}

const healthUnits = new WeakSet<UnitScope>()
const unitClocks = new WeakMap<UnitScope, number>()

/** Remembers when a unit began so body completion uses the same clock. */
export function rememberUnitClock(scope: UnitScope, startedAt: number): void {
  unitClocks.set(scope, startedAt)
}

/** Returns the clock captured at `beginCoreUnit`, or null for an inert scope. */
export function unitClock(scope: UnitScope): number | null {
  return unitClocks.get(scope) ?? null
}

/** Marks a unit whose completion log must be suppressed. */
export function suppressCompletion(scope: UnitScope): void {
  healthUnits.add(scope)
}

/** Reports whether `endAtBodyEnd` saw a health response for this unit. */
export function completionSuppressed(scope: UnitScope): boolean {
  return healthUnits.has(scope)
}

/**
 * Ends `scope` at the first terminal body event.
 * A null or already-used body is terminal. A live body is pulled inside `scope.run`.
 */
export function endAtBodyEnd(
  scope: UnitScope,
  response: Response,
  options?: BodyEndOptions
): Response {
  if (!(response instanceof Response)) throw new TypeError("endAtBodyEnd requires a Response")
  const startedAt = options?.startedAt ?? unitClock(scope) ?? performance.now()
  const headersAt = options?.headersAt ?? startedAt
  let ended = false
  /** Ends the unit and notifies the caller once. */
  const finish = (result: UnitResult): void => {
    if (ended) return
    ended = true
    try {
      options?.onEnd?.()
    } catch {
      // The body terminal still ends the unit when the observer throws.
    }
    if (isHealthResponse(response)) suppressCompletion(scope)
    scope.end(result)
  }
  const body = response.body
  if (body === null || response.bodyUsed) {
    finish(resultFor(response.status))
    return response
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch (error) {
    finish({ ...resultFor(response.status), error })
    return response
  }
  const signal = options?.signal
  /** Cancels the source and ends the unit as canceled. */
  const cancelFromSignal = (): void => {
    finish({ error: signal?.reason, stream: streamResult(0, headersAt, startedAt, "canceled") })
    void reader.cancel(signal?.reason).catch(() => {})
  }
  if (signal?.aborted === true) {
    cancelFromSignal()
    return response
  }
  signal?.addEventListener("abort", cancelFromSignal, { once: true })
  const stream = new ReadableStream<Uint8Array>(
    {
      /** Pulls the next chunk inside the unit scope. */
      async pull(controller) {
        try {
          const chunk = await scope.run(() => reader.read())
          if (chunk.done === true) {
            finish({
              ...resultFor(response.status),
              stream: streamResult(0, headersAt, startedAt, statusStream(response.status))
            })
            signal?.removeEventListener("abort", cancelFromSignal)
            controller.close()
            return
          }
          controller.enqueue(chunk.value)
        } catch (error) {
          finish({ error, stream: streamResult(0, headersAt, startedAt, "error") })
          signal?.removeEventListener("abort", cancelFromSignal)
          controller.error(error)
        }
      },
      /** Ends the unit when the consumer cancels the body. */
      cancel(reason) {
        finish({ error: reason, stream: streamResult(0, headersAt, startedAt, "canceled") })
        signal?.removeEventListener("abort", cancelFromSignal)
        return reader.cancel(reason)
      }
    },
    // A positive watermark pulls the source before the consumer and breaks server backpressure.
    { highWaterMark: 0 }
  )
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

/** Wraps an async iterator so every step runs inside the unit's implicit scope. */
export function pullInScope<T>(unitCtx: Context, iterator: AsyncIterator<T>): AsyncIterator<T> {
  const wrapped: AsyncIterator<T> = {
    /** Reads the next value inside the unit scope. */
    next(value?: unknown): Promise<IteratorResult<T>> {
      return Promise.resolve(enterScope(unitCtx, () => iterator.next(value)))
    }
  }
  if (iterator.return !== undefined) {
    const returning = iterator.return.bind(iterator)
    /** Returns the iterator inside the unit scope. */
    wrapped.return = (value?: unknown): Promise<IteratorResult<T>> =>
      Promise.resolve(enterScope(unitCtx, () => returning(value)))
  }
  if (iterator.throw !== undefined) {
    const throwing = iterator.throw.bind(iterator)
    /** Throws into the iterator inside the unit scope. */
    wrapped.throw = (error?: unknown): Promise<IteratorResult<T>> =>
      Promise.resolve(enterScope(unitCtx, () => throwing(error)))
  }
  return wrapped
}

/** Maps an HTTP status onto the unit result core classifies. */
function resultFor(status: number): UnitResult {
  return { httpStatus: status }
}

/** Builds the stream result recorded when a body reaches a terminal event. */
function streamResult(
  messages: number,
  headersAt: number,
  startedAt: number,
  status: "success" | "canceled" | "truncated" | "error"
): NonNullable<UnitResult["stream"]> {
  return {
    messages,
    handshakeMs: Math.max(0, headersAt - startedAt),
    status,
    code: null
  }
}

/** Treats HTTP 5xx as an error stream and every other status as success. */
function statusStream(status: number): "success" | "error" {
  return status >= 500 ? "error" : "success"
}

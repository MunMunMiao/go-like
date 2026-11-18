import { type Context } from "../context/index"
import {
  inspectContext,
  readContextFailure,
  waitForDelay,
  type ContextState
} from "../internal/context"

export { inspectContext, readContextFailure, waitForDelay }
export type { ContextState }

/** Validates a Context and throws its terminal error before admitting new work. */
export function activeContext(ctx: Context): ContextState {
  const state = inspectContext(ctx)
  const failure = readContextFailure(state)
  if (failure !== null) throw failure
  return state
}

/** Reads the standard monotonic clock used for elapsed circuit-breaker durations. */
export function monotonicNow(): number {
  const value = performance.now()
  if (!Number.isFinite(value)) throw new RangeError("performance.now() must return a finite number")
  return value
}

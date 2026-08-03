import type { Context } from "@likego/context"

import { activeContext, monotonicNow } from "./internal"
import type {
  RateLimitDecision,
  RateLimiter,
  RateLimiterSnapshot,
  TokenBucketOptions
} from "./types"

/** Requires one positive safe integer option. */
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

/** Creates a non-blocking token bucket that refills lazily and owns no background timer. */
export function newTokenBucketLimiter(options: TokenBucketOptions): RateLimiter {
  if (options === null || typeof options !== "object") {
    throw new TypeError("token bucket options must be an object")
  }
  const capacity = positiveInteger(options.capacity, "capacity")
  const refillTokens = positiveInteger(options.refillTokens, "refillTokens")
  const refillIntervalMs = positiveInteger(options.refillIntervalMs, "refillIntervalMs")
  const initialTokens = options.initialTokens ?? capacity
  if (!Number.isSafeInteger(initialTokens) || initialTokens < 0 || initialTokens > capacity) {
    throw new RangeError("initialTokens must be a safe integer between 0 and capacity")
  }

  let availableTokens = initialTokens
  let lastRefillAt = monotonicNow()

  /** Applies every complete refill interval observed since the preceding refill boundary. */
  function refill(observedAt: number): void {
    if (observedAt <= lastRefillAt) return
    const intervals = Math.floor((observedAt - lastRefillAt) / refillIntervalMs)
    if (intervals < 1) return
    availableTokens = Math.min(capacity, availableTokens + intervals * refillTokens)
    lastRefillAt += intervals * refillIntervalMs
  }

  /** Calculates the delay until the next discrete refill boundary. */
  function nextRefillIn(observedAt: number): number {
    const elapsed = Math.max(0, observedAt - lastRefillAt)
    return Math.max(0, Math.ceil(refillIntervalMs - elapsed))
  }

  const limiter: RateLimiter = Object.freeze({
    /** Consumes one token or returns the delay until the next refill boundary. */
    allow(ctx: Context): RateLimitDecision {
      activeContext(ctx)
      const observedAt = monotonicNow()
      refill(observedAt)
      if (availableTokens > 0) {
        availableTokens -= 1
        return Object.freeze({ allowed: true, retryAfterMs: 0 })
      }
      return Object.freeze({ allowed: false, retryAfterMs: nextRefillIn(observedAt) })
    },
    /** Returns an immutable snapshot after applying all elapsed refill intervals. */
    snapshot(): RateLimiterSnapshot {
      const observedAt = monotonicNow()
      refill(observedAt)
      return Object.freeze({
        availableTokens,
        capacity,
        nextRefillInMs: nextRefillIn(observedAt)
      })
    }
  })
  return limiter
}

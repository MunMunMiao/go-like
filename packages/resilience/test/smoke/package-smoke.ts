import { background } from "@likego/context"
import {
  exponentialBackoff,
  newCircuitBreaker,
  newTokenBucketLimiter,
  retry
} from "@likego/resilience"

const ctx = background()
const attempts: number[] = []
const transient = new Error("transient")
const backoff = exponentialBackoff({ initialDelayMs: 0, maxDelayMs: 0 })
const value = await retry(
  ctx,
  (_attemptContext, attempt) => {
    attempts.push(attempt)
    if (attempt === 1) throw transient
    return "recovered"
  },
  {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry: (_attemptContext, failure) => failure === transient,
    backoff
  }
)

const breaker = newCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 })
const protectedValue = await breaker.execute(ctx, () => value)
const limiter = newTokenBucketLimiter({
  capacity: 1,
  refillTokens: 1,
  refillIntervalMs: 1_000
})
const first = limiter.allow(ctx)
const second = limiter.allow(ctx)

if (
  protectedValue !== "recovered" ||
  attempts.join(",") !== "1,2" ||
  !first.allowed ||
  second.allowed
) {
  throw new Error("published resilience smoke failed")
}

console.log(
  JSON.stringify({
    attempts,
    protectedValue,
    first,
    second,
    circuit: breaker.snapshot().state
  })
)

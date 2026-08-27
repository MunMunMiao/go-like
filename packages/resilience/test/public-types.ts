import { background, type Context } from "@go-like/context"
import * as Resilience from "../src/index"
import {
  circuitOpen,
  exponentialBackoff,
  newCircuitBreaker,
  newTokenBucketLimiter,
  retry,
  type Backoff,
  type BackoffOptions,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitFailurePredicate,
  type CircuitOperation,
  type CircuitSnapshot,
  type CircuitState,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimiterSnapshot,
  type RetryAuthorization,
  type RetryOperation,
  type RetryOptions,
  type RetryPredicate,
  type TokenBucketOptions
} from "../src/index"

const ctx: Context = background()
const authorization: RetryAuthorization = "idempotent"
const operation: RetryOperation<number> = (_attemptContext, attempt) => attempt
const predicate: RetryPredicate = async (_attemptContext, failure, attempt) => {
  return failure instanceof Error && attempt < 3
}
const backoffOptions: BackoffOptions = { initialDelayMs: 1, multiplier: 2, maxDelayMs: 10 }
const backoff: Backoff = exponentialBackoff(backoffOptions)
const retryOptions: RetryOptions = {
  authorization,
  maxAttempts: 3,
  shouldRetry: predicate,
  backoff
}
const retried: Promise<number> = retry(ctx, operation, retryOptions)
const inferredSync: Promise<{ readonly value: number }> = retry(
  ctx,
  () => Object.freeze({ value: 1 }),
  { authorization: "caller-approved", maxAttempts: 1, shouldRetry: () => false }
)
const inferredAsync: Promise<string> = retry(ctx, async () => "value", {
  authorization: "idempotent",
  maxAttempts: 1,
  shouldRetry: async () => false
})

const circuitOperation: CircuitOperation<string> = () => Promise.resolve("ok")
const circuitPredicate: CircuitFailurePredicate = async (_operationContext, failure) => {
  return failure instanceof Error
}
const circuitOptions: CircuitBreakerOptions = {
  failureThreshold: 2,
  resetTimeoutMs: 50,
  isFailure: circuitPredicate
}
const breaker: CircuitBreaker = newCircuitBreaker(circuitOptions)
const protectedValue: Promise<string> = breaker.execute(ctx, circuitOperation)
const circuitState: CircuitState = "closed"
const circuitSnapshot: CircuitSnapshot = breaker.snapshot()

const limiterOptions: TokenBucketOptions = {
  capacity: 2,
  refillTokens: 1,
  refillIntervalMs: 100,
  initialTokens: 1
}
const limiter: RateLimiter = newTokenBucketLimiter(limiterOptions)
const decision: RateLimitDecision = limiter.allow(ctx)
const limiterSnapshot: RateLimiterSnapshot = limiter.snapshot()
const openError: Error = circuitOpen

void [
  retried,
  inferredSync,
  inferredAsync,
  protectedValue,
  circuitState,
  circuitSnapshot,
  decision,
  limiterSnapshot,
  openError
]

// @ts-expect-error RetryOperation is type-only.
void Resilience.RetryOperation
// @ts-expect-error CircuitBreaker is type-only.
void Resilience.CircuitBreaker
// @ts-expect-error RateLimiter is type-only.
void Resilience.RateLimiter
// @ts-expect-error PascalCase callable aliases are not exported.
Resilience.Retry(ctx, operation, retryOptions)
// @ts-expect-error PascalCase callable aliases are not exported.
Resilience.NewCircuitBreaker(circuitOptions)
// @ts-expect-error Retry authorization is mandatory.
retry(ctx, operation, { maxAttempts: 2, shouldRetry: predicate })
// @ts-expect-error Retry operations receive the Context before the attempt number.
const reversedOperation: RetryOperation<number> = (attempt: number, _operationContext: Context) =>
  attempt
void reversedOperation
// @ts-expect-error Token capacity is numeric.
newTokenBucketLimiter({ capacity: "2", refillTokens: 1, refillIntervalMs: 100 })

import type { Context } from "@likego/context"

/** Declares why an operation may be attempted more than once. */
export type RetryAuthorization = "idempotent" | "caller-approved"

/** Runs one explicitly numbered attempt with the caller's Context. */
export type RetryOperation<T> = (ctx: Context, attempt: number) => T | Promise<T>

/** Decides whether one failed attempt may be followed by another attempt. */
export type RetryPredicate = (
  ctx: Context,
  failure: unknown,
  attempt: number
) => boolean | Promise<boolean>

/** Calculates the delay before the attempt following one failed attempt. */
export type Backoff = (attempt: number) => number

/** Configures a bounded, explicitly authorized retry operation. */
export interface RetryOptions {
  readonly authorization: RetryAuthorization
  readonly maxAttempts: number
  readonly shouldRetry: RetryPredicate
  readonly backoff?: Backoff
}

/** Configures capped exponential backoff in milliseconds. */
export interface BackoffOptions {
  readonly initialDelayMs: number
  readonly multiplier?: number
  readonly maxDelayMs?: number
}

/** Names the three observable circuit-breaker states. */
export type CircuitState = "closed" | "open" | "half-open"

/** Runs one operation admitted by a circuit breaker. */
export type CircuitOperation<T> = (ctx: Context) => T | Promise<T>

/** Classifies a rejected operation as a breaker failure or a healthy breaker outcome. */
export type CircuitFailurePredicate = (ctx: Context, failure: unknown) => boolean | Promise<boolean>

/** Configures one consecutive-failure circuit breaker. */
export interface CircuitBreakerOptions {
  readonly failureThreshold: number
  readonly resetTimeoutMs: number
  readonly isFailure?: CircuitFailurePredicate
}

/** Captures an immutable circuit state at one instant. */
export interface CircuitSnapshot {
  readonly state: CircuitState
  readonly consecutiveFailures: number
  readonly probeActive: boolean
  readonly retryAfterMs: number
}

/** Admits operations and exposes the current circuit state without owning the operation. */
export interface CircuitBreaker {
  /** Runs one operation when the circuit admits it. */
  execute<T>(ctx: Context, operation: CircuitOperation<T>): Promise<T>
  /** Returns an immutable snapshot after applying any elapsed reset timeout. */
  snapshot(): CircuitSnapshot
}

/** Configures a lazily refilled integer token bucket. */
export interface TokenBucketOptions {
  readonly capacity: number
  readonly refillTokens: number
  readonly refillIntervalMs: number
  readonly initialTokens?: number
}

/** Describes one immutable non-blocking rate-limit decision. */
export interface RateLimitDecision {
  readonly allowed: boolean
  readonly retryAfterMs: number
}

/** Captures the current token inventory without scheduling background work. */
export interface RateLimiterSnapshot {
  readonly availableTokens: number
  readonly capacity: number
  readonly nextRefillInMs: number
}

/** Makes non-blocking Context-aware token-bucket decisions. */
export interface RateLimiter {
  /** Consumes one token or returns a retry delay when the bucket is empty. */
  allow(ctx: Context): RateLimitDecision
  /** Returns an immutable lazily refreshed token-bucket snapshot. */
  snapshot(): RateLimiterSnapshot
}

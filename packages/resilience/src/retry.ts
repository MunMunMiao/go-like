import type { Context } from "@go-like/context"

import { activeContext, inspectContext, readContextFailure, waitForDelay } from "./internal"
import type { Backoff, BackoffOptions, RetryOperation, RetryOptions } from "./types"

const MaximumTimerDelay = 2_147_483_647

/** Requires a finite non-negative delay accepted consistently by standard timers. */
function validateDelay(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MaximumTimerDelay) {
    throw new RangeError(`${name} must be between 0 and ${MaximumTimerDelay} milliseconds`)
  }
  return value
}

/** Creates a capped exponential delay function whose first failed attempt uses the initial delay. */
export function exponentialBackoff(options: BackoffOptions): Backoff {
  if (options === null || typeof options !== "object") {
    throw new TypeError("backoff options must be an object")
  }
  const initialDelayMs = validateDelay(options.initialDelayMs, "initialDelayMs")
  const multiplier = options.multiplier ?? 2
  const maxDelayMs = validateDelay(options.maxDelayMs ?? MaximumTimerDelay, "maxDelayMs")
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new RangeError("multiplier must be finite and at least 1")
  }
  if (maxDelayMs < initialDelayMs) {
    throw new RangeError("maxDelayMs must be greater than or equal to initialDelayMs")
  }

  /** Calculates one capped exponential delay from a one-based failed-attempt number. */
  function backoff(attempt: number): number {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new RangeError("attempt must be a positive safe integer")
    }
    if (initialDelayMs === 0) return 0
    const calculated = initialDelayMs * multiplier ** (attempt - 1)
    return Math.min(calculated, maxDelayMs)
  }

  return backoff
}

/** Runs an explicitly authorized operation until success, rejection policy, Context, or attempt bound stops it. */
export async function retry<T>(
  ctx: Context,
  operation: RetryOperation<T>,
  options: RetryOptions
): Promise<T> {
  activeContext(ctx)
  if (typeof operation !== "function") throw new TypeError("operation must be callable")
  if (options === null || typeof options !== "object") {
    throw new TypeError("retry options must be an object")
  }
  const authorization = options.authorization
  const maxAttempts = options.maxAttempts
  const shouldRetryAttempt = options.shouldRetry
  const backoff = options.backoff
  if (authorization !== "idempotent" && authorization !== "caller-approved") {
    throw new TypeError("retry authorization must be idempotent or caller-approved")
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer")
  }
  if (typeof shouldRetryAttempt !== "function") {
    throw new TypeError("shouldRetry must be callable")
  }
  if (backoff !== undefined && typeof backoff !== "function") {
    throw new TypeError("backoff must be callable")
  }

  /** Runs one attempt and recurs only after an admitted retry delay has completed. */
  async function runAttempt(attempt: number): Promise<T> {
    activeContext(ctx)
    try {
      return await operation(ctx, attempt)
    } catch (failure) {
      const terminal = readContextFailure(inspectContext(ctx))
      if (terminal !== null) throw terminal
      if (attempt === maxAttempts) throw failure
      let shouldRetry: boolean
      try {
        shouldRetry = await shouldRetryAttempt(ctx, failure, attempt)
      } catch (policyFailure) {
        const policyContextFailure = readContextFailure(inspectContext(ctx))
        if (policyContextFailure !== null) throw policyContextFailure
        throw policyFailure
      }
      const policyContextFailure = readContextFailure(inspectContext(ctx))
      if (policyContextFailure !== null) throw policyContextFailure
      if (typeof shouldRetry !== "boolean") {
        throw new TypeError("shouldRetry must return a boolean")
      }
      if (!shouldRetry) throw failure
      activeContext(ctx)
      let delayMs = 0
      if (backoff !== undefined) {
        let observedDelay: number
        try {
          observedDelay = backoff(attempt)
        } catch (backoffFailure) {
          const backoffContextFailure = readContextFailure(inspectContext(ctx))
          if (backoffContextFailure !== null) throw backoffContextFailure
          throw backoffFailure
        }
        const backoffContextFailure = readContextFailure(inspectContext(ctx))
        if (backoffContextFailure !== null) throw backoffContextFailure
        delayMs = validateDelay(observedDelay, "backoff delay")
      }
      await waitForDelay(ctx, delayMs)
      return runAttempt(attempt + 1)
    }
  }
  return runAttempt(1)
}

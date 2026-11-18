import { expect, test } from "bun:test"

import * as Resilience from "../../src/resilience/index"

test("exports exactly the portable resilience runtime surface", () => {
  expect(Resilience).not.toHaveProperty("RetryOperation")
  expect(Resilience).not.toHaveProperty("CircuitBreaker")
  expect(Resilience).not.toHaveProperty("RateLimiter")
  expect(Resilience).not.toHaveProperty("Retry")
  expect(Resilience).not.toHaveProperty("NewCircuitBreaker")
  expect(Resilience).not.toHaveProperty("NewTokenBucketLimiter")
  expect(Resilience).not.toHaveProperty("ExponentialBackoff")
})

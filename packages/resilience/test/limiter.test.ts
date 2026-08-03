import { afterEach, expect, test } from "bun:test"
import { background, canceled, withCancel } from "@likego/context"

import { newTokenBucketLimiter } from "../src/index"

const OriginalPerformanceNow = performance.now

/** Replaces performance.now with one deterministic monotonic observation. */
function setNow(value: number): void {
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: () => value
  })
}

afterEach(() => {
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: OriginalPerformanceNow
  })
})

test("consumes, denies, and lazily refills discrete tokens", () => {
  let wall = 1_000
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value: () => wall
  })
  const limiter = newTokenBucketLimiter({
    capacity: 2,
    refillTokens: 1,
    refillIntervalMs: 100
  })

  const initial = limiter.snapshot()
  expect(initial).toEqual({ availableTokens: 2, capacity: 2, nextRefillInMs: 100 })
  expect(Object.isFrozen(initial)).toBe(true)

  const first = limiter.allow(background())
  const second = limiter.allow(background())
  const denied = limiter.allow(background())
  expect(first).toEqual({ allowed: true, retryAfterMs: 0 })
  expect(second).toEqual({ allowed: true, retryAfterMs: 0 })
  expect(denied).toEqual({ allowed: false, retryAfterMs: 100 })
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(denied)).toBe(true)

  wall = 1_050
  expect(limiter.snapshot()).toEqual({ availableTokens: 0, capacity: 2, nextRefillInMs: 50 })
  wall = 900
  expect(limiter.snapshot()).toEqual({ availableTokens: 0, capacity: 2, nextRefillInMs: 100 })
  wall = 1_100
  expect(limiter.allow(background())).toEqual({ allowed: true, retryAfterMs: 0 })
  wall = 1_450
  expect(limiter.snapshot()).toEqual({ availableTokens: 2, capacity: 2, nextRefillInMs: 50 })
})

test("supports an explicit empty initial bucket without a background timer", () => {
  setNow(10)
  const limiter = newTokenBucketLimiter({
    capacity: 3,
    refillTokens: 2,
    refillIntervalMs: 10,
    initialTokens: 0
  })

  expect(limiter.allow(background())).toEqual({ allowed: false, retryAfterMs: 10 })
  setNow(20)
  expect(limiter.snapshot()).toEqual({ availableTokens: 2, capacity: 3, nextRefillInMs: 10 })
})

test("Context cancellation is authoritative and consumes no token", () => {
  setNow(100)
  const limiter = newTokenBucketLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 10 })
  const [ctx, cancel] = withCancel(background())
  cancel()

  expect(() => limiter.allow(ctx)).toThrow(canceled)
  expect(limiter.snapshot().availableTokens).toBe(1)
})

test("validates construction, Context shape, and the monotonic clock", () => {
  setNow(0)
  expect(() => Reflect.apply(newTokenBucketLimiter, undefined, [null])).toThrow(TypeError)
  for (const capacity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => newTokenBucketLimiter({ capacity, refillTokens: 1, refillIntervalMs: 1 })).toThrow(
      RangeError
    )
  }
  for (const refillTokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => newTokenBucketLimiter({ capacity: 1, refillTokens, refillIntervalMs: 1 })).toThrow(
      RangeError
    )
  }
  for (const refillIntervalMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => newTokenBucketLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs })).toThrow(
      RangeError
    )
  }
  for (const initialTokens of [-1, 2, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      newTokenBucketLimiter({
        capacity: 1,
        refillTokens: 1,
        refillIntervalMs: 1,
        initialTokens
      })
    ).toThrow(RangeError)
  }

  const limiter = newTokenBucketLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 1 })
  expect(() => Reflect.apply(limiter.allow, limiter, [null])).toThrow(TypeError)
  setNow(Number.NaN)
  expect(() =>
    newTokenBucketLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 1 })
  ).toThrow(RangeError)
})

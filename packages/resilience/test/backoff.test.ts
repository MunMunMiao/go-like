import { expect, test } from "bun:test"

import { exponentialBackoff } from "../src/index"

test("calculates one-based capped exponential delays", () => {
  const backoff = exponentialBackoff({
    initialDelayMs: 5,
    multiplier: 3,
    maxDelayMs: 40
  })

  expect([backoff(1), backoff(2), backoff(3), backoff(4)]).toEqual([5, 15, 40, 40])
  expect(exponentialBackoff({ initialDelayMs: 0 })(1)).toBe(0)
  expect(exponentialBackoff({ initialDelayMs: 0, multiplier: Number.MAX_VALUE })(3)).toBe(0)
  expect(exponentialBackoff({ initialDelayMs: 2, maxDelayMs: 10 })(3)).toBe(8)
  expect(
    exponentialBackoff({
      initialDelayMs: 2_147_483_647,
      multiplier: Number.MAX_VALUE,
      maxDelayMs: 2_147_483_647
    })(2)
  ).toBe(2_147_483_647)
})

test("rejects malformed backoff construction options", () => {
  expect(() => Reflect.apply(exponentialBackoff, undefined, [null])).toThrow(TypeError)
  for (const initialDelayMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    expect(() => exponentialBackoff({ initialDelayMs })).toThrow(RangeError)
  }
  for (const maxDelayMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    expect(() => exponentialBackoff({ initialDelayMs: 0, maxDelayMs })).toThrow(RangeError)
  }
  for (const multiplier of [0, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => exponentialBackoff({ initialDelayMs: 1, multiplier })).toThrow(RangeError)
  }
  expect(() => exponentialBackoff({ initialDelayMs: 2, maxDelayMs: 1 })).toThrow(RangeError)
})

test("rejects non-positive or non-integral attempt numbers", () => {
  const backoff = exponentialBackoff({ initialDelayMs: 1 })

  for (const attempt of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => backoff(attempt)).toThrow(RangeError)
  }
})

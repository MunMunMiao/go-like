import { test } from "bun:test"

import { cacheConformanceCases } from "../../src/testing"

import { clock, newMemoryCache } from "../src/index"

let now = 1_000
const cases = cacheConformanceCases({
  createCache: () =>
    newMemoryCache(
      clock(function currentTime(): number {
        return now
      })
    ),
  advanceTime(milliseconds: number): void {
    now += milliseconds
  },
  convergenceTimeoutMs: 1_000,
  ttlMs: 20
})

for (const entry of cases) {
  test(`conformance: ${entry.name}`, entry.run)
}

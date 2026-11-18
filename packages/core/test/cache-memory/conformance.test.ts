import { test } from "bun:test"

import { cacheConformance } from "../../src/cache/testing"

import { clock, newMemoryCache } from "../../src/cache/memory/index"

let now = 1_000
const cases = cacheConformance({
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

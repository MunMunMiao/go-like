import { test } from "bun:test"

import { storeConformance } from "../../src/store/testing"

import { newMemoryStore } from "../../src/store/memory/index"

const cases = storeConformance({
  limits: {
    ttl: { minimumMs: 1, maximumMs: 2_147_483_647 },
    cas: true,
    sharedWriters: false
  },
  createStore: newMemoryStore,
  convergenceTimeoutMs: 1_000,
  ttlMs: 10
})

for (const entry of cases) {
  test(`conformance: ${entry.name}`, entry.run)
}

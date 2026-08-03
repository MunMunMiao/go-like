import { test } from "bun:test"

import { storeConformanceCases } from "../../src/testing"

import { newConsulStore } from "../src/index"
import { fakeConsul } from "./helpers"

const cases = storeConformanceCases({
  limits: {
    ttl: { minimumMs: 10_000, maximumMs: 86_400_000 },
    cas: true,
    sharedWriters: true
  },
  convergenceTimeoutMs: 1_000,
  ttlMs: 10_000,
  /** Creates one Store with isolated fake remote state. */
  createStore() {
    const backend = fakeConsul()
    return newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
  },
  /** Creates two Stores sharing exactly one fake Consul backend. */
  createSharedStores() {
    const backend = fakeConsul()
    return Object.freeze([
      newConsulStore({ fetch: backend.fetch, address: "http://consul.test" }),
      newConsulStore({ fetch: backend.fetch, address: "http://consul.test" })
    ])
  }
})

for (const conformanceCase of cases) test(conformanceCase.name, conformanceCase.run)

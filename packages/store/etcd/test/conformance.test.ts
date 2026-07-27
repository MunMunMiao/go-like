import { test } from "bun:test"

import { storeConformanceCases } from "../../src/testing"

import { newEtcdStore } from "../src/index"
import { fakeEtcd } from "./helpers"

const cases = storeConformanceCases({
  limits: {
    ttl: { minimumMs: 1_000, maximumMs: 2_147_483_647 },
    cas: true,
    sharedWriters: true
  },
  convergenceTimeoutMs: 4_000,
  ttlMs: 1_000,
  /** Creates one Store with isolated fake etcd state. */
  createStore() {
    const backend = fakeEtcd()
    return newEtcdStore({ fetch: backend.fetch, address: "http://etcd.test" })
  },
  /** Creates two Store clients sharing exactly one fake etcd state. */
  createSharedStores() {
    const backend = fakeEtcd()
    return Object.freeze([
      newEtcdStore({ fetch: backend.fetch, address: "http://etcd.test" }),
      newEtcdStore({ fetch: backend.fetch, address: "http://etcd.test" })
    ])
  }
})

for (const conformanceCase of cases) test(conformanceCase.name, conformanceCase.run)

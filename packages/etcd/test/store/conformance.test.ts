import { test } from "bun:test"

import { storeConformance } from "@go-like/core/testing"

import { newEtcdStore } from "../../src/store/index"
import { fakeEtcd } from "./helpers"
import { newEtcdClient } from "../../src/index"

const cases = storeConformance({
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
    return newEtcdStore(newEtcdClient({ fetch: backend.fetch, address: "http://etcd.test" }))
  },
  /** Creates two Store clients sharing exactly one fake etcd state. */
  createSharedStores() {
    const backend = fakeEtcd()
    return Object.freeze([
      newEtcdStore(newEtcdClient({ fetch: backend.fetch, address: "http://etcd.test" })),
      newEtcdStore(newEtcdClient({ fetch: backend.fetch, address: "http://etcd.test" }))
    ])
  }
})

for (const conformanceCase of cases) test(conformanceCase.name, conformanceCase.run)

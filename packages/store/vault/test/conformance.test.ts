import { test } from "bun:test"
import { storeConformanceCases } from "../../src/testing"

import { newVaultStore } from "../src/index"
import { fakeVault } from "./helpers"

const cases = storeConformanceCases({
  limits: { ttl: null, cas: false, sharedWriters: true },
  convergenceTimeoutMs: 1_000,
  createStore() {
    const backend = fakeVault()
    return newVaultStore({ fetch: backend.fetch, address: "http://vault.test", mount: "secret" })
  },
  createSharedStores() {
    const backend = fakeVault()
    return Object.freeze([
      newVaultStore({ fetch: backend.fetch, address: "http://vault.test", mount: "secret" }),
      newVaultStore({ fetch: backend.fetch, address: "http://vault.test", mount: "secret" })
    ])
  }
})

for (const conformanceCase of cases) test(conformanceCase.name, conformanceCase.run)

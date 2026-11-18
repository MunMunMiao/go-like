import { test } from "bun:test"
import { storeConformance } from "@go-like/core/testing"

import { newVaultClient } from "../../src/index"
import { newVaultStore } from "../../src/store/index"
import { fakeVault } from "./helpers"

/** Creates one store on a fresh client over the supplied fetch. */
function openStore(fetch: (request: Request) => Promise<Response>) {
  return newVaultStore(newVaultClient({ fetch, address: "http://vault.test" }), { mount: "secret" })
}

const cases = storeConformance({
  limits: { ttl: null, cas: false, sharedWriters: true },
  convergenceTimeoutMs: 1_000,
  createStore() {
    const backend = fakeVault()
    return openStore(backend.fetch)
  },
  createSharedStores() {
    const backend = fakeVault()
    return Object.freeze([openStore(backend.fetch), openStore(backend.fetch)])
  }
})

for (const conformanceCase of cases) test(conformanceCase.name, conformanceCase.run)

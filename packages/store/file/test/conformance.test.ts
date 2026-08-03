import { test } from "bun:test"

import type { Store } from "../../src/index"
import { storeConformanceCases } from "../../src/testing"

import { newFileStore, type FileStore } from "../src/index"
import { newNodeFileStoreHost } from "../src/node"
import { startStore, stopStore, withTempDirectory, type StartedStore } from "./helpers"

const names = storeConformanceCases({
  limits: {
    ttl: { minimumMs: 1, maximumMs: 2_147_483_647 },
    cas: true,
    sharedWriters: false
  },
  createStore: () => newFileStore(newNodeFileStoreHost(), "unused"),
  convergenceTimeoutMs: 2_000,
  ttlMs: 30
}).map(({ name }) => name)

for (const [index, name] of names.entries()) {
  test(`real filesystem conformance: ${name}`, async () => {
    await withTempDirectory(async (directory) => {
      const residents = new WeakMap<Store, FileStore>()
      const started = new WeakMap<Store, StartedStore>()
      const cases = storeConformanceCases({
        limits: {
          ttl: { minimumMs: 1, maximumMs: 2_147_483_647 },
          cas: true,
          sharedWriters: false
        },
        createStore() {
          const store = newFileStore(newNodeFileStoreHost(), directory)
          residents.set(store, store)
          return store
        },
        async prepareStore(_ctx, store) {
          const resident = residents.get(store)
          if (resident === undefined) throw new Error("File Store conformance owner is missing")
          started.set(store, await startStore(resident))
        },
        async releaseStore(_ctx, store) {
          const handle = started.get(store)
          if (handle === undefined) throw new Error("File Store conformance handle is missing")
          await stopStore(handle)
        },
        convergenceTimeoutMs: 2_000,
        ttlMs: 30
      })
      const entry = cases[index]
      if (entry === undefined) throw new Error("Store conformance case is missing")
      await entry.run()
    })
  })
}

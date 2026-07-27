import { expect, test } from "bun:test"

import { storeConformanceCases } from "../src/testing"
import type { Store } from "../src/index"
import { memoryBackend, memoryLimits, memoryStore } from "./helpers"

interface Faults {
  readonly deleteFailure: unknown | null
  readonly cleanupOnlyDeleteFailure: unknown | null
  readonly staleReads: boolean
  readonly writeFailure: unknown | null
}

const NoFaults: Faults = {
  deleteFailure: null,
  cleanupOnlyDeleteFailure: null,
  staleReads: false,
  writeFailure: null
}

/** Wraps one valid test Store with narrowly injected conformance failures. */
function faultyStore(base: Store, faults: Partial<Faults>): Store {
  const selected: Faults = {
    deleteFailure: faults.deleteFailure ?? NoFaults.deleteFailure,
    cleanupOnlyDeleteFailure: faults.cleanupOnlyDeleteFailure ?? NoFaults.cleanupOnlyDeleteFailure,
    staleReads: faults.staleReads ?? NoFaults.staleReads,
    writeFailure: faults.writeFailure ?? NoFaults.writeFailure
  }
  return {
    async read(ctx, key) {
      const current = await base.read(ctx, key)
      return selected.staleReads ? null : current
    },
    async write(ctx, input, ...options) {
      if (selected.writeFailure !== null) throw selected.writeFailure
      return await base.write(ctx, input, ...options)
    },
    async delete(ctx, key, ...options) {
      if (selected.deleteFailure !== null) throw selected.deleteFailure
      if (selected.cleanupOnlyDeleteFailure !== null && options.length === 0) {
        throw selected.cleanupOnlyDeleteFailure
      }
      return await base.delete(ctx, key, ...options)
    },
    list: (ctx, ...options) => base.list(ctx, ...options),
    string: () => base.string()
  }
}

const supported = {
  limits: memoryLimits(),
  createStore: () => memoryStore(),
  createSharedStores: () => {
    const backend = memoryBackend()
    return [memoryStore(backend), memoryStore(backend)] as const
  },
  convergenceTimeoutMs: 1_000,
  ttlMs: 200
}

for (const entry of storeConformanceCases(supported)) {
  test(`supported provider: ${entry.name}`, entry.run)
}

const unsupported = {
  limits: memoryLimits(false, false, false),
  createStore: () => memoryStore(undefined, memoryLimits(false, false, false)),
  convergenceTimeoutMs: 1_000
}

for (const entry of storeConformanceCases(unsupported)) {
  test(`limited provider: ${entry.name}`, entry.run)
}

const sharedWithoutCasLimits = memoryLimits(false, false, true)
const sharedWithoutCas = {
  limits: sharedWithoutCasLimits,
  createStore: () => memoryStore(undefined, sharedWithoutCasLimits),
  createSharedStores: () => {
    const backend = memoryBackend()
    return [
      memoryStore(backend, sharedWithoutCasLimits),
      memoryStore(backend, sharedWithoutCasLimits)
    ] as const
  },
  convergenceTimeoutMs: 1_000
}

for (const entry of storeConformanceCases(sharedWithoutCas)) {
  test(`shared provider without CAS: ${entry.name}`, entry.run)
}

test("conformance validates subject limits and required shared factories eagerly", () => {
  expect(() => storeConformanceCases(null as never)).toThrow(TypeError)
  expect(() =>
    storeConformanceCases({
      limits: { ttl: null, cas: "yes", sharedWriters: false } as never,
      createStore: () => memoryStore()
    })
  ).toThrow("limits are invalid")
  expect(() =>
    storeConformanceCases({
      limits: {
        ttl: { minimumMs: 0, maximumMs: 1 },
        cas: false,
        sharedWriters: false
      },
      createStore: () => memoryStore()
    })
  ).toThrow("ttl limits are invalid")
  expect(() =>
    storeConformanceCases({
      limits: memoryLimits(true, true, true),
      createStore: () => memoryStore(),
      ttlMs: 20
    })
  ).toThrow("createSharedStores")
  expect(() =>
    storeConformanceCases({
      limits: memoryLimits(false, false, false),
      createStore: () => memoryStore(),
      ttlMs: 20
    })
  ).toThrow("ttlMs requires")
  expect(() =>
    storeConformanceCases({
      limits: memoryLimits(true, true, false),
      createStore: () => memoryStore(),
      ttlMs: 1
    })
  ).toThrow("outside provider bounds")
  expect(() =>
    storeConformanceCases({
      limits: memoryLimits(false, false, false),
      createStore: () => memoryStore(),
      convergenceTimeoutMs: 0
    })
  ).toThrow("convergenceTimeoutMs")
  expect(() =>
    storeConformanceCases({
      limits: memoryLimits(false, false, false),
      createStore: () => memoryStore(),
      prepareStore: "invalid"
    } as never)
  ).toThrow("prepareStore")
  expect(() =>
    storeConformanceCases({
      limits: memoryLimits(false, false, false),
      createStore: () => memoryStore(),
      releaseStore: "invalid"
    } as never)
  ).toThrow("releaseStore")
})

test("conformance runs optional provider resource hooks around each case", async () => {
  let prepared = 0
  let released = 0
  const selected = storeConformanceCases({
    limits: memoryLimits(false, false, false),
    createStore: () => memoryStore(),
    async prepareStore() {
      prepared += 1
    },
    async releaseStore() {
      released += 1
    }
  })[0]
  await expect(selected?.run()).resolves.toBeUndefined()
  expect({ prepared, released }).toEqual({ prepared: 1, released: 1 })

  const sharedBackend = memoryBackend()
  const shared = storeConformanceCases({
    limits: memoryLimits(true, true, true),
    createStore: () => memoryStore(),
    createSharedStores: () => [memoryStore(sharedBackend), memoryStore(sharedBackend)],
    async prepareStore() {
      prepared += 1
    },
    async releaseStore() {
      released += 1
    },
    ttlMs: 20
  }).at(-1)
  await expect(shared?.run()).resolves.toBeUndefined()
  expect({ prepared, released }).toEqual({ prepared: 3, released: 3 })
})

test("conformance rejects invalid single and shared Store factories when each case starts", async () => {
  const single = storeConformanceCases({
    limits: memoryLimits(false, false, false),
    createStore: () => null as never
  })
  await expect(single[0]?.run()).rejects.toThrow("must return a Store")

  const shared = storeConformanceCases({
    limits: memoryLimits(true, true, true),
    createStore: () => memoryStore(),
    createSharedStores: () => [memoryStore(), memoryStore(), memoryStore()] as never,
    ttlMs: 20
  })
  await expect(shared.at(-1)?.run()).rejects.toThrow("exactly two Stores")

  const repeated = memoryStore()
  const duplicate = storeConformanceCases({
    limits: memoryLimits(true, true, true),
    createStore: () => memoryStore(),
    createSharedStores: () => [repeated, repeated],
    ttlMs: 20
  })
  await expect(duplicate.at(-1)?.run()).rejects.toThrow("distinct Stores")
})

test("conformance preserves primary and cleanup failures without leaking rejected values", async () => {
  const limits = memoryLimits(false, false, false)
  const cases = storeConformanceCases({
    limits,
    createStore: () =>
      faultyStore(memoryStore(undefined, limits), {
        writeFailure: "non-error write failure",
        deleteFailure: new Error("delete cleanup failed")
      })
  })
  await expect(cases[0]?.run()).rejects.toBeInstanceOf(AggregateError)

  const cleanupOnly = storeConformanceCases({
    limits,
    createStore: () =>
      faultyStore(memoryStore(undefined, limits), {
        cleanupOnlyDeleteFailure: new Error("delete cleanup failed")
      })
  })
  await expect(cleanupOnly[1]?.run()).rejects.toBeInstanceOf(AggregateError)

  const releaseOnly = storeConformanceCases({
    limits,
    createStore: () => memoryStore(undefined, limits),
    async releaseStore() {
      throw "non-error release failure"
    }
  })
  await expect(releaseOnly[0]?.run()).rejects.toThrow(
    "Store conformance observed a non-Error rejection"
  )
})

test("shared conformance bounds stale visibility and aggregates shared cleanup failures", async () => {
  const limits = memoryLimits(true, true, true)
  const timedOut = storeConformanceCases({
    limits,
    createStore: () => memoryStore(),
    createSharedStores: () => {
      const backend = memoryBackend()
      return [memoryStore(backend), faultyStore(memoryStore(backend), { staleReads: true })]
    },
    convergenceTimeoutMs: 20,
    ttlMs: 20
  })
  await expect(timedOut.at(-1)?.run()).rejects.toThrow("timed out")

  const combined = storeConformanceCases({
    limits,
    createStore: () => memoryStore(),
    createSharedStores: () => {
      const backend = memoryBackend()
      return [
        faultyStore(memoryStore(backend), {
          writeFailure: "shared write failed",
          deleteFailure: new Error("shared delete failed")
        }),
        memoryStore(backend)
      ]
    },
    ttlMs: 20
  })
  await expect(combined.at(-1)?.run()).rejects.toBeInstanceOf(AggregateError)

  const cleanupOnly = storeConformanceCases({
    limits,
    createStore: () => memoryStore(),
    createSharedStores: () => {
      const backend = memoryBackend()
      return [
        faultyStore(memoryStore(backend), {
          cleanupOnlyDeleteFailure: new Error("shared cleanup delete failed")
        }),
        memoryStore(backend)
      ]
    },
    async releaseStore() {
      throw new Error("shared release failed")
    },
    ttlMs: 20
  })
  await expect(cleanupOnly.at(-1)?.run()).rejects.toBeInstanceOf(AggregateError)
})

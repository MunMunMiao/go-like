import { expect, test } from "bun:test"

import type { Cache } from "../src/index"
import { cacheConformanceCases } from "../src/testing"
import { cachePair, testBackend, testCache, testClock } from "./helpers"

interface Faults {
  readonly deleteFailure: unknown | null
  readonly putFailure: unknown | null
  readonly staleReads: boolean
}

const NoFaults: Faults = {
  deleteFailure: null,
  putFailure: null,
  staleReads: false
}

/** Wraps one valid test Cache with narrowly injected conformance failures. */
function faultyCache(base: Cache, faults: Partial<Faults>): Cache {
  const selected: Faults = {
    deleteFailure: faults.deleteFailure ?? NoFaults.deleteFailure,
    putFailure: faults.putFailure ?? NoFaults.putFailure,
    staleReads: faults.staleReads ?? NoFaults.staleReads
  }
  return {
    async get(ctx, key) {
      const current = await base.get(ctx, key)
      return selected.staleReads ? null : current
    },
    async put(ctx, key, value, ...options) {
      if (selected.putFailure !== null) throw selected.putFailure
      await base.put(ctx, key, value, ...options)
    },
    async delete(ctx, key) {
      if (selected.deleteFailure !== null) throw selected.deleteFailure
      return await base.delete(ctx, key)
    },
    string: () => base.string()
  }
}

/** Makes one shared test client return a single stale read before delegating. */
function oneReadBehind(cache: Cache, stale: Uint8Array | null): Cache {
  let pending = true
  return {
    get(ctx, key) {
      if (pending && key === "conformance/shared") {
        pending = false
        return Promise.resolve(stale === null ? null : stale.slice())
      }
      return cache.get(ctx, key)
    },
    put(ctx, key, value) {
      return cache.put(ctx, key, value)
    },
    delete(ctx, key) {
      return cache.delete(ctx, key)
    },
    string() {
      return cache.string()
    }
  }
}

const supportedClock = testClock()
const supported = {
  createCache: () => testCache(testBackend(), true, supportedClock),
  advanceTime(milliseconds: number): void {
    supportedClock.advance(milliseconds)
  },
  convergenceTimeoutMs: 1_000,
  ttlMs: 20
}

for (const entry of cacheConformanceCases(supported)) {
  test(`supported provider: ${entry.name}`, entry.run)
}

const unsupported = {
  createCache: () => testCache(testBackend(), false),
  convergenceTimeoutMs: 1_000
}

for (const entry of cacheConformanceCases(unsupported)) {
  test(`ttl-disabled provider: ${entry.name}`, entry.run)
}

const sharedClock = testClock()
const shared = {
  createCache: () => testCache(testBackend(), true, sharedClock),
  createSharedCaches: () => {
    const backend = testBackend()
    return cachePair(testCache(backend, true, sharedClock), testCache(backend, true, sharedClock))
  },
  advanceTime(milliseconds: number): void {
    sharedClock.advance(milliseconds)
  },
  convergenceTimeoutMs: 1_000,
  ttlMs: 20
}

for (const entry of cacheConformanceCases(shared)) {
  test(`shared provider: ${entry.name}`, entry.run)
}

const eventualSharedCase = cacheConformanceCases({
  createCache: () => testCache(),
  createSharedCaches: () => {
    const backend = testBackend()
    return cachePair(
      oneReadBehind(testCache(backend), new Uint8Array([7])),
      oneReadBehind(testCache(backend), null)
    )
  },
  convergenceTimeoutMs: 1_000,
  ttlMs: 20
}).find((entry) => entry.name === "shared writers observe put and delete across clients")
if (eventualSharedCase === undefined) throw new Error("shared Cache conformance case is missing")
test("shared provider convergence polls after one stale read", eventualSharedCase.run)

const realClock = {
  now(): number {
    return Date.now()
  },
  advance(): void {}
}
const realTimeTtlCase = cacheConformanceCases({
  createCache: () => testCache(testBackend(), true, realClock),
  convergenceTimeoutMs: 1_000,
  ttlMs: 20
}).find((entry) => entry.name === "ttl is explicit and expiry is a miss")
if (realTimeTtlCase === undefined) throw new Error("TTL Cache conformance case is missing")
test("TTL conformance waits against a real provider clock", realTimeTtlCase.run)

const nonErrorProviderCase = cacheConformanceCases({
  createCache: () => testCache(),
  advanceTime(): never {
    throw "private provider rejection"
  },
  convergenceTimeoutMs: 1_000,
  ttlMs: 20
}).find((entry) => entry.name === "ttl is explicit and expiry is a miss")
if (nonErrorProviderCase === undefined) throw new Error("provider failure case is missing")
test("conformance normalizes a non-Error provider rejection", async () => {
  await expect(nonErrorProviderCase.run()).rejects.toThrow(
    "Cache conformance observed a non-Error rejection"
  )
})

test("conformance validates provider-specific controls eagerly", () => {
  expect(() => Reflect.apply(cacheConformanceCases, undefined, [null])).toThrow(TypeError)
  expect(() =>
    cacheConformanceCases({
      createCache: () => testCache(),
      createSharedCaches: 1 as never
    })
  ).toThrow("createSharedCaches")
  expect(() =>
    cacheConformanceCases({
      createCache: () => testCache(),
      useCache: 1 as never
    })
  ).toThrow("useCache")
  expect(() =>
    cacheConformanceCases({
      createCache: () => testCache(),
      advanceTime(): void {}
    })
  ).toThrow("requires ttlMs")
  expect(() =>
    cacheConformanceCases({
      createCache: () => testCache(),
      ttlMs: 0
    })
  ).toThrow("ttlMs")
  expect(() =>
    cacheConformanceCases({
      createCache: () => testCache(),
      ttlMs: 100,
      convergenceTimeoutMs: 100
    })
  ).toThrow("fit the convergence timeout")
  expect(() =>
    cacheConformanceCases({
      createCache: () => testCache(),
      convergenceTimeoutMs: 0
    })
  ).toThrow("convergenceTimeoutMs")
})

test("conformance rejects invalid single, shared, and owner factories", async () => {
  const single = cacheConformanceCases({
    createCache: () => null as never
  })
  await expect(single[0]?.run()).rejects.toThrow("must return a Cache")

  const shared = cacheConformanceCases({
    createCache: () => testCache(undefined, false),
    createSharedCaches: () => [testCache(), testCache(), testCache()] as never
  })
  await expect(shared.at(-1)?.run()).rejects.toThrow("exactly two Caches")

  const repeated = testCache(undefined, false)
  const duplicate = cacheConformanceCases({
    createCache: () => testCache(undefined, false),
    createSharedCaches: () => [repeated, repeated]
  })
  await expect(duplicate.at(-1)?.run()).rejects.toThrow("distinct Caches")
})

test("conformance preserves primary and cleanup failure order", async () => {
  const deleteFailure = new Error("delete cleanup failed")
  const primaryAndCleanup = cacheConformanceCases({
    createCache: () =>
      faultyCache(testCache(undefined, false), {
        putFailure: "non-error put failure",
        deleteFailure
      })
  })
  const combined = await primaryAndCleanup[1]?.run().catch((error: unknown) => error)
  expect(combined).toBeInstanceOf(AggregateError)
  if (!(combined instanceof AggregateError)) throw new Error("combined Cache failure expected")
  expect(combined.errors[0]).toMatchObject({
    message: "Cache conformance observed a non-Error rejection"
  })
  expect(combined.errors.slice(1)).toEqual([deleteFailure])

  const cleanupDelete = new Error("cleanup-only delete failed")
  const cleanupOnly = cacheConformanceCases({
    createCache: () =>
      faultyCache(testCache(undefined, false), {
        deleteFailure: cleanupDelete
      })
  })
  const cleanup = await cleanupOnly[2]?.run().catch((error: unknown) => error)
  expect(cleanup).toBe(cleanupDelete)
})

test("conformance delegates provider setup and cleanup around each case", async () => {
  const events: string[] = []
  const cases = cacheConformanceCases({
    createCache: () => testCache(),
    async useCache(cache, run): Promise<void> {
      events.push(`open:${cache.string()}`)
      try {
        await run(cache)
      } finally {
        events.push(`close:${cache.string()}`)
      }
    }
  })
  await cases[1]?.run()
  expect(events).toEqual(["open:test", "close:test"])
})

test("shared conformance bounds stale visibility and preserves failures", async () => {
  const timedOut = cacheConformanceCases({
    createCache: () => testCache(undefined, false),
    createSharedCaches: () => {
      const backend = testBackend()
      return cachePair(
        testCache(backend, false),
        faultyCache(testCache(backend, false), { staleReads: true })
      )
    },
    convergenceTimeoutMs: 20
  })
  await expect(timedOut.at(-1)?.run()).rejects.toThrow("timed out")

  const sharedDelete = new Error("shared delete failed")
  const primaryAndCleanup = cacheConformanceCases({
    createCache: () => testCache(undefined, false),
    createSharedCaches: () => {
      const backend = testBackend()
      return cachePair(
        faultyCache(testCache(backend, false), {
          putFailure: "shared put failed",
          deleteFailure: sharedDelete
        }),
        testCache(backend, false)
      )
    }
  })
  const combined = await primaryAndCleanup
    .at(-1)
    ?.run()
    .catch((error: unknown) => error)
  expect(combined).toBe("shared put failed")

  const cleanupDelete = new Error("shared cleanup delete failed")
  const cleanupOnly = cacheConformanceCases({
    createCache: () => testCache(undefined, false),
    createSharedCaches: () => {
      const backend = testBackend()
      return cachePair(
        faultyCache(testCache(backend, false), {
          deleteFailure: cleanupDelete
        }),
        testCache(backend, false)
      )
    }
  })
  const cleanup = await cleanupOnly
    .at(-1)
    ?.run()
    .catch((error: unknown) => error)
  expect(cleanup).toBe(cleanupDelete)
})

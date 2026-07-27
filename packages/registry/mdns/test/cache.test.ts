import { describe, expect, test } from "bun:test"

import type { ServiceInstance } from "@likego/registry"

import { newMDNSCache } from "../src/cache"

/** Creates one deterministic cache fixture. */
function instance(
  endpoint: string,
  version = "v1",
  id = "node-1",
  metadata: Readonly<Record<string, string>> = {}
): ServiceInstance {
  return {
    id,
    name: "cache-service",
    version,
    metadata,
    endpoints: [new URL(endpoint).toString()]
  }
}

describe("mDNS ServiceInstance TTL cache", () => {
  test("deduplicates equivalent publishers and deletes only after the final publisher expires", () => {
    const cache = newMDNSCache()
    const current = instance("http://127.0.0.1:8080")
    expect(cache.observe("publisher-a", current, 2, 0)).toEqual(["cache-service"])
    expect(cache.observe("publisher-b", current, 3, 0)).toEqual([])
    expect(cache.expire(2_001)).toEqual([])
    expect(cache.instances("cache-service")).toEqual([current])
    expect(cache.expire(3_001)).toEqual(["cache-service"])
    expect(cache.instances("cache-service")).toEqual([])
  })

  test("goodbye uses one-second grace and a positive rescue cancels deletion", () => {
    const cache = newMDNSCache()
    const current = instance("http://127.0.0.1:8080")
    cache.observe("publisher", current, 2, 0)
    expect(cache.observe("publisher", current, 0, 100)).toEqual([])
    expect(cache.expire(1_099)).toEqual([])
    expect(cache.observe("publisher", current, 2, 1_099)).toEqual([])
    expect(cache.expire(1_101)).toEqual([])
    expect(cache.instances("cache-service")).toEqual([current])
  })

  test("ignores unknown or mismatched goodbye records", () => {
    const cache = newMDNSCache()
    const current = instance("http://127.0.0.1:8080")
    expect(cache.observe("unknown", current, 0, 0)).toEqual([])
    cache.observe("publisher", current, 2, 0)
    expect(cache.observe("publisher", instance("http://127.0.0.1:8081"), 0, 100)).toEqual([])
    expect(cache.instances("cache-service")).toEqual([current])
  })

  test("same publisher replaces a version while conflicting publishers fail closed", () => {
    const cache = newMDNSCache()
    const initial = instance("http://127.0.0.1:8080")
    const updated = instance("http://127.0.0.1:8081", "v2")
    cache.observe("publisher-a", initial, 2, 0)
    expect(cache.observe("publisher-a", updated, 2, 1)).toEqual(["cache-service"])
    expect(cache.instances("cache-service")).toEqual([updated])
    expect(() => cache.observe("publisher-b", initial, 2, 2)).toThrow(
      expect.objectContaining({ code: "LIKEGO_REGISTRY_PROTOCOL" })
    )
    expect(cache.instances("cache-service")).toEqual([updated])
  })

  test("sorts independent instances and validates boundaries", () => {
    const cache = newMDNSCache()
    expect(() => cache.observe("", instance("http://127.0.0.1:8080"), 1, 0)).toThrow(TypeError)
    expect(() => cache.observe("publisher", instance("http://127.0.0.1:8080"), -1, 0)).toThrow(
      RangeError
    )
    expect(() => cache.expire(Number.NaN)).toThrow(RangeError)
    expect(() => cache.instances("")).toThrow(TypeError)

    const second = instance("http://127.0.0.1:8081", "v1", "node-2")
    const first = instance("http://127.0.0.1:8080", "v1", "node-1")
    cache.observe("second", second, 2, 0)
    cache.observe("first", first, 2, 0)
    expect(cache.instances("cache-service")).toEqual([first, second])
    cache.close()
    expect(cache.instances("cache-service")).toEqual([])
  })
})

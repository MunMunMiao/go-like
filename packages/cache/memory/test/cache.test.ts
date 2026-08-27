import { expect, test } from "bun:test"

import { expiresIn } from "@go-like/cache"
import { background, cause, withCancel } from "@go-like/context"

import { clock, newMemoryCache } from "../src/index"

test("Memory Cache owns bytes and implements exact CRUD", async () => {
  const cache = newMemoryCache()
  const input = new Uint8Array([1, 2])
  expect(await cache.get(background(), "key")).toBeNull()
  expect(await cache.get(background(), "😀")).toBeNull()
  await cache.put(background(), "key", input)
  input[0] = 9
  const first = await cache.get(background(), "key")
  expect(first).toEqual(new Uint8Array([1, 2]))
  if (first !== null) first[0] = 8
  expect(await cache.get(background(), "key")).toEqual(new Uint8Array([1, 2]))
  await cache.put(background(), "key", new Uint8Array([3]))
  expect(await cache.get(background(), "key")).toEqual(new Uint8Array([3]))
  await cache.delete(background(), "key")
  expect(await cache.get(background(), "key")).toBeNull()
  await cache.delete(background(), "key")
})

test("TTL uses the injected clock and expires lazily as a miss", async () => {
  let now = 10
  const cache = newMemoryCache(
    clock(function currentTime(): number {
      return now
    })
  )
  await cache.put(background(), "ttl", new Uint8Array([1]), expiresIn(5))
  now = 14
  expect(await cache.get(background(), "ttl")).toEqual(new Uint8Array([1]))
  now = 15
  expect(await cache.get(background(), "ttl")).toBeNull()
  await cache.delete(background(), "ttl")

  await cache.put(background(), "forever", new Uint8Array([2]))
  now = 1_000_000
  expect(await cache.get(background(), "forever")).toEqual(new Uint8Array([2]))
})

test("default construction uses a real wall clock without background cleanup", async () => {
  const cache = newMemoryCache()
  await cache.put(background(), "short", new Uint8Array([1]), expiresIn(1))
  await Bun.sleep(5)
  expect(await cache.get(background(), "short")).toBeNull()
})

test("construction options are ordered last-wins", async () => {
  const cache = newMemoryCache(
    clock(function firstClock(): number {
      return 1
    }),
    clock(function secondClock(): number {
      return 10
    })
  )
  await cache.put(background(), "key", new Uint8Array([1]), expiresIn(1))
  expect(await cache.get(background(), "key")).toEqual(new Uint8Array([1]))
})

test("canceled operations preserve the exact Context cause", async () => {
  const cache = newMemoryCache()
  const canceledContext = withCancel(background())
  canceledContext[1]()
  const expected = cause(canceledContext[0]) ?? canceledContext[0].err()
  await expect(cache.get(canceledContext[0], "key")).rejects.toBe(expected)
  await expect(cache.put(canceledContext[0], "key", new Uint8Array([1]))).rejects.toBe(expected)
  await expect(cache.delete(canceledContext[0], "key")).rejects.toBe(expected)
  expect(await cache.get(background(), "key")).toBeNull()
})

test("provider bounds and runtime inputs fail closed", async () => {
  expect(() => Reflect.apply(clock, undefined, [null])).toThrow(TypeError)
  expect(() => Reflect.apply(newMemoryCache, undefined, [null])).toThrow(TypeError)
  expect(() =>
    Reflect.apply(newMemoryCache, undefined, [
      function invalid(): null {
        return null
      }
    ])
  ).toThrow(TypeError)

  const cache = newMemoryCache()
  await expect(cache.get(background(), "")).rejects.toBeInstanceOf(TypeError)
  await expect(cache.get(background(), "\ud800")).rejects.toBeInstanceOf(TypeError)
  await expect(cache.get(background(), "x".repeat(4_097))).rejects.toBeInstanceOf(RangeError)
  await expect(cache.put(background(), "key", new Uint8Array(16_777_217))).rejects.toBeInstanceOf(
    RangeError
  )
  await expect(
    Reflect.apply(cache.put, cache, [background(), "key", "value"])
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    cache.put(background(), "key", new Uint8Array([1]), expiresIn(2_147_483_648))
  ).rejects.toBeInstanceOf(RangeError)
})

test("clock output and expiry timestamp must remain safe integers", async () => {
  const invalidClockCache = newMemoryCache(
    clock(function invalidClock(): number {
      return -1
    })
  )
  await expect(
    invalidClockCache.put(background(), "key", new Uint8Array([1]), expiresIn(1))
  ).rejects.toBeInstanceOf(RangeError)

  const overflowCache = newMemoryCache(
    clock(function overflowClock(): number {
      return Number.MAX_SAFE_INTEGER
    })
  )
  await expect(
    overflowCache.put(background(), "key", new Uint8Array([1]), expiresIn(1))
  ).rejects.toBeInstanceOf(RangeError)
})

test("provider name is stable", () => {
  const cache = newMemoryCache()
  expect(cache.string()).toBe("memory")
  expect(cache.string()).toBe("memory")
})

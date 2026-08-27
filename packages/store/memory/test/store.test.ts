import { expect, test } from "bun:test"

import { background, cause, withCancel } from "@go-like/context"
import { cursor, expiresIn, ifRevision, limit, prefix } from "../../src/index"

import { clock, newMemoryStore } from "../src/index"

test("instances are isolated and TTL uses the last injected clock", async () => {
  let now = 10
  const first = newMemoryStore(
    clock(function ignoredClock(): number {
      return 1
    }),
    clock(function currentTime(): number {
      return now
    })
  )
  const second = newMemoryStore()

  await first.write(background(), { key: "ttl", value: new Uint8Array([1]) }, expiresIn(5))
  expect(await second.read(background(), "ttl")).toBeNull()
  now = 14
  expect(await first.read(background(), "ttl")).toMatchObject({ expiresAt: 15 })
  now = 15
  expect(await first.read(background(), "ttl")).toBeNull()
  expect(await first.delete(background(), "ttl")).toBe(false)
  expect(first.string()).toBe("memory")
})

test("concurrent compare-and-swap admits exactly one writer", async () => {
  const store = newMemoryStore()
  const initial = await store.write(background(), {
    key: "counter",
    value: new Uint8Array([0])
  })
  const settled = await Promise.allSettled([
    store.write(
      background(),
      { key: "counter", value: new Uint8Array([1]) },
      ifRevision(initial.revision)
    ),
    store.write(
      background(),
      { key: "counter", value: new Uint8Array([2]) },
      ifRevision(initial.revision)
    )
  ])

  expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
  const rejected = settled.find(({ status }) => status === "rejected")
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: { code: "GO_LIKE_STORE_CONFLICT" }
  })
  await expect(
    store.delete(background(), "counter", ifRevision(initial.revision))
  ).rejects.toMatchObject({ code: "GO_LIKE_STORE_CONFLICT" })
  expect(await store.delete(background(), "counter")).toBe(true)
})

test("a successful write or delete folds lazy expiry into the same mutation", async () => {
  let now = 10
  const store = newMemoryStore(
    clock(function currentTime(): number {
      return now
    })
  )
  await store.write(
    background(),
    { key: "expired-before-write", value: new Uint8Array([1]) },
    expiresIn(1)
  )
  await store.write(background(), { key: "stable", value: new Uint8Array([2]) })
  now = 11
  await store.write(background(), { key: "replacement", value: new Uint8Array([3]) })
  await store.write(
    background(),
    { key: "expired-before-delete", value: new Uint8Array([4]) },
    expiresIn(1)
  )
  now = 12
  expect(await store.delete(background(), "stable")).toBe(true)
  expect(await store.read(background(), "expired-before-write")).toBeNull()
  expect(await store.read(background(), "expired-before-delete")).toBeNull()
})

test("cursor is revision and prefix bound and rejects malformed or impossible offsets", async () => {
  const store = newMemoryStore()
  await store.write(background(), { key: "items/z", value: new Uint8Array([1]) })
  await store.write(background(), { key: "items/a", value: new Uint8Array([2]) })
  const first = await store.list(background(), prefix("items/"), limit(1))
  expect(first.records.map(({ key }) => key)).toEqual(["items/a"])
  if (first.cursor === null) throw new Error("expected a continuation cursor")

  await expect(
    store.list(background(), prefix("other/"), cursor(first.cursor))
  ).rejects.toBeInstanceOf(TypeError)
  await expect(store.list(background(), cursor("{"))).rejects.toBeInstanceOf(TypeError)
  await expect(store.list(background(), cursor("{}"))).rejects.toBeInstanceOf(TypeError)
  await expect(
    store.list(background(), cursor(JSON.stringify([2, 2, "", 0])))
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    store.list(background(), cursor(JSON.stringify([1, 2, "", 99])))
  ).rejects.toBeInstanceOf(TypeError)

  await store.write(background(), { key: "items/b", value: new Uint8Array([3]) })
  await expect(
    store.list(background(), prefix("items/"), cursor(first.cursor))
  ).rejects.toBeInstanceOf(TypeError)
})

test("every pre-canceled operation preserves its Context cause without side effects", async () => {
  const store = newMemoryStore()
  await store.write(background(), { key: "stable", value: new Uint8Array([1]) })
  const [ctx, cancel] = withCancel(background())
  cancel()
  const expected = cause(ctx) ?? ctx.err()

  await expect(store.read(ctx, "stable")).rejects.toBe(expected)
  await expect(store.write(ctx, { key: "rejected", value: new Uint8Array([2]) })).rejects.toBe(
    expected
  )
  await expect(store.delete(ctx, "stable")).rejects.toBe(expected)
  await expect(store.list(ctx)).rejects.toBe(expected)
  expect(await store.read(background(), "stable")).not.toBeNull()
  expect(await store.read(background(), "rejected")).toBeNull()
})

test("construction options clocks inputs and expiry bounds fail closed", async () => {
  expect(() => Reflect.apply(clock, undefined, [null])).toThrow(TypeError)
  expect(() => Reflect.apply(newMemoryStore, undefined, [null])).toThrow(TypeError)
  expect(() =>
    Reflect.apply(newMemoryStore, undefined, [
      function invalidOption(): null {
        return null
      }
    ])
  ).toThrow(TypeError)
  expect(() =>
    Reflect.apply(newMemoryStore, undefined, [
      function invalidClockOption(): object {
        return { clock: null }
      }
    ])
  ).toThrow(TypeError)

  const invalidClock = newMemoryStore(
    clock(function invalidTime(): number {
      return -1
    })
  )
  await expect(invalidClock.read(background(), "key")).rejects.toBeInstanceOf(RangeError)

  const overflow = newMemoryStore(
    clock(function maximumTime(): number {
      return Number.MAX_SAFE_INTEGER
    })
  )
  await expect(
    overflow.write(background(), { key: "ttl", value: new Uint8Array() }, expiresIn(1))
  ).rejects.toBeInstanceOf(RangeError)
  expect(await overflow.read(background(), "ttl")).toBeNull()

  const store = newMemoryStore()
  await expect(store.read(background(), "")).rejects.toBeInstanceOf(TypeError)
  await expect(store.delete(background(), "\ud800")).rejects.toBeInstanceOf(TypeError)
  await expect(
    store.write(background(), { key: "ttl", value: new Uint8Array() }, expiresIn(2_147_483_648))
  ).rejects.toBeInstanceOf(RangeError)
})

import { expect, test } from "bun:test"

import { background } from "@go-like/context"
import { expiresIn } from "../../src/index"

import { clock } from "../src/index"
import { newMemoryStoreAtRevision } from "../src/store"

test("revision exhaustion fails before write delete or expiry mutation", async () => {
  const maximum = Number.MAX_SAFE_INTEGER
  expect(() => newMemoryStoreAtRevision(-1)).toThrow(RangeError)
  expect(() => newMemoryStoreAtRevision(1.5)).toThrow(RangeError)
  expect(() => newMemoryStoreAtRevision(maximum + 1)).toThrow(RangeError)

  const store = newMemoryStoreAtRevision(maximum - 1)
  const admitted = await store.write(background(), {
    key: "stable",
    value: new Uint8Array([1])
  })
  expect(admitted.revision).toBe(String(maximum))
  await expect(
    store.write(background(), { key: "rejected", value: new Uint8Array([2]) })
  ).rejects.toBeInstanceOf(RangeError)
  await expect(store.delete(background(), "stable")).rejects.toBeInstanceOf(RangeError)
  expect(await store.read(background(), "stable")).not.toBeNull()
  expect(await store.read(background(), "rejected")).toBeNull()

  let now = 10
  const expiring = newMemoryStoreAtRevision(maximum - 1, [
    clock(function currentTime(): number {
      return now
    })
  ])
  await expiring.write(background(), { key: "ttl", value: new Uint8Array([1]) }, expiresIn(1))
  now = 11
  await expect(expiring.read(background(), "ttl")).rejects.toBeInstanceOf(RangeError)
  now = 10
  expect(await expiring.read(background(), "ttl")).not.toBeNull()
})

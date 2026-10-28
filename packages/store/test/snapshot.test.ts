import { expect, test } from "bun:test"

import type { StoreRecord } from "../src/index"
import {
  compareStoreKeys,
  snapshotStorePage,
  snapshotStoreRecord,
  snapshotStoreRecordInput
} from "../src/provider"

function record(key: string, value = new Uint8Array([1])): StoreRecord {
  return { key, value, metadata: { b: "2", a: "1" }, revision: "1", expiresAt: null }
}

test("record input and output snapshots detach bytes and metadata", () => {
  const bytes = new Uint8Array([1, 2])
  const metadata = { owner: "caller" }
  const input = snapshotStoreRecordInput({ key: "key", value: bytes, metadata })
  const output = snapshotStoreRecord({
    key: input.key,
    value: input.value,
    metadata: input.metadata ?? {},
    revision: "rev-1",
    expiresAt: 123
  })

  bytes[0] = 9
  metadata.owner = "changed"
  const exposedInput = input.value
  const exposedOutput = output.value
  exposedInput[0] = 8
  exposedOutput[0] = 7

  expect(input.value).toEqual(new Uint8Array([1, 2]))
  expect(output.value).toEqual(new Uint8Array([1, 2]))
  expect(input.metadata).toEqual({ owner: "caller" })
  expect(output.metadata).toEqual({ owner: "caller" })
  expect(Object.isFrozen(input)).toBe(true)
  expect(Object.isFrozen(output)).toBe(true)
  expect(Object.isFrozen(input.metadata)).toBe(true)
  expect(Object.isFrozen(output.metadata)).toBe(true)
  expect(snapshotStoreRecordInput({ key: "key", value: new Uint8Array() }).metadata).toEqual({})
})

test("page snapshots reject duplicates and sort by Unicode code point", () => {
  const first = record("\u{10000}")
  const second = record("\ue000")
  const page = snapshotStorePage({ records: [first, second], cursor: "next" })

  expect(page.records.map(({ key }) => key)).toEqual(["\ue000", "\u{10000}"])
  expect(page.cursor).toBe("next")
  expect(Object.isFrozen(page)).toBe(true)
  expect(Object.isFrozen(page.records)).toBe(true)
  expect(snapshotStorePage({ records: [], cursor: null })).toEqual({ records: [], cursor: null })
  expect(() => snapshotStorePage({ records: [first, first], cursor: null })).toThrow("unique")
})

test("code-point comparison handles equal, prefix, BMP, and supplementary keys", () => {
  expect(compareStoreKeys("a", "a")).toBe(0)
  expect(compareStoreKeys("a", "aa")).toBe(-1)
  expect(compareStoreKeys("aa", "a")).toBe(1)
  expect(compareStoreKeys("a", "b")).toBe(-1)
  expect(compareStoreKeys("b", "a")).toBe(1)
  expect(compareStoreKeys("\ue000", "\u{10000}")).toBe(-1)
  expect(() => compareStoreKeys("\ud800", "a")).toThrow(TypeError)
  expect(() => compareStoreKeys("a", "\udc00")).toThrow(TypeError)
})

test("snapshot boundaries reject malformed records, pages, and metadata", () => {
  expect(() => snapshotStoreRecordInput(null as never)).toThrow(TypeError)
  expect(() => snapshotStoreRecordInput({ key: "", value: new Uint8Array() })).toThrow(TypeError)
  expect(() => snapshotStoreRecordInput({ key: "\ud800", value: new Uint8Array() })).toThrow(
    TypeError
  )
  expect(() => snapshotStoreRecordInput({ key: "key", value: [] as never })).toThrow(TypeError)
  expect(() =>
    snapshotStoreRecordInput({ key: "key", value: new Uint8Array(), metadata: [] as never })
  ).toThrow(TypeError)
  expect(() =>
    snapshotStoreRecordInput({
      key: "key",
      value: new Uint8Array(),
      metadata: new Date() as never
    })
  ).toThrow("plain")
  expect(() =>
    snapshotStoreRecordInput({
      key: "key",
      value: new Uint8Array(),
      metadata: Object.defineProperty({}, "bad", { enumerable: true, get: () => "value" })
    })
  ).toThrow("data properties")
  expect(() =>
    snapshotStoreRecordInput({ key: "key", value: new Uint8Array(), metadata: { bad: 1 } as never })
  ).toThrow(TypeError)
  expect(() =>
    snapshotStoreRecordInput({
      key: "key",
      value: new Uint8Array(),
      metadata: { "\ud800": "value" }
    })
  ).toThrow(TypeError)
  expect(() => snapshotStoreRecord(null as never)).toThrow(TypeError)
  expect(() => snapshotStoreRecord({ ...record("key"), revision: "" })).toThrow(TypeError)
  expect(() => snapshotStoreRecord({ ...record("key"), expiresAt: -1 })).toThrow(RangeError)
  expect(() => snapshotStorePage(null as never)).toThrow(TypeError)
  expect(() => snapshotStorePage({ records: null as never, cursor: null })).toThrow(TypeError)
  expect(() => snapshotStorePage({ records: [], cursor: "" })).toThrow(TypeError)
})

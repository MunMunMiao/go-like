import { expect, test } from "bun:test"

import {
  append,
  clone,
  get,
  keys,
  merge,
  newMetadata,
  remove,
  set,
  values,
  type Metadata
} from "../src/index"

test("normalizes keys and preserves ordered immutable multi-values", () => {
  const source = ["first", "second"]
  const metadata = newMetadata({
    Emoji: "猫🐈",
    "Trace-ID": source,
    "trace-id": "third",
    Zone: "cn"
  })
  source[0] = "changed"

  expect(metadata).toEqual({
    emoji: ["猫🐈"],
    "trace-id": ["first", "second", "third"],
    zone: ["cn"]
  })
  expect(get(metadata, "TRACE-ID")).toBe("first")
  expect(values(metadata, "trace-id")).toEqual(["first", "second", "third"])
  expect(values(metadata, "missing")).toEqual([])
  expect(Object.isFrozen(values(metadata, "missing"))).toBe(true)
  expect(keys(metadata)).toEqual(["emoji", "trace-id", "zone"])
  expect(Object.isFrozen(metadata)).toBe(true)
  expect(Object.isFrozen(metadata["trace-id"])).toBe(true)

  const nullPrototype = Object.create(null)
  Object.defineProperty(nullPrototype, "Tenant", { enumerable: true, value: "one" })
  expect(newMetadata(nullPrototype)).toEqual({ tenant: ["one"] })
})

test("clones, appends, sets, removes, and merges without mutating inputs", () => {
  const base = newMetadata({ trace: ["one"], zone: "cn" })
  const cloned = clone(base)
  const appended = append(base, "TRACE", ["two", "three"])
  const replaced = set(appended, "TRACE", "replacement")
  const removed = remove(replaced, "ZONE")
  const merged = merge(removed, newMetadata({ trace: "merged", tenant: "a" }))

  expect(cloned).toEqual(base)
  expect(cloned).not.toBe(base)
  expect(cloned.trace).not.toBe(base.trace)
  expect(base).toEqual({ trace: ["one"], zone: ["cn"] })
  expect(appended).toEqual({ trace: ["one", "two", "three"], zone: ["cn"] })
  expect(replaced).toEqual({ trace: ["replacement"], zone: ["cn"] })
  expect(removed).toEqual({ trace: ["replacement"] })
  expect(merged).toEqual({ tenant: ["a"], trace: ["merged"] })
  expect(append(newMetadata(), "empty", "")).toEqual({ empty: [""] })
  expect(set(newMetadata(), "empty", "")).toEqual({ empty: [""] })
  expect(remove(newMetadata(), "missing")).toEqual({})

  const structural: Metadata = { External: ["value"] }
  expect(clone(structural)).toEqual({ external: ["value"] })
})

test("rejects malformed records, keys, values, and array carriers", () => {
  expect(() => newMetadata(null as never)).toThrow(TypeError)
  expect(() => newMetadata([] as never)).toThrow(TypeError)
  expect(() => newMetadata(new Date() as never)).toThrow(TypeError)

  const symbolRecord = { valid: "value", [Symbol("hidden")]: "value" }
  expect(() => newMetadata(symbolRecord)).toThrow("only string keys")

  const getterRecord = Object.defineProperty({}, "bad", {
    enumerable: true,
    get: () => "value"
  })
  expect(() => newMetadata(getterRecord as never)).toThrow("data properties")

  for (const key of ["", "\ud800", "\udfff"]) {
    expect(() => newMetadata({ [key]: "value" })).toThrow()
  }
  expect(() => remove(newMetadata(), "")).toThrow("non-empty well-formed")
  expect(() => set(newMetadata(), "key", 1 as never)).toThrow("well-formed")
  expect(() => newMetadata({ key: 1 as never })).toThrow("string or a string array")
  expect(() => newMetadata({ key: ["\ud800"] })).toThrow("well-formed")
  expect(() => newMetadata({ key: "\udfff" })).toThrow("well-formed")

  const sparse = Array(2)
  sparse[1] = "value"
  expect(() => newMetadata({ key: sparse })).toThrow("dense")

  const symbolArray = ["value"]
  Object.defineProperty(symbolArray, Symbol("hidden"), { value: "hidden" })
  expect(() => newMetadata({ key: symbolArray })).toThrow("dense")

  const getterArray = ["value"]
  Object.defineProperty(getterArray, "0", { enumerable: true, get: () => "value" })
  expect(() => newMetadata({ key: getterArray })).toThrow("data values")
})

test("accepts provider-neutral keys, controls, long values, and unbounded entry counts", () => {
  const input: Record<string, string | readonly string[]> = {}
  for (let index = 0; index < 128; index += 1) input[`key-${index}`] = String(index)
  const manyValues = Array.from({ length: 64 }, (_value, index) => String(index))
  const longKey = `LONG ${"键".repeat(512)} / value`
  const longValue = "值".repeat(20_000)
  input.Empty = []
  input[longKey] = longValue
  input.Many = manyValues
  input["Not A Header / 用户"] = "line\nbreak\tallowed"
  const metadata = newMetadata(input)

  expect(keys(metadata)).toHaveLength(132)
  expect(values(metadata, "many")).toHaveLength(64)
  expect(get(metadata, longKey)).toBe(longValue)
  expect(get(metadata, "not a header / 用户")).toBe("line\nbreak\tallowed")
  expect(keys(metadata)).toContain("empty")
  expect(values(metadata, "empty")).toEqual([])
})

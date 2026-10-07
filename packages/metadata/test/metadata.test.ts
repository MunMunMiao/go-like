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
  expect(Object.isFrozen(cloned)).toBe(true)
  expect(Object.isFrozen(cloned.trace)).toBe(true)
  expect(cloned.trace).toEqual(base.trace)
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

test("clone copies the record of a branded snapshot and reuses its frozen value arrays", () => {
  const base = newMetadata({ trace: ["one", "two"], zone: "cn" })
  const cloned = clone(base)

  expect(cloned).not.toBe(base)
  expect(cloned.trace).toBe(base.trace)
  expect(cloned.zone).toBe(base.zone)
  expect(clone(cloned).trace).toBe(base.trace)

  const fromStructural = clone({ Trace: ["one"] })
  expect(clone(fromStructural).trace).toBe(fromStructural.trace)
})

test("clone preserves key order, integer-like keys, and own __proto__ and constructor data properties", () => {
  const base = newMetadata(
    Object.fromEntries([
      ["b", "b"],
      ["10", "ten"],
      ["2", "two"],
      ["1", "one"],
      ["constructor", "own-constructor"],
      ["__proto__", ["proto-one", "proto-two"]],
      ["a", ["a-one", "a-two"]]
    ])
  )
  const cloned = clone(base)
  const order = ["1", "2", "10", "__proto__", "a", "b", "constructor"]

  expect(Object.keys(base)).toEqual(order)
  expect(Object.keys(cloned)).toEqual(order)
  expect(keys(cloned)).toEqual(order)
  expect(Reflect.ownKeys(cloned)).toEqual(order)
  expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype)
  expect(Object.getOwnPropertyDescriptors(cloned)).toEqual(Object.getOwnPropertyDescriptors(base))
  expect(Object.getOwnPropertyDescriptor(cloned, "__proto__")).toEqual({
    value: ["proto-one", "proto-two"],
    writable: false,
    enumerable: true,
    configurable: false
  })
  expect(values(cloned, "__proto__")).toEqual(["proto-one", "proto-two"])
  expect(get(cloned, "constructor")).toBe("own-constructor")
  expect(values(cloned, "a")).toEqual(["a-one", "a-two"])
})

test("clone never trusts a Proxy, an inheriting object, or a frozen lookalike of a branded snapshot", () => {
  const base = newMetadata({ alpha: ["one"], beta: ["two", "three"], gamma: "four" })
  const reversed = new Proxy(base, {
    ownKeys: (target) => Reflect.ownKeys(target).reverse()
  })
  expect(Object.keys(reversed)).toEqual(["gamma", "beta", "alpha"])

  const viaProxy = clone(reversed)
  expect(Object.keys(viaProxy)).toEqual(["alpha", "beta", "gamma"])
  expect(viaProxy).toEqual(base)
  expect(viaProxy.beta).not.toBe(base.beta)
  expect(Object.isFrozen(viaProxy)).toBe(true)
  expect(Object.isFrozen(viaProxy.beta)).toBe(true)

  expect(() => clone(Object.create(base) as Metadata)).toThrow("plain record")

  const mutable = ["one"]
  const lookalike: Metadata = Object.freeze({ Trace: mutable, zone: Object.freeze(["cn"]) })
  const viaLookalike = clone(lookalike)
  mutable[0] = "changed"
  mutable.push("extra")

  expect(viaLookalike).toEqual({ trace: ["one"], zone: ["cn"] })
  expect(viaLookalike.zone).not.toBe(lookalike.zone)
  expect(Object.isFrozen(viaLookalike.trace)).toBe(true)

  const unsorted: Metadata = Object.freeze({ b: Object.freeze(["two"]), a: Object.freeze(["one"]) })
  expect(Object.keys(clone(unsorted))).toEqual(["a", "b"])
  expect(() => clone(Object.freeze({ trace: Object.freeze([1]) }) as never)).toThrow(TypeError)
})

test("clone results and their value arrays reject mutation and never affect the source", () => {
  const base = newMetadata({ trace: ["one", "two"], zone: "cn" })
  const cloned = clone(base)
  const record = cloned as Record<string, unknown>
  const trace = cloned.trace as string[]

  expect(() => {
    record.trace = []
  }).toThrow(TypeError)
  expect(() => {
    record.added = ["value"]
  }).toThrow(TypeError)
  expect(() => {
    delete record.zone
  }).toThrow(TypeError)
  expect(() => Object.defineProperty(record, "zone", { value: ["changed"] })).toThrow(TypeError)
  expect(() => Object.setPrototypeOf(record, null)).toThrow(TypeError)
  expect(() => {
    trace[0] = "changed"
  }).toThrow(TypeError)
  expect(() => trace.push("three")).toThrow(TypeError)
  expect(() => trace.pop()).toThrow(TypeError)
  expect(() => {
    trace.length = 0
  }).toThrow(TypeError)

  for (const snapshot of [base, cloned]) {
    expect(snapshot).toEqual({ trace: ["one", "two"], zone: ["cn"] })
    expect(Object.keys(snapshot)).toEqual(["trace", "zone"])
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.trace)).toBe(true)
    expect(Object.isFrozen(snapshot.zone)).toBe(true)
  }
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

test("values and get ignore keys inherited from Object.prototype", () => {
  const snapshot = newMetadata({ a: "1" })
  const structural: Metadata = { a: ["1"] }
  const empty = values(snapshot, "missing")
  const inherited = Object.getOwnPropertyNames(Object.prototype)
  expect(inherited).toContain("constructor")
  expect(inherited).toContain("__proto__")

  for (const source of [snapshot, structural]) {
    for (const key of inherited.flatMap((name) => [name, name.toUpperCase()])) {
      expect(values(source, key)).toBe(empty)
      expect(get(source, key)).toBeNull()
    }
  }
  expect(empty).toEqual([])
  expect(Object.isFrozen(empty)).toBe(true)
})

test("values and get still read own constructor and __proto__ keys", () => {
  const own = newMetadata(
    Object.fromEntries([
      ["constructor", ["own-one", "own-two"]],
      ["__proto__", "own-proto"]
    ])
  )

  expect(values(own, "constructor")).toEqual(["own-one", "own-two"])
  expect(values(own, "CONSTRUCTOR")).toEqual(["own-one", "own-two"])
  expect(get(own, "constructor")).toBe("own-one")
  expect(values(own, "__proto__")).toEqual(["own-proto"])
  expect(get(own, "__proto__")).toBe("own-proto")
  expect(get(Object.fromEntries([["__proto__", ["structural"]]]), "__proto__")).toBe("structural")
})

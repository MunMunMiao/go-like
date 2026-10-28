import { describe, expect, test } from "bun:test"
import { decodeJson, encodeJson } from "../src/codec/json"
import { StructError, struct } from "../src/index"
import { encodeStructValue, parseStructTuple as parse } from "../src/introspection"
import type { StructLike } from "../src/types"
import { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "../src/value-graph"

function nestedValue(depth: number): unknown {
  let value: unknown = null
  for (let index = 0; index < depth; index += 1) {
    value = { next: value }
  }
  return value
}

describe("parse.ts prototype pollution defense", () => {
  test("parseObjectValue strips __proto__ without polluting Object.prototype", () => {
    const s = struct.object({})
    const [err, val] = parse(s, JSON.parse('{"__proto__":{"polluted":true}}'))
    if (err) {
      throw err
    }
    expect((Object.prototype as { [key: string]: unknown })["polluted"]).toBeUndefined()
    expect(Object.hasOwn(val as object, "__proto__")).toBe(false)
  })

  test("parseRecordValue does not pollute Object.prototype", () => {
    const s = struct.record(struct.any())
    parse(s, JSON.parse('{"__proto__":{"polluted":true}}'))
    expect((Object.prototype as { [key: string]: unknown })["polluted"]).toBeUndefined()
  })

  test("parsed object output has null prototype(Object.create(null))", () => {
    const s = struct.object({ x: struct.string() })
    const [err, val] = parse(s, { x: "hi" })
    if (err) {
      throw err
    }
    expect(Object.getPrototypeOf(val)).toBeNull()
  })

  test("parsed record output has null prototype", () => {
    const s = struct.record(struct.string())
    const [err, val] = parse(s, { k: "v" })
    if (err) {
      throw err
    }
    expect(Object.getPrototypeOf(val)).toBeNull()
  })

  test('"__proto__" key preserved as own property under record output', () => {
    const s = struct.record(struct.any())
    const [err, val] = parse(s, JSON.parse('{"__proto__":"data"}'))
    if (err) {
      throw err
    }
    expect(Object.hasOwn(val as object, "__proto__")).toBe(true)
    expect((val as { [key: string]: unknown })["__proto__"]).toBe("data")
  })

  test("parseObjectValue ignores inherited declared fields", () => {
    const s = struct.object({ pollutedId: struct.string() })
    Object.defineProperty(Object.prototype, "pollutedId", {
      configurable: true,
      value: "admin"
    })

    try {
      const [err, val] = parse(s, {})
      expect(err).toBeInstanceOf(StructError)
      expect(err?.issues[0]?.code).toBe("missing_key")
      expect(val).toBeUndefined()
    } finally {
      delete (Object.prototype as { [key: string]: unknown })["pollutedId"]
    }
  })

  test("parseObjectValue ignores inherited declared fields in plain input", () => {
    const s = struct.object({ pollutedId: struct.string() })
    Object.defineProperty(Object.prototype, "pollutedId", {
      configurable: true,
      value: "admin"
    })

    try {
      const [err, val] = parse(s, {})
      expect(err).toBeInstanceOf(StructError)
      expect(err?.issues[0]?.code).toBe("missing_key")
      expect(val).toBeUndefined()
    } finally {
      delete (Object.prototype as { [key: string]: unknown })["pollutedId"]
    }
  })

  test("decodeJson ignores inherited wire keys", () => {
    const s = struct.object({
      name: struct.string().alias("user_name")
    })
    const wire = Object.create({ user_name: "admin" })

    expect(() => decodeJson(s, wire)).toThrow(StructError)
  })

  test("JSON aliases for dangerous keys do not pollute prototypes", () => {
    const dangerousStruct = struct.object({
      constructorValue: struct.string().alias("constructor"),
      protoValue: struct.string().alias("__proto__")
    })

    const encoded = encodeJson(dangerousStruct, {
      constructorValue: "ctor",
      protoValue: "proto"
    }) as { [key: string]: unknown }
    expect(Object.hasOwn(encoded, "__proto__")).toBe(true)
    expect(Object.hasOwn(encoded, "constructor")).toBe(true)
    expect(encoded["__proto__"]).toBe("proto")
    expect(encoded["constructor"]).toBe("ctor")
    expect((Object.prototype as { [key: string]: unknown })["proto"]).toBeUndefined()

    const decoded = decodeJson(
      dangerousStruct,
      JSON.parse('{"__proto__":"proto","constructor":"ctor"}')
    )
    expect(decoded).toEqual({ constructorValue: "ctor", protoValue: "proto" })
    expect(Object.getPrototypeOf(decoded)).toBeNull()
    expect((Object.prototype as { [key: string]: unknown })["proto"]).toBeUndefined()
  })

  test("keeps dangerous wire keys as own data properties during alias decode", () => {
    const Payload = struct.object({
      proto: struct.string().alias("__proto__"),
      constructorValue: struct.string().alias("constructor")
    })

    const raw: { [key: string]: unknown } = Object.create(null)
    raw["__proto__"] = "safe"
    raw["constructor"] = "value"

    const output = decodeJson(Payload, raw)

    expect(output).toEqual({ proto: "safe", constructorValue: "value" })
    expect(({} as { proto?: string }).proto).toBeUndefined()
  })

  test("accepts 1000 value containers and rejects 1001 without RangeError", () => {
    const node = struct.object({
      get next(): StructLike<unknown, unknown, boolean> {
        return node.null()
      }
    })

    expect(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT).toBe(1000)
    const [accepted] = parse(node, nestedValue(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT))
    const [rejected] = parse(node, nestedValue(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1))

    expect(accepted).toBeNull()
    expect(rejected).not.toBeNull()
    expect(rejected).not.toBeInstanceOf(RangeError)

    expect(() =>
      encodeStructValue(node, nestedValue(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT))
    ).not.toThrow()
    let encodeError: unknown
    try {
      encodeStructValue(node, nestedValue(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1))
    } catch (error) {
      encodeError = error
    }
    expect(encodeError).toBeInstanceOf(Error)
    expect(encodeError).not.toBeInstanceOf(RangeError)
  })

  test("rejects cyclic parse and encode graphs without RangeError", () => {
    const node = struct.object({
      get next(): StructLike<unknown, unknown, boolean> {
        return node.null()
      }
    })
    const value: { next?: unknown } = {}
    value.next = value

    const [parseError] = parse(node, value)
    expect(parseError).not.toBeNull()
    expect(parseError).not.toBeInstanceOf(RangeError)

    let encodeError: unknown
    try {
      encodeStructValue(node, value)
    } catch (error) {
      encodeError = error
    }
    expect(encodeError).toBeInstanceOf(Error)
    expect(encodeError).not.toBeInstanceOf(RangeError)
  })

  test("rejects a getter cycle with StructError instead of RangeError", () => {
    const node = struct.object({
      get next(): StructLike<unknown, unknown, boolean> {
        return node.null()
      }
    })
    const cyclic = {
      get next(): unknown {
        return cyclic
      }
    }

    const [error] = parse(node, cyclic)

    expect(error).toBeInstanceOf(StructError)
    expect(error).not.toBeInstanceOf(RangeError)
    expect(error?.message).toBe("struct value contains a cycle")
  })

  test("rejects a getter chain past the portable depth limit and accepts 1000", () => {
    const node = struct.object({
      get next(): StructLike<unknown, unknown, boolean> {
        return node.null()
      }
    })

    let acceptedValue: unknown = null
    for (let index = 0; index < PORTABLE_VALUE_GRAPH_DEPTH_LIMIT; index += 1) {
      const child = acceptedValue
      acceptedValue = {
        get next(): unknown {
          return child
        }
      }
    }
    let rejectedValue: unknown = null
    for (let index = 0; index < PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1; index += 1) {
      const child = rejectedValue
      rejectedValue = {
        get next(): unknown {
          return child
        }
      }
    }

    const [accepted] = parse(node, acceptedValue)
    const [rejected] = parse(node, rejectedValue)

    expect(accepted).toBeNull()
    expect(rejected).toBeInstanceOf(StructError)
    expect(rejected).not.toBeInstanceOf(RangeError)
    expect(rejected?.message).toBe(
      `struct value exceeds portable container depth limit ${PORTABLE_VALUE_GRAPH_DEPTH_LIMIT}`
    )
  })

  test("security prescan does not invoke getters after the first failing field", () => {
    let reads = 0
    const input = {
      first: 1,
      get second(): string {
        reads += 1
        return "later"
      }
    }

    const [error] = parse(struct.object({ first: struct.string(), second: struct.string() }), input)

    expect(error).toBeInstanceOf(StructError)
    expect(error?.issues).toHaveLength(1)
    expect(reads).toBe(0)
  })
})

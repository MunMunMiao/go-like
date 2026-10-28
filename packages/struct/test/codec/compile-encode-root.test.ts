import { expect, test } from "bun:test"

import { encodeParsedJson, encodeValidatedJson } from "../../src/codec/json"
import { StructError } from "../../src/errors"
import { struct } from "../../src/index"
import { parseStructValue } from "../../src/introspection"
import type { AnyStructLike } from "../../src/types"
import { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "../../src/value-graph"

function outcome(run: () => unknown): string {
  try {
    return `ok:${JSON.stringify(run())}`
  } catch (error) {
    if (error instanceof StructError) {
      return `struct:${error.name}:${error.message}:${JSON.stringify(error.issues.map((issue) => issue.path))}`
    }
    if (error instanceof Error) return `throw:${error.name}:${error.message}`
    return `throw:${String(error)}`
  }
}

function oracle(schema: AnyStructLike, input: unknown): unknown {
  return encodeParsedJson(schema, parseStructValue(schema, input))
}

function expectSame(schema: AnyStructLike, input: unknown): void {
  expect(outcome(() => encodeValidatedJson(schema, input))).toBe(
    outcome(() => oracle(schema, input))
  )
}

function cycle(): { self?: unknown } {
  const value: { self?: unknown } = {}
  value.self = value
  return value
}

test("encode root corner edges match the interpreter", () => {
  const idSchema = struct.object({ id: struct.string() })
  const pair = struct.object({ a: struct.string(), b: struct.string().optional() })
  const numbers = struct.array(struct.number())
  const optionalNumbers = struct.array(struct.number().optional())
  const text = struct.array(struct.string())

  const nullProto = Object.create(null) as { extra?: number; id: string }
  nullProto.id = "i"
  expectSame(idSchema, nullProto)
  const nullProtoExtra = Object.create(null) as { extra?: number; id: string }
  nullProtoExtra.id = "i"
  nullProtoExtra.extra = 1
  expectSame(idSchema, nullProtoExtra)

  const protoKey = Object.create(null) as { __proto__?: string; id: string }
  protoKey["__proto__"] = "p"
  protoKey.id = "i"
  expectSame(struct.object({ ["__proto__"]: struct.string(), id: struct.string() }), protoKey)

  expectSame(struct.object({ a: struct.string() }), Object.freeze({ a: "x" }))
  expectSame(struct.object({ a: struct.string() }), Object.freeze({ a: "x", extra: 1 }))
  expectSame(pair, { a: "x" })
  expectSame(pair, { a: "x", b: undefined })

  const hidden = { id: "a" }
  Object.defineProperty(hidden, "secret", { enumerable: false, value: cycle() })
  expectSame(idSchema, hidden)

  const symbolic = { id: "a" } as { id: string } & { [key: symbol]: unknown }
  symbolic[Symbol("secret")] = cycle()
  expectSame(idSchema, symbolic)

  const hole = [1]
  hole.length = 3
  hole[2] = 2
  expectSame(optionalNumbers, hole)
  expectSame(numbers, hole)

  const sparse: string[] = []
  sparse[4] = "a"
  expectSame(struct.array(struct.string().optional()), sparse)

  const extraData = [1, 2] as number[] & { extra?: number }
  extraData.extra = 1
  expectSame(numbers, extraData)

  const extraCycle = [1] as number[] & { extra?: unknown }
  extraCycle.extra = cycle()
  expectSame(numbers, extraCycle)

  const leadingZero = [1, 2] as number[]
  Object.defineProperty(leadingZero, "01", { configurable: true, enumerable: true, value: 9 })
  expectSame(numbers, leadingZero)

  const emptyKey = [1, 2] as number[]
  Object.defineProperty(emptyKey, "", { configurable: true, enumerable: true, value: 9 })
  expectSame(numbers, emptyKey)

  const longKey = [1, 2] as number[]
  Object.defineProperty(longKey, "12345678901", {
    configurable: true,
    enumerable: true,
    value: 9
  })
  expectSame(numbers, longKey)

  const maxIndex = [1, 2] as number[]
  Object.defineProperty(maxIndex, "4294967295", {
    configurable: true,
    enumerable: true,
    value: cycle()
  })
  expectSame(numbers, maxIndex)

  expectSame(struct.object({ a: struct.string() }), ["x"])
  expectSame(text, { 0: "a" })
  expectSame(struct.string(), { a: 1 })
  expectSame(struct.string(), cycle())
  expectSame(text, "no")
  class Box {
    a = "x"
  }
  expectSame(struct.object({ a: struct.string() }), new Box())
  expectSame(struct.object({}), {})
  expectSame(struct.object({}), { leftover: cycle() })
  expectSame(struct.object({ a: struct.string(), b: struct.string() }), { a: "x", extra: cycle() })
  expectSame(struct.array(struct.object({ a: struct.string() })), [{ a: "x", extra: 1 }])
  expectSame(struct.array(struct.object({ a: struct.string() })), [{ a: "x", extra: cycle() }])
  expectSame(struct.object({ a: struct.any() }), { a: 1 })
  expectSame(struct.object({ a: struct.any() }), { a: cycle() })
  expectSame(struct.object({ payload: struct.unknown() }), { payload: "ok" })

  const protoKeyName = "likegoSlice3Proto"
  const protoCycle = cycle()
  Object.defineProperty(Object.prototype, protoKeyName, {
    configurable: true,
    enumerable: true,
    value: protoCycle
  })
  try {
    expectSame(idSchema, { id: "a" })
    expectSame(text, ["a"])
    const inheritedOnly = Object.create({ id: "no", extra: cycle() }) as { id?: string }
    expectSame(idSchema, inheritedOnly)
  } finally {
    delete (Object.prototype as { [key: string]: unknown })[protoKeyName]
  }
})

test("encode root corner leaf cycle does not read a later getter", () => {
  const schema = struct.object({ b: struct.string(), a: struct.string() })
  let reads = 0
  const input = { a: cycle() } as { a: unknown; b?: string }
  Object.defineProperty(input, "b", {
    enumerable: true,
    get() {
      reads += 1
      return "x"
    }
  })

  const actual = outcome(() => encodeValidatedJson(schema, input))
  expect(reads).toBe(0)
  expect(actual).toBe(outcome(() => oracle(schema, input)))
  expect(reads).toBe(0)
})

test("encode root corner unknown-field cycle does not read declared getters", () => {
  const schema = struct.object({ id: struct.string() })
  let reads = 0
  const input = { extra: cycle() } as { extra: unknown; id?: string }
  Object.defineProperty(input, "id", {
    enumerable: true,
    get() {
      reads += 1
      return "x"
    }
  })

  const actual = outcome(() => encodeValidatedJson(schema, input))
  expect(reads).toBe(0)
  expect(actual).toBe(outcome(() => oracle(schema, input)))
  expect(reads).toBe(0)
})

test("encode root corner declared depth matches the interpreter", () => {
  const limit = PORTABLE_VALUE_GRAPH_DEPTH_LIMIT
  let schema: AnyStructLike = struct.object({ end: struct.boolean() })
  let within: unknown = { end: true }
  for (let index = 1; index < limit; index += 1) {
    schema = struct.object({ child: schema })
    within = { child: within }
  }
  expectSame(schema, within)
  expectSame(struct.object({ child: schema }), { child: within })
})

test("encode root corner undeclared key still calls Object.keys", () => {
  const schema = struct.object({ id: struct.string(), n: struct.number() })
  encodeValidatedJson(schema, { id: "warm", n: 1 })
  const input = { extra: 1, id: "a", n: 2 }
  const original = Object.keys
  let calls = 0
  Object.keys = ((value: object) => {
    if (value === input) calls += 1
    return original(value)
  }) as typeof Object.keys
  try {
    expect(encodeValidatedJson(schema, input)).toEqual({ id: "a", n: 2 })
    expect(calls).toBeGreaterThan(0)
  } finally {
    Object.keys = original
  }
})

test("clean value does not call Object.keys during encode", () => {
  const schema = struct.object({
    id: struct.string(),
    n: struct.number(),
    child: struct.object({ a: struct.string() }),
    tags: struct.array(struct.string())
  })
  encodeValidatedJson(schema, { child: { a: "z" }, id: "warm", n: 0, tags: ["z"] })
  const input = { child: { a: "b" }, id: "a", n: 1, tags: ["x"] }
  const marked = new WeakSet<object>()
  marked.add(input)
  marked.add(input.child)
  marked.add(input.tags)
  const original = Object.keys
  let calls = 0
  Object.keys = ((value: object) => {
    if (marked.has(value)) calls += 1
    return original(value)
  }) as typeof Object.keys
  try {
    const encoded = encodeValidatedJson(schema, input)
    expect(calls).toBe(0)
    expect(encoded).toEqual({ child: { a: "b" }, id: "a", n: 1, tags: ["x"] })
  } finally {
    Object.keys = original
  }
})

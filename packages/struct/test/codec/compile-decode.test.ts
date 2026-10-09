import { describe, expect, test } from "bun:test"

import { decodeJson, decodeJsonTree } from "../../src/codec/json"
import { compileJsonDecoder } from "../../src/compile-decode"
import { StructError } from "../../src/errors"
import { struct } from "../../src/index"
import { createPrimitiveStruct } from "../../src/runtime"
import { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "../../src/value-graph"

describe("compileJsonDecoder", () => {
  test("compileJsonDecoder returns a fast path for supported schemas", () => {
    const id = struct.string()
    const address = struct.object({
      city: struct.string(),
      zip: struct.string().nullable()
    })
    const firstAddress = compileJsonDecoder(address)
    const schema = struct.object({
      id,
      name: struct.string().optional(),
      note: struct.string().nullish(),
      active: struct.boolean(),
      count: struct.number(),
      empty: struct.null(),
      tag: struct.literal("ok"),
      off: struct.literal(false),
      none: struct.literal(null),
      status: struct.enum(["new", "paid"]),
      code: struct.enum({ a: 1, b: 2 }),
      flags: struct.array(struct.boolean()),
      shipTo: address,
      billTo: address,
      payload: struct.any(),
      extra: struct.unknown(),
      blob: struct.blob(),
      file: struct.file(),
      bytes: struct.arrayBuffer(),
      maybe: struct.number().nullable()
    })

    const decoder = compileJsonDecoder(schema)
    expect(typeof decoder).toBe("function")
    expect(compileJsonDecoder(schema)).toBe(decoder)
    expect(compileJsonDecoder(id)).toEqual(expect.any(Function))
    expect(firstAddress).toEqual(expect.any(Function))
    expect(compileJsonDecoder(address)).toBe(firstAddress)
    expect(compileJsonDecoder(struct.object({}))).toEqual(expect.any(Function))
    expect(compileJsonDecoder(struct.array(struct.string()))).toEqual(expect.any(Function))
  })

  test("compileJsonDecoder rejects unsupported schemas", () => {
    const recursive = struct.object({
      id: struct.string(),
      get child() {
        return struct.array(recursive)
      }
    })
    const decoded = createPrimitiveStruct({
      decode: (value: string) => ({ ok: true as const, value }),
      expected: "string",
      is: (value): value is string => typeof value === "string",
      kind: "string"
    })
    const encoded = createPrimitiveStruct({
      encode: (value: string) => value,
      expected: "string",
      is: (value): value is string => typeof value === "string",
      kind: "string"
    })
    const cases = [
      struct.or(struct.string(), struct.number()),
      struct.discriminatedUnion("kind", [
        struct.object({ kind: struct.literal("a"), n: struct.number() }),
        struct.object({ kind: struct.literal("b"), s: struct.string() })
      ]),
      struct.intersection(
        struct.object({ a: struct.string() }),
        struct.object({ b: struct.number() })
      ),
      struct.tuple([struct.string(), struct.number()]),
      struct.record(struct.string()),
      struct.bigint(),
      struct.date(),
      struct.string().alias("wire"),
      struct.string().alias(""),
      struct.object({ name: struct.string().alias("full_name") }),
      struct.array(struct.date()),
      struct.array(struct.object({ name: struct.string().alias("full_name") })),
      recursive,
      struct.object({ child: recursive }),
      decoded,
      encoded,
      struct.object({ hooked: decoded })
    ]

    for (const schema of cases) {
      expect(compileJsonDecoder(schema)).toBeNull()
      expect(compileJsonDecoder(schema)).toBeNull()
    }
    expect(compileJsonDecoder({} as never)).toBeNull()
    expect(compileJsonDecoder(1 as never)).toBeNull()

    const plain = struct.string()
    expect(compileJsonDecoder(plain.alias("wire"))).toBeNull()
    expect(compileJsonDecoder(plain)).toEqual(expect.any(Function))
  })
})

test("decodeJson still accepts non-JSON values on the interpreter", () => {
  const schema = struct.object({ id: struct.string() })
  let reads = 0
  const input = Object.defineProperty({}, "id", {
    enumerable: true,
    get() {
      reads += 1
      return "ada"
    }
  })

  expect(decodeJson(schema, input)).toEqual({ id: "ada" })
  expect(reads).toBe(1)
  expect(Object.getPrototypeOf(decodeJson(schema, input))).toBeNull()
})

function countedKindTree(): { reads: () => number; tree: { [key: string]: unknown } } {
  let count = 0
  const tree: { [key: string]: unknown } = {
    id: "x-1",
    qty: 3,
    tags: ["p", "q", "r"]
  }
  Object.defineProperty(tree, "kind", {
    enumerable: true,
    get() {
      count += 1
      return "a"
    }
  })
  return { reads: () => count, tree }
}

function thrown(run: () => unknown): unknown {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}

function nestedExtra(depth: number): { [key: string]: unknown } {
  let value: { [key: string]: unknown } = { id: "leaf" }
  for (let index = 1; index < depth; index += 1) value = { id: "x", extra: value }
  return value
}

test("uncompilable schema getter reads match decodeJson", () => {
  const schema = struct.object({
    id: struct.string(),
    kind: struct.or(struct.literal("a"), struct.literal("b")),
    qty: struct.number(),
    tags: struct.array(struct.string())
  })
  const interpreter = countedKindTree()
  const compiled = countedKindTree()

  expect(decodeJson(schema, interpreter.tree)).toEqual({
    id: "x-1",
    kind: "a",
    qty: 3,
    tags: ["p", "q", "r"]
  })
  expect(decodeJsonTree(schema, compiled.tree)).toEqual({
    id: "x-1",
    kind: "a",
    qty: 3,
    tags: ["p", "q", "r"]
  })
  expect(interpreter.reads()).toBeGreaterThan(0)
  expect(compiled.reads()).toBe(interpreter.reads())
})

test("uncompilable schema past portable depth matches decodeJson StructError", () => {
  const schema = struct.object({
    id: struct.string(),
    extra: struct.or(struct.string(), struct.number())
  })
  const over = nestedExtra(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1)
  const fromJson = thrown(() => decodeJson(schema, over))
  const fromTree = thrown(() => decodeJsonTree(schema, over))

  expect(fromJson).toBeInstanceOf(StructError)
  expect(fromTree).toBeInstanceOf(StructError)
  const left = fromJson as StructError
  const right = fromTree as StructError
  expect(right.name).toBe(left.name)
  expect(right.message).toBe(left.message)
  expect(right.issues).toEqual(left.issues)
})

test("non-struct decodeJsonTree matches decodeJson TypeError", () => {
  const tree = { x: 1 }
  const fromJson = thrown(() => decodeJson({} as never, tree))
  const fromTree = thrown(() => decodeJsonTree({} as never, tree))

  expect(fromJson).toBeInstanceOf(TypeError)
  expect(fromTree).toBeInstanceOf(TypeError)
  expect((fromTree as TypeError).name).toBe((fromJson as TypeError).name)
  expect((fromTree as TypeError).message).toBe((fromJson as TypeError).message)
})

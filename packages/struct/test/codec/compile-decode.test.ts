import { describe, expect, test } from "bun:test"

import { decodeJson, decodeJsonTree } from "../../src/codec/json"
import { compileJsonDecoder } from "../../src/compile-decode"
import { StructError } from "../../src/errors"
import { struct } from "../../src/index"
import { parseStructQuiet, parseValue } from "../../src/parse"
import { createPrimitiveStruct } from "../../src/runtime"
import { DEFINITION, OMIT } from "../../src/symbols"
import type { AnyStructLike, RuntimeStruct } from "../../src/types"
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

  test("compileJsonDecoder compiles islands, unions, aliases, and hooks", () => {
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
    const samples: Array<[AnyStructLike, unknown]> = [
      [struct.or(struct.string(), struct.number()), "ok"],
      [
        struct.discriminatedUnion("kind", [
          struct.object({ kind: struct.literal("a"), n: struct.number() }),
          struct.object({ kind: struct.literal("b"), s: struct.string() })
        ]),
        { kind: "b", s: "ok" }
      ],
      [
        struct.intersection(
          struct.object({ a: struct.string() }),
          struct.object({ b: struct.number() })
        ),
        { a: "ok", b: 1 }
      ],
      [struct.tuple([struct.string(), struct.number()]), ["a", 1]],
      [struct.record(struct.string()), { a: "z" }],
      [struct.bigint(), "12"],
      [struct.date(), "2020-01-01T00:00:00.000Z"],
      [struct.string().alias("wire"), "hi"],
      [struct.string().alias(""), "hi"],
      [struct.object({ name: struct.string().alias("full_name") }), { full_name: "Ada" }],
      [struct.array(struct.date()), ["2020-01-01T00:00:00.000Z"]],
      [
        struct.array(struct.object({ name: struct.string().alias("full_name") })),
        [{ full_name: "Ada" }]
      ],
      [decoded, "hi"],
      [encoded, "hi"],
      [struct.object({ hooked: decoded }), { hooked: "hi" }]
    ]

    for (const [schema, input] of samples) {
      const decoder = compileJsonDecoder(schema)
      expect(decoder).toEqual(expect.any(Function))
      expect(compileJsonDecoder(schema)).toBe(decoder)
      expect(decodeJsonTree(schema, input)).toEqual(decodeJson(schema, input))
    }
    expect(compileJsonDecoder({} as never)).toBeNull()
    expect(compileJsonDecoder(1 as never)).toBeNull()

    const plain = struct.string()
    const aliased = plain.alias("wire")
    expect(compileJsonDecoder(aliased)).toEqual(expect.any(Function))
    expect(compileJsonDecoder(plain)).toEqual(expect.any(Function))
    expect(decodeJsonTree(aliased, "wire")).toBe(decodeJson(plain, "wire"))
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

test("or field schema getter is read by the depth walk and the field", () => {
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
  expect(interpreter.reads()).toBe(1)
  expect(compiled.reads()).toBe(2)
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

test("json tree depth walk reads sibling getters before descending", () => {
  const schema = struct.object({
    a: struct.object({ n: struct.number() }),
    b: struct.object({ m: struct.number() })
  })
  const seen: string[] = []
  const tree = {
    get a() {
      seen.push("a")
      return {
        get n() {
          seen.push("n")
          return 1
        }
      }
    },
    get b() {
      seen.push("b")
      return {
        get m() {
          seen.push("m")
          return 2
        }
      }
    }
  }

  expect(decodeJsonTree(schema, tree)).toEqual({ a: { n: 1 }, b: { m: 2 } })
  expect(seen).toEqual(["b", "a", "n", "m", "a", "n", "b", "m"])
})

test("compileJsonDecoder rejects non-objects", () => {
  expect(compileJsonDecoder(null as never)).toBeNull()
  expect(compileJsonDecoder(undefined as never)).toBeNull()
  expect(compileJsonDecoder(1 as never)).toBeNull()
  expect(compileJsonDecoder("no" as never)).toBeNull()
})

test("cached or schema does not re-read its definition", () => {
  const schema = struct.object({
    kind: struct.or(struct.literal("a"), struct.literal("b"))
  })
  const decoder = compileJsonDecoder(schema)
  expect(decoder).toEqual(expect.any(Function))
  const definition = (schema as RuntimeStruct)[DEFINITION]
  let reads = 0
  Object.defineProperty(schema, DEFINITION, {
    configurable: true,
    get() {
      reads += 1
      return definition
    }
  })

  expect(compileJsonDecoder(schema)).toBe(decoder)
  expect(reads).toBe(0)
})

test("cached decoder does not re-read its definition", () => {
  const schema = struct.object({ id: struct.string() })
  const decoder = compileJsonDecoder(schema)
  expect(decoder).toBeTypeOf("function")
  const definition = (schema as RuntimeStruct)[DEFINITION]
  let reads = 0
  Object.defineProperty(schema, DEFINITION, {
    configurable: true,
    get() {
      reads += 1
      return definition
    }
  })

  expect(compileJsonDecoder(schema)).toBe(decoder)
  expect(reads).toBe(0)
})

function asRuntime(value: AnyStructLike): RuntimeStruct {
  return value as RuntimeStruct
}

function burySchema(inner: AnyStructLike, levels: number): AnyStructLike {
  let schema = inner
  for (let index = 0; index < levels; index += 1) {
    schema = struct.object({ extra: schema as never })
  }
  return schema
}

function buryValue(inner: unknown, levels: number): unknown {
  let value = inner
  for (let index = 0; index < levels; index += 1) value = { extra: value }
  return value
}

function nestedArrays(depth: number): unknown {
  let value: unknown = "leaf"
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

test("or field schema compiles and matches the interpreter", () => {
  const schema = struct.object({
    id: struct.string(),
    kind: struct.or(struct.literal("a"), struct.literal("b")),
    qty: struct.number(),
    tags: struct.array(struct.string())
  })
  const input: unknown = JSON.parse('{"tags":["p","q"],"qty":3,"extra":true,"kind":"a","id":"x-1"}')
  const decoder = compileJsonDecoder(schema)

  expect(decoder).toEqual(expect.any(Function))
  const decoded = (decoder as (value: unknown) => unknown)(input)
  expect(decoded).toEqual(decodeJson(schema, input as never))
  expect(Object.getPrototypeOf(decoded)).toBeNull()
  expect(Object.keys(decoded as object)).toEqual(["id", "kind", "qty", "tags"])
  expect(decoded).toEqual(decodeJsonTree(schema, input as never))
})

test("island failure falls back to the same StructError", () => {
  const schema = struct.object({
    id: struct.string(),
    pair: struct.tuple([struct.string(), struct.number()]),
    bag: struct.record(struct.number())
  })
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  const input = { bag: { a: "no" }, id: "x", pair: ["only"] }
  const fromJson = thrown(() => decodeJson(schema, input))
  const fromTree = thrown(() => decodeJsonTree(schema, input))

  expect(fromTree).toBeInstanceOf(StructError)
  const left = fromJson as StructError
  const right = fromTree as StructError
  expect(right.name).toBe(left.name)
  expect(right.message).toBe(left.message)
  expect(right.issues).toEqual(left.issues)
})

test("deep island matches portable depth boundary", () => {
  const schema = burySchema(struct.tuple([struct.any()]), 40)
  const within = buryValue([nestedArrays(959)], 40)
  const over = buryValue([nestedArrays(960)], 40)

  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  expect(outcomeOf(() => decodeJson(schema, within)).startsWith("ok:")).toBe(true)
  expect(outcomeOf(() => decodeJson(schema, over))).toContain(
    `portable container depth limit ${PORTABLE_VALUE_GRAPH_DEPTH_LIMIT}`
  )
  expect(outcomeOf(() => decodeJsonTree(schema, within))).toBe(
    outcomeOf(() => decodeJson(schema, within))
  )
  expect(outcomeOf(() => decodeJsonTree(schema, over))).toBe(
    outcomeOf(() => decodeJson(schema, over))
  )
})

test("union options follow declaration order", () => {
  const marked = createPrimitiveStruct({
    decode: (value: string) => ({ ok: true as const, value: `${value}!` }),
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const markedFirst = struct.or(marked, struct.string())
  const plainFirst = struct.or(struct.string(), marked)

  expect(compileJsonDecoder(markedFirst)).toEqual(expect.any(Function))
  expect(compileJsonDecoder(plainFirst)).toEqual(expect.any(Function))
  expect(decodeJson(markedFirst, "ab")).toBe("ab!")
  expect(decodeJsonTree(markedFirst, "ab")).toBe("ab!")
  expect(decodeJsonTree(plainFirst, "ab")).toBe("ab")
  expect(decodeJsonTree(struct.or(struct.number(), struct.string()), "1")).toBe("1")
  expect(decodeJsonTree(struct.or(struct.string(), struct.number()), "1")).toBe("1")
  expect(decodeJsonTree(struct.or(struct.number(), struct.string()), 1)).toBe(1)
})

test("discriminated union follows the wire key and does not try later keys", () => {
  const schema = struct.discriminatedUnion("kind", [
    struct.object({ kind: struct.literal("a"), n: struct.number() }),
    struct.object({ kind: struct.literal("b").alias("type"), s: struct.string() })
  ])
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  expect(decodeJsonTree(schema, { kind: "a", n: 1, extra: true })).toEqual(
    decodeJson(schema, { kind: "a", n: 1, extra: true })
  )
  expect(decodeJsonTree(schema, { type: "b", s: "ok" })).toEqual({ s: "ok", kind: "b" })
  const wrongWire = thrown(() => decodeJsonTree(schema, { kind: "b", s: "ok" }))
  const wrongWireJson = thrown(() => decodeJson(schema, { kind: "b", s: "ok" }))
  expect(wrongWire).toBeInstanceOf(StructError)
  expect((wrongWire as StructError).issues).toEqual((wrongWireJson as StructError).issues)
  const missing = thrown(() => decodeJsonTree(schema, { n: 1 }))
  expect((missing as StructError).issues).toEqual(
    (thrown(() => decodeJson(schema, { n: 1 })) as StructError).issues
  )
})

test("discriminated union reads a getter discriminator once", () => {
  const schema = struct.discriminatedUnion("kind", [
    struct.object({ kind: struct.literal("a"), n: struct.number() }),
    struct.object({ kind: struct.literal("b"), s: struct.string() })
  ])
  let reads = 0
  const input: { kind?: string; n: number } = { n: 1 }
  Object.defineProperty(input, "kind", {
    enumerable: true,
    get() {
      reads += 1
      return "a"
    }
  })
  const decoder = compileJsonDecoder(schema)
  expect(decoder).toEqual(expect.any(Function))
  expect((decoder as (value: unknown) => unknown)(input)).toEqual({ kind: "a", n: 1 })
  expect(reads).toBe(1)
})

test("mixed discriminated union reads a getter discriminator once on the pure option", () => {
  const hooked = createPrimitiveStruct({
    decode: (value: string) => ({ ok: true as const, value }),
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const schema = struct.discriminatedUnion("kind", [
    struct.object({ kind: struct.literal("a"), n: struct.number() }),
    struct.object({ kind: struct.literal("b"), name: hooked })
  ])
  let reads = 0
  const input: { kind?: string; n: number } = { n: 1 }
  Object.defineProperty(input, "kind", {
    enumerable: true,
    get() {
      reads += 1
      return "a"
    }
  })
  const decoder = compileJsonDecoder(schema)
  expect(decoder).toEqual(expect.any(Function))
  expect((decoder as (value: unknown) => unknown)(input)).toEqual({ kind: "a", n: 1 })
  expect(reads).toBe(1)
})

test("root intersection merge error matches the interpreter", () => {
  const id = struct.object({ id: struct.string() })
  const name = struct.object({ name: struct.string() })
  const schema = struct.intersection(
    struct.object({ items: struct.array(id).alias("left") }),
    struct.object({ items: struct.array(name).alias("right") })
  )
  const input = { left: [{ id: "a" }, { id: "b" }], right: [{ name: "Ada" }] }
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  const fromTree = thrown(() => decodeJsonTree(schema, input))
  const fromJson = thrown(() => decodeJson(schema, input))
  expect(fromTree).toBeInstanceOf(StructError)
  expect((fromTree as StructError).message).toBe((fromJson as StructError).message)
  expect((fromTree as StructError).issues).toEqual((fromJson as StructError).issues)
})

test("union skips an intersection option that throws and keeps the next option", () => {
  const id = struct.object({ id: struct.string() })
  const name = struct.object({ name: struct.string() })
  const schema = struct.or(
    struct.intersection(
      struct.object({ items: struct.array(id).alias("left") }),
      struct.object({ items: struct.array(name).alias("right") })
    ),
    struct.object({ ok: struct.literal(true) })
  )
  const input = { left: [{ id: "a" }, { id: "b" }], ok: true, right: [{ name: "Ada" }] }
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  const decoded = decodeJsonTree(schema, input)
  expect(decoded).toEqual(decodeJson(schema, input))
  expect(decoded).toEqual({ ok: true })
})

test("lazy getter schema stays on the interpreter", () => {
  let reads = 0
  const named = struct.object({
    id: struct.string(),
    get name() {
      reads += 1
      return struct.string()
    }
  })
  const recursive = struct.object({
    id: struct.string(),
    get child() {
      return struct.array(recursive).optional()
    }
  })
  const lazy = struct.object({
    get tag() {
      return struct.literal("a")
    }
  })
  const schemas = [
    named,
    recursive,
    struct.object({ child: named }),
    struct.array(named),
    struct.or(struct.string(), named),
    struct.tuple([named, struct.number()]),
    struct.record(named),
    struct.intersection(named, struct.object({ id: struct.string() })),
    struct.discriminatedUnion("kind", [
      struct.object({
        kind: struct.literal("a"),
        get extra() {
          return struct.string()
        }
      }),
      struct.object({ kind: struct.literal("b"), s: struct.string() })
    ])
  ]
  expect(compileJsonDecoder(named)).toBeNull()
  expect(reads).toBe(0)
  for (const schema of schemas) expect(compileJsonDecoder(schema)).toBeNull()
  const input = { id: "a", name: "n" }
  expect(decodeJsonTree(named, input)).toEqual(decodeJson(named, input))
  expect(reads).toBe(1)
  const nested = { child: [{ id: "b" }], id: "a" }
  expect(decodeJsonTree(recursive, nested)).toEqual(decodeJson(recursive, nested))
  expect(compileJsonDecoder(lazy)).toBeNull()
})

test("island rethrows a getter TypeError", () => {
  const schema = struct.tuple([struct.object({ name: struct.string() })])
  const item = {}
  Object.defineProperty(item, "name", {
    enumerable: false,
    get(): string {
      throw new TypeError("boom")
    }
  })
  const input = [item]
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  const fromTree = thrown(() => decodeJsonTree(schema, input))
  const fromJson = thrown(() => decodeJson(schema, input))
  expect(fromTree).toBeInstanceOf(TypeError)
  expect((fromTree as TypeError).message).toBe((fromJson as TypeError).message)
})

test("aliased option inside or uses the wire key", () => {
  const schema = struct.or(
    struct.object({ name: struct.string().alias("n") }),
    struct.object({ name: struct.number().alias("n") })
  )
  const input = { extra: true, n: "ada" }
  const withoutAliases = parseValue(asRuntime(schema), input, [], "value", false)

  expect(withoutAliases.ok).toBe(false)
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  const decoded = decodeJsonTree(schema, input)
  expect(decoded).toEqual(decodeJson(schema, input))
  expect(Object.getPrototypeOf(decoded)).toBeNull()
  expect(Object.keys(decoded as object)).toEqual(["name"])
})

test("optional island keeps value mode for array holes and field omission", () => {
  const pair = struct.tuple([struct.string()]).optional()
  const fieldMode = parseValue(asRuntime(pair), undefined, ["pair"], "field", true)
  const valueMode = parseValue(asRuntime(pair), undefined, ["pair"], "value", true)

  expect(fieldMode.ok && fieldMode.value === OMIT).toBe(true)
  expect(valueMode).toEqual({ ok: true, value: undefined })

  const schema = struct.object({
    id: struct.string(),
    pair,
    rows: struct.array(pair)
  })
  const input = { id: "x", rows: [undefined, ["a"]] }
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  const decoded = decodeJsonTree(schema, input) as { [key: string]: unknown }
  expect(decoded).toEqual(decodeJson(schema, input))
  expect(Object.keys(decoded)).toEqual(["id", "rows"])
  expect(decoded.rows).toEqual([undefined, ["a"]])
})

test("successful undefined hook stays an own key", () => {
  const blank = createPrimitiveStruct({
    decode: () => ({ ok: true as const, value: undefined }),
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const schema = struct.object({
    id: struct.string(),
    name: blank
  })
  const decoded = decodeJsonTree(schema, { id: "a", name: "x" }) as { [key: string]: unknown }
  expect(decoded).toEqual(decodeJson(schema, { id: "a", name: "x" }))
  expect(Object.keys(decoded)).toEqual(["id", "name"])
  expect(Object.hasOwn(decoded, "name")).toBe(true)
  expect(decoded.name).toBeUndefined()
})

test("quiet island failure reuses one result", () => {
  const text = asRuntime(struct.string())
  const left = parseStructQuiet(text, 1, [])
  const right = parseStructQuiet(text, true, ["a"])
  expect(left.ok).toBe(false)
  expect(left).toBe(right)
  const loudLeft = parseValue(text, 1, [], "value", true)
  const loudRight = parseValue(text, true, [], "value", true)
  expect(loudLeft.ok).toBe(false)
  expect(loudLeft).not.toBe(loudRight)
})

function capture(run: () => unknown): unknown {
  try {
    return run()
  } catch (error) {
    return error
  }
}

test("tuple and record decode match the interpreter", () => {
  const pair = struct.tuple([struct.string().optional(), struct.number().nullable()])
  const nested = struct.tuple([struct.tuple([struct.number(), struct.number()]), struct.string()])
  const bag = struct.record(struct.string())
  const optionalBag = struct.record(struct.string().optional())
  const hole = [] as unknown[]
  hole.length = 2
  hole[1] = 1
  const extra = ["a", 1] as unknown[] & { extra?: unknown }
  extra.extra = { n: 1 }
  const parsed = JSON.parse(
    '{"2":"a","10":"b","__proto__":"x","":"e","constructor":"c","toString":"t"}'
  )
  const longKey = "k".repeat(300)
  const symbolRecord = () => {
    const input = { a: "z" } as { a: string; [key: symbol]: string }
    input[Symbol("s")] = "no"
    return input
  }
  const hiddenRecord = () => {
    const input = { a: "z" }
    Object.defineProperty(input, "hid", { enumerable: false, value: "no" })
    return input
  }
  const proxyRecord = () =>
    new Proxy(
      { a: "target" },
      {
        get(target, key, receiver) {
          if (key === "a") return "from-get"
          return Reflect.get(target, key, receiver)
        }
      }
    )
  const getterRecord = () => {
    const input = {}
    Object.defineProperty(input, "a", {
      enumerable: true,
      get() {
        return "z"
      }
    })
    return input
  }
  const marked = createPrimitiveStruct({
    decode: (value: string, path: ReadonlyArray<number | string>) => ({
      ok: true as const,
      value: path.join(".")
    }),
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const samples: Array<[AnyStructLike, unknown]> = [
    [pair, [undefined, 1]],
    [pair, hole],
    [pair, ["a", null]],
    [pair, ["only"]],
    [pair, ["a", 1, true]],
    [pair, { 0: "a", 1: 1 }],
    [nested, [[1, 2], "z"]],
    [bag, parsed],
    [bag, { a: "z", b: "y" }],
    [bag, []],
    [bag, "no"],
    [optionalBag, { a: undefined, b: "z" }],
    [bag, { [longKey]: "z" }],
    [struct.record(struct.number().nullable()), { a: null }],
    [struct.object({ bag: struct.record(marked) }), { bag: { a: "x" } }],
    [struct.object({ pair: struct.tuple([marked, struct.number()]) }), { pair: ["a", 1] }],
    [
      struct.array(struct.tuple([struct.number(), struct.number()])),
      [
        [1, 2],
        [3, 4]
      ]
    ],
    [struct.array(struct.record(struct.string())), [{ a: "z" }]],
    [bag, symbolRecord()],
    [bag, hiddenRecord()],
    [bag, proxyRecord()],
    [bag, getterRecord()]
  ]
  for (const [schema, input] of samples) {
    expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
    const decoded = capture(() => decodeJsonTree(schema, input))
    const expected = capture(() => decodeJson(schema, input))
    const label = JSON.stringify(input)
    if (decoded instanceof Error || expected instanceof Error) {
      expect(decoded, label).toBeInstanceOf(Error)
      expect(expected, label).toBeInstanceOf(Error)
      expect((decoded as Error).message).toBe((expected as Error).message)
      if (decoded instanceof StructError && expected instanceof StructError) {
        expect(decoded.issues).toEqual(expected.issues)
      }
      continue
    }
    expect(decoded, label).toEqual(expected)
  }
  const ordered = decodeJsonTree(bag, parsed) as { [key: string]: unknown }
  expect(Object.getPrototypeOf(ordered)).toBeNull()
  expect(Object.keys(ordered)).toEqual(Object.keys(decodeJson(bag, parsed) as object))
  expect(Object.hasOwn(ordered, "__proto__")).toBe(true)
  const omitted = decodeJsonTree(optionalBag, { a: undefined, b: "z" }) as {
    [key: string]: unknown
  }
  expect(Object.keys(omitted)).toEqual(["b"])
  expect(Object.getPrototypeOf(omitted)).toBeNull()
  const hooked = decodeJsonTree(struct.object({ bag: struct.record(marked) }), { bag: { a: "x" } })
  expect(hooked).toEqual({ bag: { a: "bag.a" } })
  const paired = decodeJsonTree(struct.object({ pair: struct.tuple([marked, struct.number()]) }), {
    pair: ["a", 1]
  })
  expect(paired).toEqual({ pair: ["pair.0", 1] })
})

test("forwarding proxy tuple and record decode match the interpreter", () => {
  const pair = struct.tuple([struct.string(), struct.string()])
  const bag = struct.record(struct.string())
  const recordProxy = new Proxy(
    { a: "target" },
    {
      get(target, key, receiver) {
        if (key === "a") return "from-get"
        return Reflect.get(target, key, receiver)
      }
    }
  )
  const tupleProxy = new Proxy(["x", "y"], {
    get(target, key, receiver) {
      if (key === "0") return "from-get"
      return Reflect.get(target, key, receiver)
    }
  })
  expect(capture(() => decodeJsonTree(bag, recordProxy))).toEqual(
    capture(() => decodeJson(bag, recordProxy))
  )
  expect(capture(() => decodeJsonTree(pair, tupleProxy))).toEqual(
    capture(() => decodeJson(pair, tupleProxy))
  )
})

test("side-effecting record proxy decode is a known fast-path observation", () => {
  // Known limitation. decodeJsonTree's contract is a JSON.parse data tree.
  // A get trap that deletes a later key is outside that contract. The depth
  // walk gets "b", then "a"; getting "a" deletes "b", so the compiled record
  // sees only "a" and returns {a:"x"}. A sole interpreter snapshots ["a","b"]
  // before any get and then reports missing_key at "b". This pins the
  // fast-path success, not agreement with the interpreter.
  const bag = struct.record(struct.string())
  const recordGets: string[] = []
  const recordProxy = () => {
    const target: { a: string; b?: string } = { a: "x", b: "y" }
    return new Proxy(target, {
      get(receiver, key, owner) {
        recordGets.push(String(key))
        if (key === "a") delete target.b
        return Reflect.get(receiver, key, owner)
      }
    })
  }
  const decoded = capture(() => decodeJsonTree(bag, recordProxy()))
  expect(decoded).not.toBeInstanceOf(Error)
  const record = decoded as { [key: string]: unknown }
  expect(recordGets).toEqual(["b", "a", "a"])
  expect(Object.getPrototypeOf(record)).toBeNull()
  expect(Object.keys(record)).toEqual(["a"])
  expect(record.a).toBe("x")
  recordGets.length = 0
  const interpreted = capture(() => decodeJson(bag, recordProxy()))
  expect(interpreted).toBeInstanceOf(StructError)
  expect((interpreted as StructError).issues[0]).toMatchObject({
    code: "missing_key",
    path: ["b"]
  })
  expect(recordGets).toEqual(["a", "b"])
})

test("side-effecting tuple proxy decode is a known fast-path observation", () => {
  // Known limitation. The depth walk reads index "1" before "0". The first
  // get of "0" rewrites index 1 to "changed", and the compiled tuple then
  // returns ["x","changed"]. A sole interpreter also returns ["x","changed"]
  // on a fresh proxy, but its first index get is "0". This pins the fast
  // path's earlier observation, not a promise that every side-effecting trap
  // stays aligned with the interpreter.
  const pair = struct.tuple([struct.string(), struct.string()])
  const tupleProxy = (gets: string[]) => {
    const state = { reads: 0 }
    const target = ["x", "y"]
    return new Proxy(target, {
      get(receiver, key, owner) {
        gets.push(String(key))
        if (key === "0") {
          state.reads += 1
          if (state.reads === 1) target[1] = "changed"
        }
        return Reflect.get(receiver, key, owner)
      }
    })
  }
  const tupleGets: string[] = []
  const tupleDecoded = capture(() => decodeJsonTree(pair, tupleProxy(tupleGets)))
  expect(tupleGets).toEqual(["1", "0", "length", "0", "1"])
  expect(tupleDecoded).toEqual(["x", "changed"])
  const interpreterGets: string[] = []
  expect(capture(() => decodeJson(pair, tupleProxy(interpreterGets)))).toEqual(["x", "changed"])
  expect(interpreterGets).toEqual(["length", "0", "1"])
})

test("pure schema root decoder does not allocate a path array", () => {
  const schema = struct.object({
    flags: struct.array(struct.boolean()),
    id: struct.string(),
    shipTo: struct.object({ city: struct.string() })
  })
  const decoder = compileJsonDecoder(schema)
  expect(decoder).toEqual(expect.any(Function))
  const source = Function.prototype.toString.call(decoder)
  expect(source).not.toContain("[]")
  expect(source).not.toContain("path")
})

test("island root decoder still receives a path array", () => {
  const island = compileJsonDecoder(
    struct.intersection(
      struct.object({ a: struct.string() }),
      struct.object({ b: struct.number() })
    )
  )
  expect(island).toEqual(expect.any(Function))
  expect(Function.prototype.toString.call(island)).toContain("step.run")
  const tuple = compileJsonDecoder(struct.tuple([struct.string(), struct.number()]))
  expect(tuple).toEqual(expect.any(Function))
  expect(Function.prototype.toString.call(tuple)).not.toContain("step.run")
  expect(decodeJsonTree(struct.tuple([struct.string(), struct.number()]), ["a", 1])).toEqual([
    "a",
    1
  ])
  const record = compileJsonDecoder(struct.record(struct.string()))
  expect(record).toEqual(expect.any(Function))
  expect(Function.prototype.toString.call(record)).not.toContain("step.run")
})

test("island decode hook runs once on success and twice after a later field falls back", () => {
  let runs = 0
  const hooked = createPrimitiveStruct({
    decode: (value: string) => {
      runs += 1
      return { ok: true as const, value }
    },
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const schema = struct.object({
    name: hooked,
    count: struct.number()
  })
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))

  runs = 0
  expect(decodeJsonTree(schema, { count: 1, name: "ada" })).toEqual({ count: 1, name: "ada" })
  expect(runs).toBe(1)

  runs = 0
  const bad = { count: "no", name: "ada" }
  const fromTree = thrown(() => decodeJsonTree(schema, bad))
  expect(runs).toBe(2)
  const fromJson = thrown(() => decodeJson(schema, bad))
  expect(fromTree).toBeInstanceOf(StructError)
  expect((fromTree as StructError).message).toBe((fromJson as StructError).message)
  expect((fromTree as StructError).issues).toEqual((fromJson as StructError).issues)
})

test("cyclic input matches decodeJson StructError", () => {
  const schema = struct.object({ a: struct.string() })
  const cycle: { a: string; self?: unknown } = { a: "x" }
  cycle.self = cycle
  expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
  const fromTree = thrown(() => decodeJsonTree(schema, cycle))
  const fromJson = thrown(() => decodeJson(schema, cycle))
  expect(fromTree).toBeInstanceOf(StructError)
  expect(fromTree).not.toBeInstanceOf(RangeError)
  expect((fromTree as StructError).message).toBe("struct value contains a cycle")
  expect((fromTree as StructError).message).toBe((fromJson as StructError).message)
  expect((fromTree as StructError).issues).toEqual((fromJson as StructError).issues)
})

test("mixed pure fields keep the island hook path", () => {
  const marked = createPrimitiveStruct({
    decode: (value: string, path) => ({ ok: true as const, value: `${path.join(".")}:${value}` }),
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const aliased = struct.object({
    id: struct.string(),
    tags: struct.array(struct.string()),
    name: marked.alias("n")
  })
  const tuple = struct.object({
    id: struct.string(),
    pair: struct.tuple([marked]),
    rows: struct.array(struct.number())
  })
  const nested = struct.object({
    id: struct.string(),
    wrap: struct.object({
      note: struct.string(),
      pair: struct.tuple([marked])
    })
  })
  const rows = struct.object({
    id: struct.string(),
    rows: struct.array(struct.tuple([marked]))
  })
  const choice = struct.object({
    choice: struct.or(struct.number(), struct.tuple([marked])),
    id: struct.string()
  })
  const tagged = struct.discriminatedUnion("kind", [
    struct.object({ kind: struct.literal("a"), n: struct.number() }),
    struct.object({ kind: struct.literal("b"), name: marked.alias("n") })
  ])
  const samples: Array<[AnyStructLike, unknown, unknown]> = [
    [aliased, { id: "x", n: "ada", tags: ["p"] }, { id: "x", name: "name:ada", tags: ["p"] }],
    [tuple, { id: "x", pair: ["ada"], rows: [1] }, { id: "x", pair: ["pair.0:ada"], rows: [1] }],
    [
      nested,
      { id: "x", wrap: { note: "n", pair: ["ada"] } },
      { id: "x", wrap: { note: "n", pair: ["wrap.pair.0:ada"] } }
    ],
    [
      rows,
      { id: "x", rows: [["ada"], ["be"]] },
      { id: "x", rows: [["rows.0.0:ada"], ["rows.1.0:be"]] }
    ],
    [choice, { choice: ["ada"], id: "x" }, { choice: ["choice.0:ada"], id: "x" }],
    [choice, { choice: 3, id: "x" }, { choice: 3, id: "x" }],
    [tagged, { kind: "b", n: "ada" }, { kind: "b", name: "name:ada" }],
    [tagged, { kind: "a", n: 1 }, { kind: "a", n: 1 }]
  ]
  for (const [schema, input, expected] of samples) {
    expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
    expect(decodeJsonTree(schema, input)).toEqual(expected)
    expect(decodeJsonTree(schema, input)).toEqual(decodeJson(schema, input))
  }
  const missed = struct.or(struct.tuple([struct.string()]), struct.number())
  expect(compileJsonDecoder(missed)).toEqual(expect.any(Function))
  const fromTree = thrown(() => decodeJsonTree(missed, true))
  const fromJson = thrown(() => decodeJson(missed, true))
  expect(fromTree).toBeInstanceOf(StructError)
  expect((fromTree as StructError).issues).toEqual((fromJson as StructError).issues)
})

function outcomeOf(run: () => unknown): string {
  try {
    return `ok:${JSON.stringify(run())}`
  } catch (error) {
    if (error instanceof StructError) return `struct:${error.message}`
    if (error instanceof Error) return `throw:${error.name}:${error.message}`
    return `throw:${String(error)}`
  }
}

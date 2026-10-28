import { expect, test } from "bun:test"

import { decodeJson, decodeJsonTree } from "../src/codec/json"
import { compileJsonDecoder } from "../src/compile-decode"
import { StructError } from "../src/errors"
import { getStructFields } from "../src/introspection"
import { struct } from "../src/index"
import { createPrimitiveStruct } from "../src/runtime"
import { DEFINITION } from "../src/symbols"
import type { AnyStruct, AnyStructLike, RuntimeStruct, StructDefinition } from "../src/types"
import { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "../src/value-graph"

function tagged(value: unknown): unknown {
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { $: "-0" }
    if (value === Infinity) return { $: "Infinity" }
    if (value === -Infinity) return { $: "-Infinity" }
    if (Number.isNaN(value)) return { $: "NaN" }
    return value
  }
  if (typeof value === "bigint") return { $: `bigint:${value}` }
  if (value instanceof Date) return { $: `date:${value.toISOString()}` }
  if (typeof File !== "undefined" && value instanceof File) {
    return { $: `file:${value.name}:${value.size}:${value.type}` }
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return { $: `blob:${value.size}:${value.type}` }
  }
  if (value instanceof ArrayBuffer) return { $: `ab:${value.byteLength}` }
  if (Array.isArray(value)) return value.map((item) => tagged(item))
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    const proto =
      prototype === null ? "null" : prototype === Object.prototype ? "Object.prototype" : "other"
    const keys = Object.keys(value)
    const values: { [key: string]: unknown } = {}
    for (const key of keys) values[key] = tagged((value as { [key: string]: unknown })[key])
    return { keys, proto, values }
  }
  return value
}

function outcome(run: () => unknown): string {
  try {
    return `ok:${JSON.stringify(tagged(run())) ?? "undefined"}`
  } catch (error) {
    if (error instanceof StructError) {
      return `struct:${JSON.stringify(tagged({ message: error.message, name: error.name, issues: error.issues }))}`
    }
    if (error instanceof Error) return `throw:${error.name}:${error.message}`
    return `throw:${String(error)}`
  }
}

function expectFastPath(schema: AnyStructLike, input: unknown): void {
  const decoder = compileJsonDecoder(schema)
  if (decoder === null) throw new Error("expected a compiled fast path")
  const expected = outcome(() => decodeJson(schema, input))
  expect(outcome(() => decoder(input))).toBe(expected)
  expect(outcome(() => decodeJsonTree(schema, input))).toBe(expected)
}

function expectSameInterpreter(schema: AnyStructLike, input: unknown): void {
  const expected = outcome(() => decodeJson(schema, input))
  const actual = outcome(() => decodeJsonTree(schema, input))
  expect(actual).toBe(expected)
}

test("fast path output matches the interpreter", () => {
  const user = struct.object({
    z: struct.string(),
    a: struct.number(),
    m: struct.boolean().optional(),
    n: struct.string().nullable(),
    k: struct.string().nullish()
  })
  const item = struct.object({ b: struct.string(), a: struct.number() })
  const id = struct.string()
  const left = struct.object({ id, city: struct.string() })
  const right = struct.object({ id, name: struct.string() })
  const shape: { id: AnyStruct } = { id: struct.string() }
  const frozen = struct.object(shape)
  shape.id = struct.number()
  const protoField = struct.object({
    ["__proto__"]: struct.string(),
    id: struct.string()
  })
  const payload = struct.object({
    body: struct.any(),
    other: struct.unknown()
  })
  const inner = { a: 1, extra: true }

  const cases: Array<[string, AnyStructLike, unknown]> = [
    [
      "declaration order, dropped unknown key, kept zero false empty and null",
      user,
      JSON.parse('{"m":false,"k":null,"extra":1,"n":null,"a":0,"z":""}')
    ],
    ["omitted optional and nullish keys", user, JSON.parse('{"n":"x","a":1,"z":"z"}')],
    ["negative zero", struct.number(), JSON.parse("-0")],
    ["infinity from a JSON exponent", struct.number(), JSON.parse("1e999")],
    ["integer above the safe range", struct.number(), JSON.parse("9007199254740993")],
    ["empty string", struct.string(), JSON.parse('""')],
    ["literal false and null", struct.literal(false), false],
    ["literal null", struct.literal(null), null],
    ["literal zero", struct.literal(0), 0],
    ["string enum", struct.enum(["new", "paid"]), "paid"],
    ["numeric enum accepts negative zero", struct.enum({ off: 0, on: 1 }), JSON.parse("-0")],
    [
      "array items keep declaration order and drop unknown keys",
      struct.array(item),
      JSON.parse('[{"a":1,"z":true,"b":"x"},{"b":"y","a":2}]')
    ],
    ["empty array", struct.array(struct.string()), []],
    ["empty object", struct.object({}), JSON.parse('{"extra":1}')],
    ["shared child struct", left, { id: "a", city: "Berlin", extra: true }],
    ["reused child struct", right, { name: "Ada", id: "a" }],
    ["later shape mutation does not change cached fields", frozen, { id: "still-string" }],
    [
      "null prototype input",
      struct.object({ id: struct.string() }),
      Object.assign(Object.create(null), { id: "a", z: 1 })
    ],
    [
      "__proto__ wire field stays an own key",
      protoField,
      JSON.parse('{"__proto__":"safe","id":"a"}')
    ],
    [
      "unknown __proto__ key is dropped",
      struct.object({ id: struct.string() }),
      JSON.parse('{"__proto__":{"admin":true},"id":"a"}')
    ],
    ["nullable object null", struct.object({ id: struct.string() }).nullable(), null],
    ["optional root undefined", struct.string().optional(), undefined],
    ["null kind", struct.null(), null],
    ["any field keeps the input reference", payload, { body: inner, other: { kept: true }, z: 1 }],
    ["unknown root keeps the input object", struct.unknown(), { kept: true }],
    ["any root keeps the input array", struct.any(), [1, { a: 2 }]],
    ["blob", struct.blob(), new Blob(["hi"], { type: "text/plain" })],
    ["file", struct.file(), new File(["hi"], "note.txt", { type: "text/plain" })],
    ["array buffer", struct.arrayBuffer(), new Uint8Array([1, 2]).buffer],
    [
      "nested object",
      struct.object({ user: struct.object({ id: struct.string().nullable() }) }),
      { user: { id: null, extra: 1 }, z: 2 }
    ],
    ["nullish array element", struct.array(struct.string().nullish()), ["a", null]],
    ["boolean true", struct.boolean(), true]
  ]

  for (const [name, schema, input] of cases) {
    try {
      expectFastPath(schema, input)
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      })
    }
  }

  const decoded = decodeJsonTree(payload, { body: inner, other: { kept: true } }) as {
    body: unknown
  }
  expect(decoded.body).toBe(inner)
  expect(Object.getPrototypeOf(decoded)).toBeNull()
  expect(Object.prototype).not.toHaveProperty("admin")
  expect(Object.prototype).not.toHaveProperty("polluted")
})

test("failed input matches StructError from the interpreter", () => {
  const user = struct.object({
    a: struct.number(),
    b: struct.string(),
    m: struct.boolean().optional(),
    child: struct.object({ id: struct.number() })
  })
  const cases: Array<[string, AnyStructLike, unknown]> = [
    ["wrong type", struct.number(), "no"],
    ["missing key", user, { b: "ok" }],
    ["null on optional", user, { a: 1, b: "ok", m: null, child: { id: 1 } }],
    ["null on required", struct.string(), null],
    ["bad enum", struct.enum(["new", "paid"]), "shipped"],
    ["literal rejects negative zero", struct.literal(0), JSON.parse("-0")],
    ["NaN", struct.number(), NaN],
    ["array element", struct.array(struct.number()), [1, "x"]],
    ["nested path", user, { a: 1, b: "ok", child: { id: "x" } }],
    ["stops at the first field", user, { a: "x", b: 1 }],
    ["array is not an object", user, [1]],
    ["object is not an array", struct.array(struct.string()), { 0: "a" }],
    ["undefined required root", struct.string(), undefined],
    ["any rejects null", struct.any(), null],
    ["unknown rejects null", struct.unknown(), null],
    ["null kind rejects a string", struct.null(), "x"],
    ["empty object misses fields", user, {}],
    ["literal mismatch", struct.literal("ok"), "no"]
  ]

  for (const [name, schema, input] of cases) {
    expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
    try {
      expectSameInterpreter(schema, input)
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      })
    }
  }
})

test("island and union schemas match the interpreter", () => {
  const recursive = struct.object({
    id: struct.string(),
    get child() {
      return struct.array(recursive)
    }
  })
  const cases: Array<[string, AnyStructLike, unknown]> = [
    ["or success", struct.or(struct.string(), struct.number()), "ok"],
    ["or failure", struct.or(struct.string(), struct.number()), true],
    [
      "alias success",
      struct.object({ name: struct.string().alias("full_name") }),
      { full_name: "Ada", extra: 1 }
    ],
    ["alias failure", struct.object({ name: struct.string().alias("full_name") }), { name: "Ada" }],
    ["empty alias", struct.object({ name: struct.string().alias("") }), { "": "Ada" }],
    ["getter success", recursive, { id: "a", child: [{ id: "b" }] }],
    ["getter failure", recursive, { id: 1 }],
    ["bigint success", struct.bigint(), "12"],
    ["bigint failure", struct.bigint(), 12],
    ["date success", struct.date(), "2020-01-01T00:00:00.000Z"],
    ["date failure", struct.date(), "not-a-date"],
    ["tuple", struct.tuple([struct.string(), struct.number()]), ["a", 1]],
    ["tuple failure", struct.tuple([struct.string(), struct.number()]), ["a"]],
    ["record", struct.record(struct.number()), { a: 1, b: 2 }],
    ["record failure", struct.record(struct.number()), { a: "no" }],
    [
      "intersection",
      struct.intersection(
        struct.object({ a: struct.string() }),
        struct.object({ b: struct.number() })
      ),
      { a: "ok", b: 1, extra: true }
    ],
    [
      "discriminated union",
      struct.discriminatedUnion("kind", [
        struct.object({ kind: struct.literal("a"), n: struct.number() }),
        struct.object({ kind: struct.literal("b"), s: struct.string() })
      ]),
      { kind: "b", s: "ok" }
    ],
    [
      "mixed or field",
      struct.object({
        id: struct.string(),
        tag: struct.or(struct.literal("a"), struct.literal("b"))
      }),
      JSON.parse('{"__proto__":{"x":1},"id":"a","tag":"a"}')
    ]
  ]

  for (const [name, schema, input] of cases) {
    const decoder = compileJsonDecoder(schema)
    const lazy = name.startsWith("getter")
    if (lazy) expect(decoder).toBeNull()
    else {
      expect(decoder).toEqual(expect.any(Function))
      expect(compileJsonDecoder(schema)).toBe(decoder)
    }
    try {
      const expected = outcome(() => decodeJson(schema, input))
      expect(outcome(() => decodeJsonTree(schema, input))).toBe(expected)
      if (!lazy && expected.startsWith("ok:") && decoder !== null) {
        expect(outcome(() => decoder(input))).toBe(expected)
      }
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      })
    }
  }
})

const DIFFERENTIAL_SEED = 20261009
const DIFFERENTIAL_ITERATIONS = 24

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function definitionOf(schema: AnyStructLike): StructDefinition {
  return (schema as RuntimeStruct)[DEFINITION]
}

function modifySchema(schema: AnyStruct, rand: () => number): AnyStruct {
  const roll = rand()
  if (roll < 0.25) return schema.optional()
  if (roll < 0.5) return schema.nullable()
  if (roll < 0.7) return schema.nullish()
  return schema
}

function markedString(): AnyStruct {
  return createPrimitiveStruct({
    decode: (value: string, path) => ({ ok: true as const, value: `${path.join(".")}:${value}` }),
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
}

test("union declaration order matches the interpreter", () => {
  const marked = createPrimitiveStruct({
    decode: (value: string) => ({ ok: true as const, value: `${value}!` }),
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const dated = struct.date()
  const rows: Array<[string, AnyStructLike, unknown]> = [
    ["hook then string", struct.or(marked, struct.string()), "ab"],
    ["string then hook", struct.or(struct.string(), marked), "ab"],
    ["number then string keeps the string", struct.or(struct.number(), struct.string()), "1"],
    ["string then number keeps the string", struct.or(struct.string(), struct.number()), "1"],
    ["number then string keeps the number", struct.or(struct.number(), struct.string()), 1],
    [
      "wider object does not steal an earlier object",
      struct.or(
        struct.object({ a: struct.string() }),
        struct.object({ a: struct.string(), b: struct.number() })
      ),
      { a: "x", b: 1 }
    ],
    [
      "earlier wider object keeps its field",
      struct.or(
        struct.object({ a: struct.string(), b: struct.number() }),
        struct.object({ a: struct.string() })
      ),
      { a: "x", b: 1 }
    ],
    ["null reaches a later literal", struct.or(struct.string(), struct.literal(null)), null],
    ["null reaches an earlier literal", struct.or(struct.literal(null), struct.string()), null],
    ["nullable union returns null", struct.or(struct.string(), struct.number()).nullable(), null],
    ["date hook wins before string", struct.or(dated, struct.string()), "2020-01-02T00:00:00.000Z"],
    ["string wins before date", struct.or(struct.string(), dated), "2020-01-02T00:00:00.000Z"],
    [
      "nested union keeps the inner order",
      struct.or(struct.or(marked, struct.number()), struct.string()),
      "z"
    ],
    [
      "tuple island inside a union",
      struct.or(struct.tuple([struct.string(), struct.number()]), struct.array(struct.string())),
      ["a", 1]
    ],
    [
      "array wins when the tuple length is wrong",
      struct.or(struct.tuple([struct.string(), struct.number()]), struct.array(struct.string())),
      ["a"]
    ],
    [
      "record island inside a union",
      struct.or(struct.record(struct.number()), struct.object({ a: struct.string() })),
      { a: 1, b: 2 }
    ],
    [
      "hook path is the field key",
      struct.object({ name: markedString().alias("n") }),
      { n: "ada" }
    ],
    [
      "hook path continues through a tuple island",
      struct.object({ pair: struct.tuple([markedString()]) }),
      { pair: ["ada"] }
    ],
    [
      "missing discriminator",
      struct.discriminatedUnion("kind", [
        struct.object({ kind: struct.literal("a"), n: struct.number() }),
        struct.object({ kind: struct.literal("b").alias("type"), s: struct.string() })
      ]),
      { n: 1 }
    ],
    [
      "wrong discriminator wire key",
      struct.discriminatedUnion("kind", [
        struct.object({ kind: struct.literal("a"), n: struct.number() }),
        struct.object({ kind: struct.literal("b").alias("type"), s: struct.string() })
      ]),
      { kind: "b", s: "ok" }
    ],
    [
      "undefined discriminator value",
      struct.discriminatedUnion("kind", [
        struct.object({ kind: struct.literal("a"), n: struct.number() }),
        struct.object({ kind: struct.literal("b"), s: struct.string() })
      ]),
      { kind: undefined, n: 1 }
    ]
  ]

  for (const [name, schema, input] of rows) {
    try {
      const expected = outcome(() => decodeJson(schema, input))
      if (expected.startsWith("ok:")) expectFastPath(schema, input)
      else expectSameInterpreter(schema, input)
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      })
    }
  }
})

function randomLeaf(rand: () => number): AnyStruct {
  const roll = rand()
  if (roll < 0.12) return struct.string()
  if (roll < 0.2) {
    return createPrimitiveStruct({
      decode: (value: string) => ({ ok: true as const, value: value.toUpperCase() }),
      expected: "string",
      is: (value): value is string => typeof value === "string",
      kind: "string"
    })
  }
  if (roll < 0.28) return struct.number()
  if (roll < 0.36) return struct.boolean()
  if (roll < 0.42) return struct.null()
  if (roll < 0.5) return struct.literal(rand() < 0.5 ? "ok" : 0)
  if (roll < 0.56) return struct.literal(false)
  if (roll < 0.62) return struct.literal(null)
  if (roll < 0.7) return struct.enum(["a", "b", "c"])
  if (roll < 0.78) return struct.enum({ off: 0, on: 1 })
  if (roll < 0.84) return struct.date()
  if (roll < 0.9) return struct.bigint()
  if (roll < 0.95) return struct.any()
  return struct.unknown()
}

function maybeAlias(schema: AnyStruct, rand: () => number, index: number): AnyStruct {
  if (rand() < 0.75) return schema
  return schema.alias(`w${index}`)
}

function randomObject(rand: () => number, depth: number): AnyStruct {
  const count = 1 + Math.floor(rand() * 3)
  const shared = rand() < 0.35 ? randomSchema(rand, depth - 1) : undefined
  const shape: { [key: string]: AnyStructLike } = {}
  for (let index = 0; index < count; index += 1) {
    const child =
      shared !== undefined && (index === 0 || rand() < 0.4) ? shared : randomSchema(rand, depth - 1)
    shape[`f${index}`] = maybeAlias(child, rand, index)
  }
  return struct.object(shape)
}

function randomDiscriminated(rand: () => number, depth: number): AnyStruct {
  const aliasRight = rand() < 0.5
  return struct.discriminatedUnion("kind", [
    struct.object({
      kind: struct.literal("a"),
      body: randomSchema(rand, depth - 1)
    }),
    struct.object({
      body: randomSchema(rand, depth - 1),
      kind: aliasRight ? struct.literal("b").alias("type") : struct.literal("b")
    })
  ])
}

function randomIntersection(rand: () => number, depth: number): AnyStruct {
  return struct.intersection(
    struct.object({ left: randomSchema(rand, depth - 1) }),
    struct.object({ right: randomSchema(rand, depth - 1) })
  )
}

function randomSchema(rand: () => number, depth: number): AnyStruct {
  if (depth <= 0 || rand() < 0.34) return modifySchema(randomLeaf(rand), rand)
  const roll = rand()
  if (roll < 0.12) return modifySchema(struct.array(randomSchema(rand, depth - 1)), rand)
  if (roll < 0.24) {
    return modifySchema(
      struct.tuple([randomSchema(rand, depth - 1), randomSchema(rand, depth - 1)]),
      rand
    )
  }
  if (roll < 0.36) return modifySchema(struct.record(randomSchema(rand, depth - 1)), rand)
  if (roll < 0.5) {
    return modifySchema(
      struct.or(randomSchema(rand, depth - 1), randomSchema(rand, depth - 1)),
      rand
    )
  }
  if (roll < 0.62) return modifySchema(randomDiscriminated(rand, depth), rand)
  if (roll < 0.74) return modifySchema(randomIntersection(rand, depth), rand)
  return modifySchema(randomObject(rand, depth), rand)
}

function validValue(schema: AnyStructLike, rand: () => number): unknown {
  const definition = definitionOf(schema)
  if (definition.flags.optional && rand() < 0.25) return undefined
  if (definition.flags.nullable && rand() < 0.25) return null
  switch (definition.kind) {
    case "string":
      return rand() < 0.2 ? "" : "s"
    case "number": {
      const roll = rand()
      if (roll < 0.2) return -0
      if (roll < 0.35) return JSON.parse("1e999")
      if (roll < 0.5) return JSON.parse("9007199254740993")
      if (roll < 0.65) return 0
      return 1.5
    }
    case "boolean":
      return rand() < 0.5
    case "null":
      return null
    case "literal":
      return definition.value
    case "enum":
      return definition.values[Math.floor(rand() * definition.values.length)]
    case "any":
    case "unknown":
      return rand() < 0.5 ? { extra: true, kept: 1 } : [false, "z"]
    case "array": {
      const length = Math.floor(rand() * 3)
      const output: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        output.push(validValue(definition.item as AnyStructLike, rand))
      }
      return output
    }
    case "object": {
      const output: { [key: string]: unknown } = {}
      for (const field of getStructFields(schema)) {
        const child = validValue(field.struct, rand)
        if (child !== undefined) output[field.alias ?? field.key] = child
      }
      return output
    }
    case "or":
      return validValue(
        definition.options[Math.floor(rand() * definition.options.length)] as AnyStructLike,
        rand
      )
    case "discriminatedUnion":
      return validValue(
        definition.options[Math.floor(rand() * definition.options.length)] as AnyStructLike,
        rand
      )
    case "intersection": {
      const output: { [key: string]: unknown } = {}
      for (const option of definition.options) {
        const side = validValue(option as AnyStructLike, rand)
        if (side !== null && typeof side === "object" && !Array.isArray(side)) {
          Object.assign(output, side)
        }
      }
      return output
    }
    case "tuple":
      return definition.items.map((item) => validValue(item as AnyStructLike, rand))
    case "record": {
      const count = Math.floor(rand() * 3)
      const output: { [key: string]: unknown } = {}
      for (let index = 0; index < count; index += 1) {
        const child = validValue(definition.value as AnyStructLike, rand)
        if (child !== undefined) output[`k${index}`] = child
      }
      return output
    }
    case "date":
      return rand() < 0.5 ? "2020-01-02T03:04:05.000Z" : 1_700_000_000_000
    case "bigint":
      return rand() < 0.5 ? "12" : "0"
    default:
      throw new Error(`fuzzer produced an unsupported kind ${definition.kind}`)
  }
}

function withProtoKey(record: { [key: string]: unknown }): unknown {
  const json = JSON.stringify(record)
  if (json === undefined || json === "{}") return JSON.parse('{"__proto__":{"x":1}}')
  if (json[0] !== "{") return { ["__proto__"]: { x: 1 }, value: record }
  return JSON.parse(`{"__proto__":{"x":1},${json.slice(1)}`)
}

function deepen(value: unknown): unknown {
  let current = value
  for (let index = 0; index < 6; index += 1) current = { nested: current }
  return current
}

function mutants(value: unknown): unknown[] {
  const samples: unknown[] = [value, 12345, "str", null, false, [], {}, -0, ""]
  if (Array.isArray(value)) {
    samples.push(value.concat(null))
    if (value.length > 0) {
      const replaced = value.slice()
      replaced[0] = "nope"
      samples.push(replaced)
    }
    return samples
  }
  if (value === null || typeof value !== "object") return samples
  const record = value as { [key: string]: unknown }
  const keys = Object.keys(record)
  samples.push({ ...record, extra: 1, zzz: { n: true } })
  samples.push(withProtoKey(record))
  samples.push(deepen(record))
  if (keys.length === 0) return samples
  const key = keys[0] as string
  const deleted = { ...record }
  delete deleted[key]
  const reversed: { [key: string]: unknown } = {}
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const reversedKey = keys[index] as string
    reversed[reversedKey] = record[reversedKey]
  }
  samples.push(deleted, { ...record, [key]: null }, { ...record, [key]: "nope" }, reversed)
  return samples
}

function describeSchema(schema: AnyStructLike): string {
  const definition = definitionOf(schema)
  const flags = `${definition.flags.optional ? "?" : ""}${definition.flags.nullable ? "|null" : ""}`
  if (definition.kind === "object") {
    const fields = getStructFields(schema)
      .map((field) => `${field.key}:${describeSchema(field.struct)}`)
      .join(",")
    return `{${fields}}${flags}`
  }
  if (definition.kind === "array") {
    return `${describeSchema(definition.item as AnyStructLike)}[]${flags}`
  }
  if (definition.kind === "literal") return `literal:${JSON.stringify(definition.value)}${flags}`
  if (definition.kind === "enum") return `enum:${definition.values.join("|")}${flags}`
  if (definition.kind === "or" || definition.kind === "intersection") {
    return `${definition.kind}(${definition.options.map((option) => describeSchema(option as AnyStructLike)).join(",")})${flags}`
  }
  if (definition.kind === "discriminatedUnion") {
    return `discriminated(${definition.options.map((option) => describeSchema(option as AnyStructLike)).join(",")})${flags}`
  }
  if (definition.kind === "tuple") {
    return `tuple(${definition.items.map((item) => describeSchema(item as AnyStructLike)).join(",")})${flags}`
  }
  if (definition.kind === "record")
    return `record(${describeSchema(definition.value as AnyStructLike)})${flags}`
  return `${definition.kind}${flags}`
}

function nestedObject(depth: number): { [key: string]: unknown } {
  let value: { [key: string]: unknown } = { id: "leaf" }
  for (let index = 1; index < depth; index += 1) value = { id: "x", extra: value }
  return value
}

function nestedArray(depth: number): unknown {
  let value: unknown = "leaf"
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

function deepUnknownArray(depth: number): { id: string; extra: unknown } {
  let extra: unknown = "leaf"
  for (let index = 1; index < depth; index += 1) extra = [extra]
  return { extra, id: "ok" }
}

test("portable container depth boundary matches the interpreter", () => {
  const limit = PORTABLE_VALUE_GRAPH_DEPTH_LIMIT
  const schema = struct.object({ id: struct.string() })
  const open = struct.any()
  const withinObject = nestedObject(limit)
  const overObject = nestedObject(limit + 1)
  const withinArray = nestedArray(limit)
  const overArray = nestedArray(limit + 1)
  const withinUnknown = deepUnknownArray(limit)
  const overUnknown = deepUnknownArray(limit + 1)

  expect(outcome(() => decodeJson(schema, withinObject)).startsWith("ok:")).toBe(true)
  expect(outcome(() => decodeJson(open, withinArray)).startsWith("ok:")).toBe(true)
  expect(outcome(() => decodeJson(schema, overObject))).toContain(
    `portable container depth limit ${limit}`
  )

  expectSameInterpreter(schema, withinObject)
  expectSameInterpreter(schema, overObject)
  expectSameInterpreter(open, withinArray)
  expectSameInterpreter(open, overArray)
  expectSameInterpreter(schema, withinUnknown)
  expectSameInterpreter(schema, overUnknown)
  expect(decodeJsonTree(open, withinArray)).toBe(withinArray)
})

test(`seeded differential fast path matches interpreter seed ${DIFFERENTIAL_SEED}`, () => {
  const rand = mulberry32(DIFFERENTIAL_SEED)
  for (let iteration = 0; iteration < DIFFERENTIAL_ITERATIONS; iteration += 1) {
    const schema = randomSchema(rand, 3)
    expect(compileJsonDecoder(schema)).toEqual(expect.any(Function))
    const definition = definitionOf(schema)
    const samples = mutants(validValue(schema, rand))
    if (definition.kind === "or" || definition.kind === "discriminatedUnion") {
      for (const option of definition.options)
        samples.push(validValue(option as AnyStructLike, rand))
      samples.push({ kind: "missing" }, { type: "nope" }, null)
    }
    if (definition.kind === "tuple") {
      samples.push([], [null], ["only"], [undefined, null])
      const hole = [] as unknown[]
      hole.length = 2
      hole[1] = null
      const extra = ["a"] as unknown[] & { extra?: unknown }
      extra.extra = { n: 1 }
      samples.push(hole, extra, ["a", 1, true])
    }
    if (definition.kind === "record") {
      samples.push(
        { ["__proto__"]: "x" },
        { k0: null },
        JSON.parse('{"2":"a","10":"b","__proto__":"x","":"e","constructor":"c"}'),
        { ["k".repeat(80)]: null },
        { k0: undefined }
      )
    }
    for (let index = 0; index < samples.length; index += 1) {
      const input = samples[index]
      const left = outcome(() => decodeJsonTree(schema, input))
      const right = outcome(() => decodeJson(schema, input))
      if (left !== right) {
        throw new Error(
          `seed ${DIFFERENTIAL_SEED} iteration ${iteration} sample ${index} schema ${describeSchema(schema)} input ${JSON.stringify(input)}\nleft ${left}\nright ${right}`
        )
      }
    }
  }
})

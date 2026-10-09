import { expect, test } from "bun:test"

import { encodeParsedJson, encodeValidatedJson } from "../src/codec/json"
import { compileJsonEncoder } from "../src/compile-encode"
import { StructError } from "../src/errors"
import { getStructFields, parseStructValue } from "../src/introspection"
import { struct } from "../src/index"
import { DEFINITION } from "../src/symbols"
import type { AnyStruct, AnyStructLike, RuntimeStruct, StructDefinition } from "../src/types"
import { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "../src/value-graph"

const DIFFERENTIAL_SEED = 20261009
const DIFFERENTIAL_ITERATIONS = 24

function tagged(value: unknown, seen = new WeakSet<object>()): unknown {
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
  if (typeof value === "function") return { $: "function" }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return { $: "cycle" }
    seen.add(value)
    if (Array.isArray(value)) {
      const items: unknown[] = []
      const holes: number[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) holes.push(index)
        items.push(Object.hasOwn(value, index) ? tagged(value[index], seen) : { $: "hole" })
      }
      return { holes, items, proto: "array" }
    }
    const prototype = Object.getPrototypeOf(value)
    const proto =
      prototype === null ? "null" : prototype === Object.prototype ? "Object.prototype" : "other"
    const keys = Object.keys(value)
    const values: { [key: string]: unknown } = {}
    for (const key of keys) values[key] = tagged((value as { [key: string]: unknown })[key], seen)
    return { keys, proto, values }
  }
  return value
}

function wireOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined"
  } catch (error) {
    return `throw:${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`
  }
}

function outcome(run: () => unknown): string {
  try {
    const value = run()
    return `ok:${JSON.stringify(tagged(value)) ?? "undefined"}|${wireOf(value)}`
  } catch (error) {
    if (error instanceof StructError) {
      return `struct:${JSON.stringify(tagged({ issues: error.issues, message: error.message, name: error.name }))}`
    }
    if (error instanceof Error) return `throw:${error.name}:${error.message}`
    return `throw:${String(error)}`
  }
}

function oracle(schema: AnyStructLike, input: unknown): unknown {
  return encodeParsedJson(schema, parseStructValue(schema, input))
}

function expectSame(schema: AnyStructLike, input: unknown, name: string): void {
  const actual = outcome(() => encodeValidatedJson(schema, input))
  const expected = outcome(() => oracle(schema, input))
  if (actual !== expected) {
    throw new Error(`${name}\nactual ${actual}\nexpected ${expected}`)
  }
}

function containers(count: number): unknown {
  let value: unknown = { end: true }
  for (let index = 1; index < count; index += 1) value = [value]
  return value
}

test("hand-written encode fast path matches the interpreter", () => {
  const user = struct.object({
    z: struct.string(),
    a: struct.number(),
    m: struct.boolean().optional(),
    n: struct.string().nullable(),
    k: struct.string().nullish()
  })
  const hole = [1]
  hole.length = 3
  hole[2] = 2
  const withJson = {
    a: "x",
    extra: 1,
    toJSON() {
      return { hijack: true }
    }
  }
  const protoInput = Object.create(null) as { [key: string]: unknown }
  protoInput["__proto__"] = "p"
  protoInput.id = "i"
  protoInput.extra = true
  const nullInput = Object.create(null) as { a: string; extra: number }
  nullInput.a = "x"
  nullInput.extra = 1
  const body = { kept: 1 }
  const blob = new Blob(["hi"], { type: "text/plain" })
  const file = new File(["hi"], "a.txt", { type: "text/plain" })
  const bytes = new ArrayBuffer(4)
  const cycled = { id: "x", extra: {} as { self?: unknown } }
  cycled.extra.self = cycled.extra
  const array = [1] as unknown[] & { extra?: unknown }
  const arrayCycle = {} as { self?: unknown }
  arrayCycle.self = arrayCycle
  array.extra = arrayCycle
  const hiddenCycle = {} as { self?: unknown }
  hiddenCycle.self = hiddenCycle
  const hiddenAny = {}
  Object.defineProperty(hiddenAny, "a", { enumerable: false, value: hiddenCycle })
  const child = {}
  Object.defineProperty(child, "a", { enumerable: false, value: child })
  const hiddenRoot = {}
  Object.defineProperty(hiddenRoot, "a", { enumerable: false, value: child })
  const shape: { id: AnyStruct } = { id: struct.string() }
  const cachedShape = struct.object(shape)
  shape.id = struct.number()
  const recursive = struct.object({
    id: struct.string(),
    get child() {
      return struct.array(recursive)
    }
  })
  let reads = 0
  const getter = {}
  Object.defineProperty(getter, "a", {
    enumerable: true,
    get() {
      reads += 1
      return "ok"
    }
  })
  const throwingExtra = { a: "ok" }
  Object.defineProperty(throwingExtra, "extra", {
    enumerable: true,
    get() {
      throw new Error("unread")
    }
  })
  const lying = new Proxy(
    { a: "target" },
    {
      get(target, key, receiver) {
        if (key === "a") return "from-get"
        return Reflect.get(target, key, receiver)
      }
    }
  )
  class Box {
    a = "x"
  }
  const shared = { n: 1 }
  const cases: Array<[string, AnyStructLike, unknown]> = [
    ["declaration order", user, { m: false, k: null, extra: 1, n: null, a: 0, z: "" }],
    ["omitted optional", user, { n: "x", a: 1, z: "z" }],
    ["explicit undefined", user, { n: "x", a: 1, z: "z", m: undefined, k: undefined }],
    ["negative zero", struct.number(), -0],
    ["infinity", struct.number(), Number.POSITIVE_INFINITY],
    ["negative infinity", struct.number(), Number.NEGATIVE_INFINITY],
    ["NaN", struct.number(), NaN],
    ["large integer", struct.number(), Number.MAX_SAFE_INTEGER + 2],
    ["enum keeps negative zero", struct.enum({ off: 0, on: 1 }), -0],
    ["literal rejects negative zero", struct.literal(0), -0],
    ["nullable null", struct.string().nullable(), null],
    ["optional undefined root", struct.string().optional(), undefined],
    ["sparse optional", struct.array(struct.number().optional()), hole],
    ["sparse required", struct.array(struct.number()), hole],
    ["array extra data", struct.array(struct.number()), Object.assign([1, 2], { extra: 1 })],
    ["array extra cycle", struct.array(struct.number()), array],
    [
      "nested order",
      struct.array(struct.object({ b: struct.string(), a: struct.number() })),
      [{ a: 1, b: "z", extra: true }]
    ],
    ["frozen", struct.object({ a: struct.string() }), Object.freeze({ a: "x", extra: 1 })],
    ["null prototype", struct.object({ a: struct.string() }), nullInput],
    ["toJSON input", struct.object({ a: struct.string() }), withJson],
    [
      "__proto__ key",
      struct.object({ ["__proto__"]: struct.string(), id: struct.string() }),
      protoInput
    ],
    ["any reference", struct.object({ body: struct.any() }), { body, extra: 2 }],
    ["unknown reference", struct.object({ body: struct.unknown() }), { body }],
    ["any function", struct.any(), () => 1],
    ["any bigint", struct.any(), 1n],
    ["blob", struct.blob(), blob],
    ["file", struct.file(), file],
    ["arrayBuffer", struct.arrayBuffer(), bytes],
    ["boxed string", struct.string(), new String("a")],
    ["class instance", struct.object({ a: struct.string() }), new Box()],
    [
      "alias success",
      struct.object({ name: struct.string().alias("full_name") }),
      { name: "Miao", extra: 1 }
    ],
    [
      "alias failure",
      struct.object({ name: struct.string().alias("full_name") }),
      { full_name: "Miao" }
    ],
    ["empty alias", struct.object({ name: struct.string().alias("") }), { "": "Ada" }],
    ["date", struct.date(), new Date("2020-01-01T00:00:00.000Z")],
    ["bigint", struct.bigint(), 42n],
    ["or success", struct.or(struct.string(), struct.number()), "ok"],
    ["or failure", struct.or(struct.string(), struct.number()), true],
    ["tuple", struct.tuple([struct.string(), struct.number()]), ["a", 1]],
    ["record", struct.record(struct.number()), { a: 1, b: 2 }],
    [
      "intersection",
      struct.intersection(
        struct.object({ a: struct.string() }),
        struct.object({ b: struct.number() })
      ),
      { a: "x", b: 1 }
    ],
    ["getter schema", recursive, { id: "a", child: [{ id: "b" }] }],
    ["getter input", struct.object({ a: struct.string() }), getter],
    ["unknown accessor", struct.object({ a: struct.string() }), throwingExtra],
    ["proxy get", struct.object({ a: struct.string() }), lying],
    ["cycle in unknown field", struct.object({ id: struct.string() }), cycled],
    ["cycle in any", struct.object({ a: struct.any() }), { a: cycled.extra }],
    ["non-enumerable any cycle", struct.object({ a: struct.any() }), hiddenAny],
    [
      "non-enumerable declared cycle",
      struct.object({ a: struct.object({ a: struct.object({}) }) }),
      hiddenRoot
    ],
    [
      "diamond",
      struct.object({
        a: struct.object({ n: struct.number() }),
        b: struct.object({ n: struct.number() })
      }),
      { a: shared, b: shared }
    ],
    ["shape changed after construct", cachedShape, { id: "a", extra: 1 }],
    ["shape changed rejects number", cachedShape, { id: 1 }],
    [
      "depth 1000 unknown",
      struct.object({ id: struct.string() }),
      { extra: containers(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT - 1), id: "x" }
    ],
    [
      "depth 1001 unknown",
      struct.object({ id: struct.string() }),
      { extra: containers(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT), id: "x" }
    ],
    ["empty object drops keys", struct.object({}), { leftover: { n: 1 } }],
    ["missing key", user, { a: 1 }]
  ]

  for (const [name, schema, input] of cases) {
    expectSame(schema, input, name)
  }
  expect(reads).toBe(2)
  expect(compileJsonEncoder(struct.string().alias("wire"))).toBeNull()
  expect(compileJsonEncoder(user)).toEqual(expect.any(Function))
  const anyOut = encodeValidatedJson(struct.object({ body: struct.any() }), { body }) as {
    body: unknown
  }
  expect(anyOut.body).toBe(body)
  expect(Object.is(encodeValidatedJson(struct.number(), -0), -0)).toBe(true)
})

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

function randomLeaf(rand: () => number): AnyStruct {
  const roll = rand()
  if (roll < 0.16) return struct.string()
  if (roll < 0.32) return struct.number()
  if (roll < 0.44) return struct.boolean()
  if (roll < 0.52) return struct.null()
  if (roll < 0.62) return struct.literal(rand() < 0.5 ? "ok" : 0)
  if (roll < 0.7) return struct.literal(false)
  if (roll < 0.76) return struct.literal(null)
  if (roll < 0.86) return struct.enum(["a", "b", "c"])
  if (roll < 0.93) return struct.enum({ off: 0, on: 1 })
  if (roll < 0.97) return struct.any()
  return struct.unknown()
}

function randomSchema(rand: () => number, depth: number): AnyStruct {
  if (depth <= 0 || rand() < 0.55) return modifySchema(randomLeaf(rand), rand)
  if (rand() < 0.45) return modifySchema(struct.array(randomSchema(rand, depth - 1)), rand)
  const count = 1 + Math.floor(rand() * 3)
  const shared = rand() < 0.35 ? randomSchema(rand, depth - 1) : undefined
  const shape: { [key: string]: AnyStructLike } = {}
  for (let index = 0; index < count; index += 1) {
    shape[`f${index}`] =
      shared !== undefined && (index === 0 || rand() < 0.4) ? shared : randomSchema(rand, depth - 1)
  }
  return modifySchema(struct.object(shape), rand)
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
      if (roll < 0.35) return Number.POSITIVE_INFINITY
      if (roll < 0.5) return Number.MAX_SAFE_INTEGER + 2
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
        if (child !== undefined) output[field.key] = child
      }
      return output
    }
    default:
      throw new Error(`fuzzer produced an unsupported kind ${definition.kind}`)
  }
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
  if (definition.kind === "array")
    return `${describeSchema(definition.item as AnyStructLike)}[]${flags}`
  if (definition.kind === "literal") return `literal:${JSON.stringify(definition.value)}${flags}`
  if (definition.kind === "enum") return `enum:${definition.values.join("|")}${flags}`
  return `${definition.kind}${flags}`
}

function showInput(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "undefined"
  } catch {
    return Object.prototype.toString.call(input)
  }
}

function withGetter(record: { [key: string]: unknown }): unknown {
  const keys = Object.keys(record)
  const key = keys[0]
  if (key === undefined) return record
  const current = record[key]
  const clone: { [key: string]: unknown } = { ...record }
  Object.defineProperty(clone, key, {
    enumerable: true,
    get() {
      return current
    }
  })
  return clone
}

function withUnknownCycle(record: { [key: string]: unknown }): unknown {
  const extra: { self?: unknown } = {}
  extra.self = extra
  return { ...record, extra }
}

function deepen(value: unknown): unknown {
  let current = value
  for (let index = 0; index < 8; index += 1) current = { nested: current }
  return current
}

function mutants(value: unknown): unknown[] {
  const samples: unknown[] = [value, 12345, "str", null, false, [], {}, -0, "", undefined, NaN]
  if (Array.isArray(value)) {
    samples.push(value.concat("nope"))
    const sparse = value.slice()
    delete sparse[0]
    samples.push(sparse)
    if (value.length > 0) {
      const replaced = value.slice()
      replaced[0] = { unexpected: true }
      samples.push(replaced)
    }
    const extra = value.slice() as unknown[] & { extra?: unknown }
    extra.extra = { n: 1 }
    samples.push(extra)
    return samples
  }
  if (value === null || typeof value !== "object") return samples
  const record = value as { [key: string]: unknown }
  const keys = Object.keys(record)
  samples.push({ ...record, extra: 1, zzz: { n: true } })
  samples.push(withUnknownCycle(record))
  samples.push(deepen(record))
  samples.push(withGetter(record))
  if (keys.length === 0) return samples
  const key = keys[0] as string
  const deleted = { ...record }
  delete deleted[key]
  const reversed: { [key: string]: unknown } = {}
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const reversedKey = keys[index] as string
    reversed[reversedKey] = record[reversedKey]
  }
  samples.push(
    deleted,
    { ...record, [key]: null },
    { ...record, [key]: undefined },
    { ...record, [key]: "nope" },
    { ...record, [key]: NaN },
    reversed
  )
  return samples
}

test(`seeded encode fast path matches interpreter seed ${DIFFERENTIAL_SEED}`, () => {
  const rand = mulberry32(DIFFERENTIAL_SEED)
  for (let iteration = 0; iteration < DIFFERENTIAL_ITERATIONS; iteration += 1) {
    const schema = randomSchema(rand, 3)
    expect(compileJsonEncoder(schema), `iteration ${iteration}`).toEqual(expect.any(Function))
    const samples = mutants(validValue(schema, rand))
    for (let index = 0; index < samples.length; index += 1) {
      const input = samples[index]
      const actual = outcome(() => encodeValidatedJson(schema, input))
      const expected = outcome(() => oracle(schema, input))
      if (actual !== expected) {
        throw new Error(
          `seed ${DIFFERENTIAL_SEED} iteration ${iteration} sample ${index} schema ${describeSchema(schema)} input ${showInput(input)}\nactual ${actual}\nexpected ${expected}`
        )
      }
    }
  }
})

import { describe, expect, test } from "bun:test"

import { encodeJson, encodeParsedJson, encodeValidatedJson } from "../../src/codec/json"
import { compileJsonEncoder } from "../../src/compile-encode"
import { StructError } from "../../src/errors"
import { struct } from "../../src/index"
import { parseStructValue } from "../../src/introspection"
import { parseEncodeQuiet, parseValue } from "../../src/parse"
import { createPrimitiveStruct } from "../../src/runtime"
import { OMIT } from "../../src/symbols"
import type { RuntimeStruct } from "../../src/types"
import { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "../../src/value-graph"

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
      return `struct:${JSON.stringify(tagged({ issues: error.issues, message: error.message, name: error.name }))}`
    }
    if (error instanceof Error) return `throw:${error.name}:${error.message}`
    return `throw:${String(error)}`
  }
}

function oracle(schema: Parameters<typeof parseStructValue>[0], input: unknown): unknown {
  return encodeParsedJson(schema, parseStructValue(schema, input))
}

describe("compileJsonEncoder", () => {
  test("compileJsonEncoder returns a fast path for supported schemas", () => {
    const id = struct.string()
    const address = struct.object({
      city: struct.string(),
      zip: struct.string().nullable()
    })
    const firstAddress = compileJsonEncoder(address)
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

    const encoder = compileJsonEncoder(schema)
    expect(typeof encoder).toBe("function")
    expect(compileJsonEncoder(schema)).toBe(encoder)
    expect(compileJsonEncoder(id)).toEqual(expect.any(Function))
    expect(firstAddress).toEqual(expect.any(Function))
    expect(compileJsonEncoder(address)).toBe(firstAddress)
    expect(compileJsonEncoder(struct.object({}))).toEqual(expect.any(Function))
    expect(compileJsonEncoder(struct.array(struct.string()))).toEqual(expect.any(Function))
  })

  test("compileJsonEncoder rejects unsupported schemas", () => {
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
    const compiled: Array<[Parameters<typeof compileJsonEncoder>[0], unknown]> = [
      [struct.or(struct.string(), struct.number()), "ok"],
      [
        struct.discriminatedUnion("kind", [
          struct.object({ kind: struct.literal("a"), n: struct.number() }),
          struct.object({ kind: struct.literal("b"), s: struct.string() })
        ]),
        { kind: "a", n: 1 }
      ],
      [
        struct.intersection(
          struct.object({ a: struct.string() }),
          struct.object({ b: struct.number() })
        ),
        { a: "x", b: 1 }
      ],
      [struct.tuple([struct.string(), struct.number()]), ["a", 1]],
      [struct.record(struct.string()), { a: "z" }],
      [struct.bigint(), 42n],
      [struct.date(), new Date("2020-01-01T00:00:00.000Z")],
      [struct.string().alias("wire"), "ada"],
      [struct.string().alias(""), "ada"],
      [struct.object({ name: struct.string().alias("full_name") }), { name: "Miao" }],
      [struct.array(struct.date()), [new Date("2020-01-01T00:00:00.000Z")]],
      [
        struct.array(struct.object({ name: struct.string().alias("full_name") })),
        [{ name: "Miao" }]
      ],
      [decoded, "ada"],
      [encoded, "ada"],
      [struct.object({ hooked: decoded }), { hooked: "ada" }]
    ]

    for (const [schema, input] of compiled) {
      const encoder = compileJsonEncoder(schema)
      expect(typeof encoder).toBe("function")
      expect(compileJsonEncoder(schema)).toBe(encoder)
      expect(outcome(() => encodeValidatedJson(schema, input))).toBe(
        outcome(() => oracle(schema, input))
      )
    }
    for (const schema of [recursive, struct.object({ child: recursive })]) {
      expect(compileJsonEncoder(schema)).toBeNull()
      expect(compileJsonEncoder(schema)).toBeNull()
      expect(outcome(() => encodeValidatedJson(schema, { id: "a", child: [] }))).toBe(
        outcome(() => oracle(schema, { id: "a", child: [] }))
      )
    }
    expect(compileJsonEncoder({} as never)).toBeNull()
    expect(compileJsonEncoder(1 as never)).toBeNull()

    const plain = struct.string()
    const aliased = plain.alias("wire")
    expect(typeof compileJsonEncoder(aliased)).toBe("function")
    expect(compileJsonEncoder(aliased)).toBe(compileJsonEncoder(aliased))
    expect(encodeValidatedJson(aliased, "ada")).toBe(encodeValidatedJson(plain, "ada"))
    expect(compileJsonEncoder(plain)).toEqual(expect.any(Function))
  })
})

test("compiled encoder success path matches interpreter bytes", () => {
  const user = struct.object({
    z: struct.string(),
    a: struct.number(),
    m: struct.boolean().optional(),
    n: struct.string().nullable(),
    k: struct.string().nullish()
  })
  const input = { m: false, k: null, extra: 1, n: null, a: 0, z: "" }
  const encoder = compileJsonEncoder(user)
  expect(encoder).toEqual(expect.any(Function))
  const encoded = encoder!(input)
  expect(outcome(() => encoded)).toBe(outcome(() => oracle(user, input)))
  expect(JSON.stringify(encoded)).toBe(JSON.stringify(oracle(user, input)))
  expect(Object.getPrototypeOf(encoded)).toBeNull()
  expect(Object.keys(encoded as object)).toEqual(["z", "a", "m", "n", "k"])

  const item = struct.object({ b: struct.string(), a: struct.number() })
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
  const body = { n: 1, extra: true }
  const blob = new Blob(["hi"], { type: "text/plain" })
  const file = new File(["hi"], "a.txt", { type: "text/plain" })
  const bytes = new ArrayBuffer(4)
  const cases: Array<[string, Parameters<typeof compileJsonEncoder>[0], unknown]> = [
    ["omitted optional", user, { n: "x", a: 1, z: "z" }],
    ["explicit undefined optional", user, { n: "x", a: 1, z: "z", m: undefined, k: undefined }],
    ["negative zero", struct.number(), -0],
    ["infinity", struct.number(), Number.POSITIVE_INFINITY],
    ["large integer", struct.number(), Number.MAX_SAFE_INTEGER + 2],
    ["enum keeps negative zero", struct.enum({ off: 0, on: 1 }), -0],
    ["literal string", struct.literal("ok"), "ok"],
    ["nullable null", struct.string().nullable(), null],
    ["optional root undefined", struct.string().optional(), undefined],
    ["nullable object null", struct.object({ a: struct.string() }).nullable(), null],
    ["sparse optional array", struct.array(struct.number().optional()), hole],
    [
      "array drops extra property",
      struct.array(struct.number()),
      Object.assign([1, 2], { extra: 1 })
    ],
    ["nested declaration order", struct.array(item), [{ a: 1, b: "z", extra: true }]],
    ["frozen input", struct.object({ a: struct.string() }), Object.freeze({ a: "x", extra: 1 })],
    ["null prototype input", struct.object({ a: struct.string() }), nullInput],
    ["toJSON is not copied", struct.object({ a: struct.string() }), withJson],
    [
      "__proto__ key",
      struct.object({ ["__proto__"]: struct.string(), id: struct.string() }),
      protoInput
    ],
    ["any keeps the reference", struct.object({ body: struct.any() }), { body, extra: 2 }],
    ["unknown keeps the reference", struct.object({ body: struct.unknown() }), { body }],
    ["blob passthrough", struct.blob(), blob],
    ["file passthrough", struct.file(), file],
    ["arrayBuffer passthrough", struct.arrayBuffer(), bytes],
    ["empty object", struct.object({}), { leftover: 1 }],
    ["empty array", struct.array(struct.string()), []]
  ]

  for (const [name, schema, value] of cases) {
    const compiled = compileJsonEncoder(schema)
    expect(compiled, name).toEqual(expect.any(Function))
    const actual = compiled!(value)
    const expected = oracle(schema, value)
    expect(
      outcome(() => actual),
      name
    ).toBe(outcome(() => expected))
    expect(JSON.stringify(actual), name).toBe(JSON.stringify(expected))
  }

  const anyEncoder = compileJsonEncoder(struct.object({ body: struct.any() }))
  expect((anyEncoder!({ body }) as { body: unknown }).body).toBe(body)
  const holeEncoder = compileJsonEncoder(struct.array(struct.number().optional()))
  const holeOut = holeEncoder!(hole) as unknown[]
  expect(Object.hasOwn(holeOut, 1)).toBe(true)
  expect(holeOut[1]).toBeUndefined()
  expect(compileJsonEncoder(struct.blob())!(blob)).toBe(blob)
  expect(Object.is(compileJsonEncoder(struct.number())!(-0), -0)).toBe(true)
  expect(Object.is(compileJsonEncoder(struct.number())!(Number.POSITIVE_INFINITY), Infinity)).toBe(
    true
  )
})

test("encodeValidatedJson failure matches the interpreter", () => {
  const user = struct.object({
    a: struct.number(),
    b: struct.string(),
    m: struct.boolean().optional(),
    child: struct.object({ id: struct.number() })
  })
  class Box {
    a = 1
  }
  const cases: Array<[string, Parameters<typeof encodeValidatedJson>[0], unknown]> = [
    ["wrong type", struct.number(), "no"],
    ["missing key", user, { b: "ok" }],
    ["null on optional", user, { a: 1, b: "ok", m: null, child: { id: 1 } }],
    ["null on required", struct.string(), null],
    ["NaN", struct.number(), NaN],
    ["bad enum", struct.enum(["new", "paid"]), "shipped"],
    ["literal rejects negative zero", struct.literal(0), -0],
    ["array element", struct.array(struct.number()), [1, "x"]],
    ["nested path", user, { a: 1, b: "ok", child: { id: "x" } }],
    ["stops at the first field", user, { a: "x", b: 1 }],
    ["array is not an object", user, [1]],
    ["object is not an array", struct.array(struct.string()), { 0: "a" }],
    ["class instance", struct.object({ a: struct.number() }), new Box()],
    ["undefined required root", struct.string(), undefined],
    ["any rejects null", struct.any(), null],
    ["unknown rejects null", struct.unknown(), null],
    ["null kind rejects a string", struct.null(), "x"],
    ["empty object misses fields", user, {}],
    ["literal mismatch", struct.literal("ok"), "no"],
    [
      "sparse required array",
      struct.array(struct.number()),
      (() => {
        const hole = [1]
        hole.length = 2
        return hole
      })()
    ],
    [
      "alias success",
      struct.object({ name: struct.string().alias("full_name") }),
      { name: "Miao" }
    ],
    ["alias failure", struct.object({ name: struct.string().alias("full_name") }), { name: 1 }],
    ["date success", struct.date(), new Date("2020-01-01T00:00:00.000Z")],
    ["bigint success", struct.bigint(), 42n],
    ["hooked primitive", struct.or(struct.string(), struct.number()), "ok"],
    ["hooked primitive failure", struct.or(struct.string(), struct.number()), true]
  ]

  for (const [name, schema, input] of cases) {
    expect(
      outcome(() => encodeValidatedJson(schema, input)),
      name
    ).toBe(outcome(() => oracle(schema, input)))
  }

  const schema = struct.object({ a: struct.number() })
  expect(encodeJson(schema, { a: "x" })).toEqual({ a: "x" })
  expect(outcome(() => encodeValidatedJson(schema, { a: "x" }))).toBe(
    outcome(() => oracle(schema, { a: "x" }))
  )
})

function containers(count: number): unknown {
  let value: unknown = { end: true }
  for (let index = 1; index < count; index += 1) value = [value]
  return value
}

function thrown(run: () => unknown): string {
  try {
    const value = run()
    try {
      return `ok:${JSON.stringify(value)}`
    } catch (error) {
      return `ok:${error instanceof Error ? error.name : "unstringifiable"}`
    }
  } catch (error) {
    if (error instanceof StructError) {
      return `struct:${error.message}:${JSON.stringify(error.issues.map((issue) => issue.path))}`
    }
    return `throw:${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`
  }
}

test("encode fast path keeps the interpreter graph check", () => {
  const schema = struct.object({ id: struct.string() })
  const within = { extra: containers(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT - 1), id: "x" }
  const over = { extra: containers(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT), id: "x" }
  expect(thrown(() => encodeValidatedJson(schema, within))).toBe(
    thrown(() => oracle(schema, within))
  )
  expect(thrown(() => encodeValidatedJson(schema, over))).toBe(thrown(() => oracle(schema, over)))

  const cycled = { id: "x", extra: {} as { self?: unknown } }
  cycled.extra.self = cycled.extra
  expect(thrown(() => encodeValidatedJson(schema, cycled))).toBe(
    thrown(() => oracle(schema, cycled))
  )

  const array = [1] as unknown[] & { extra?: unknown }
  const arrayCycle = {} as { self?: unknown }
  arrayCycle.self = arrayCycle
  array.extra = arrayCycle
  expect(thrown(() => encodeValidatedJson(struct.array(struct.number()), array))).toBe(
    thrown(() => oracle(struct.array(struct.number()), array))
  )

  const anySchema = struct.object({ a: struct.any() })
  const hidden = {} as { self?: unknown }
  hidden.self = hidden
  const nonEnumAny = {}
  Object.defineProperty(nonEnumAny, "a", { enumerable: false, value: hidden })
  expect(thrown(() => encodeValidatedJson(anySchema, nonEnumAny))).toBe(
    thrown(() => oracle(anySchema, nonEnumAny))
  )

  const nested = struct.object({ a: struct.object({ a: struct.object({}) }) })
  const child = {}
  Object.defineProperty(child, "a", { enumerable: false, value: child })
  const root = {}
  Object.defineProperty(root, "a", { enumerable: false, value: child })
  expect(thrown(() => encodeValidatedJson(nested, root))).toBe(thrown(() => oracle(nested, root)))

  const shared = { n: 1 }
  const diamond = struct.object({
    a: struct.object({ n: struct.number() }),
    b: struct.object({ n: struct.number() })
  })
  expect(thrown(() => encodeValidatedJson(diamond, { a: shared, b: shared }))).toBe(
    thrown(() => oracle(diamond, { a: shared, b: shared }))
  )

  let deepSchema = struct.object({})
  let deepValue: unknown = {}
  for (let index = 0; index < PORTABLE_VALUE_GRAPH_DEPTH_LIMIT; index += 1) {
    const next = {}
    Object.defineProperty(next, "a", { enumerable: false, value: deepValue })
    deepValue = next
    deepSchema = struct.object({ a: deepSchema })
  }
  expect(thrown(() => encodeValidatedJson(deepSchema, deepValue))).toBe(
    thrown(() => oracle(deepSchema, deepValue))
  )
})

test("encode accessors run once and proxy data gets rerun on fallback", () => {
  const schema = struct.object({ a: struct.string(), b: struct.string() })
  let reads = 0
  const failing = {}
  Object.defineProperty(failing, "a", {
    enumerable: true,
    get() {
      reads += 1
      return 1
    }
  })
  Object.defineProperty(failing, "b", {
    enumerable: true,
    get() {
      reads += 1
      return "ok"
    }
  })
  reads = 0
  const failed = outcome(() => encodeValidatedJson(schema, failing))
  const failedReads = reads
  reads = 0
  expect(failed).toBe(outcome(() => oracle(schema, failing)))
  expect(failedReads).toBe(1)
  expect(reads).toBe(1)

  reads = 0
  const succeeding = {}
  Object.defineProperty(succeeding, "a", {
    enumerable: true,
    get() {
      reads += 1
      return "ok"
    }
  })
  const succeeded = outcome(() =>
    encodeValidatedJson(struct.object({ a: struct.string() }), succeeding)
  )
  const succeededReads = reads
  reads = 0
  expect(succeeded).toBe(outcome(() => oracle(struct.object({ a: struct.string() }), succeeding)))
  expect(succeededReads).toBe(1)
  expect(reads).toBe(1)

  reads = 0
  const input = { a: 1 }
  Object.defineProperty(input, "b", {
    enumerable: true,
    get() {
      reads += 1
      return "no"
    }
  })
  const stopped = outcome(() => encodeValidatedJson(schema, input))
  const stoppedReads = reads
  reads = 0
  expect(stopped).toBe(outcome(() => oracle(schema, input)))
  expect(stoppedReads).toBe(0)
  expect(reads).toBe(0)

  reads = 0
  const plain = { a: "ok" }
  Object.defineProperty(plain, "extra", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error("unknown accessor")
    }
  })
  const plainSchema = struct.object({ a: struct.string() })
  const plainFast = outcome(() => encodeValidatedJson(plainSchema, plain))
  const plainReads = reads
  reads = 0
  expect(plainFast).toBe(outcome(() => oracle(plainSchema, plain)))
  expect(plainReads).toBe(0)
  expect(reads).toBe(0)

  let gets = 0
  const proxy = new Proxy(
    { a: "target", b: "kept" },
    {
      get(target, key, receiver) {
        gets += 1
        if (key === "a") return "from-get"
        return Reflect.get(target, key, receiver)
      }
    }
  )
  const proxySchema = struct.object({ a: struct.string(), b: struct.string().optional() })
  gets = 0
  const proxyOut = encodeValidatedJson(proxySchema, proxy)
  const proxyGets = gets
  gets = 0
  const proxyOracle = oracle(proxySchema, proxy)
  expect(proxyOut).toEqual(proxyOracle)
  expect(proxyGets).toBe(gets)

  gets = 0
  const badProxy = new Proxy(
    { a: "target" },
    {
      get(target, key, receiver) {
        gets += 1
        if (key === "a") return 1
        return Reflect.get(target, key, receiver)
      }
    }
  )
  const badSchema = struct.object({ a: struct.string() })
  const badOut = outcome(() => encodeValidatedJson(badSchema, badProxy))
  const badGets = gets
  gets = 0
  expect(badOut).toBe(outcome(() => oracle(badSchema, badProxy)))
  expect(badGets).toBe(2)
  expect(gets).toBe(1)

  reads = 0
  const items: unknown[] = []
  Object.defineProperty(items, "0", {
    enumerable: true,
    get() {
      reads += 1
      return "ok"
    }
  })
  const list = struct.array(struct.string())
  const listed = outcome(() => encodeValidatedJson(list, items))
  const listedReads = reads
  reads = 0
  expect(listed).toBe(outcome(() => oracle(list, items)))
  expect(listedReads).toBe(1)
  expect(reads).toBe(1)
})

test("or field schema compiles and matches interpreter bytes", () => {
  const schema = struct.object({
    id: struct.string(),
    kind: struct.or(struct.literal("a"), struct.literal("b")),
    tags: struct.array(struct.string())
  })
  const encoder = compileJsonEncoder(schema)
  expect(typeof encoder).toBe("function")
  expect(compileJsonEncoder(schema)).toBe(encoder)
  const input = { id: "x-1", kind: "a", tags: ["p", "q"], extra: true }
  const encoded = encoder!(input)
  expect(outcome(() => encoded)).toBe(outcome(() => oracle(schema, input)))
  expect(JSON.stringify(encoded)).toBe(JSON.stringify(oracle(schema, input)))
  expect(Object.getPrototypeOf(encoded)).toBeNull()
})

test("island failure falls back to the same StructError", () => {
  const schema = struct.object({
    id: struct.string(),
    kind: struct.or(struct.literal("a"), struct.literal("b"))
  })
  expect(compileJsonEncoder(schema)).toEqual(expect.any(Function))
  const input = { id: "x", kind: true }
  expect(outcome(() => encodeValidatedJson(schema, input))).toBe(
    outcome(() => oracle(schema, input))
  )
})

test("island container fails the cover check", () => {
  let hooks = 0
  const marked = createPrimitiveStruct({
    decode: (value: string) => {
      hooks += 1
      return { ok: true as const, value }
    },
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const schema = struct.object({
    name: marked,
    box: struct.tuple([struct.any()])
  })
  const encoder = compileJsonEncoder(schema)
  expect(encoder).toEqual(expect.any(Function))
  const input = { name: "ada", box: ["ok"] }
  encodeValidatedJson(schema, input)
  const original = Object.keys
  let calls = 0
  Object.keys = ((value: object) => {
    calls += 1
    return original(value)
  }) as typeof Object.keys
  try {
    hooks = 0
    const encoded = encodeValidatedJson(schema, input)
    expect(calls).toBeGreaterThan(0)
    expect(hooks).toBe(1)
    expect(JSON.stringify(encoded)).toBe(JSON.stringify(oracle(schema, input)))
  } finally {
    Object.keys = original
  }

  const cycle = {} as { self?: unknown }
  cycle.self = cycle
  const cyclic = { name: "ada", box: [cycle] }
  hooks = 0
  const cyclicOut = outcome(() => encodeValidatedJson(schema, cyclic))
  const cyclicHooks = hooks
  hooks = 0
  expect(cyclicOut).toBe(outcome(() => oracle(schema, cyclic)))
  expect(cyclicHooks).toBe(0)
  expect(hooks).toBe(0)

  const beside = { name: "ada", box: ["ok"], extra: cycle }
  hooks = 0
  const besideOut = outcome(() => encodeValidatedJson(schema, beside))
  const besideHooks = hooks
  hooks = 0
  expect(besideOut).toBe(outcome(() => oracle(schema, beside)))
  expect(besideHooks).toBe(0)
  expect(hooks).toBe(0)

  const within = {
    name: "ada",
    box: [containers(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT - 2)]
  }
  const over = {
    name: "ada",
    box: [containers(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT - 1)]
  }
  hooks = 0
  const withinOut = outcome(() => encodeValidatedJson(schema, within))
  const withinHooks = hooks
  hooks = 0
  expect(withinOut).toBe(outcome(() => oracle(schema, within)))
  expect(withinHooks).toBe(1)
  expect(hooks).toBe(1)
  hooks = 0
  const overOut = outcome(() => encodeValidatedJson(schema, over))
  const overHooks = hooks
  hooks = 0
  expect(overOut).toBe(outcome(() => oracle(schema, over)))
  expect(overHooks).toBe(0)
  expect(hooks).toBe(0)
})

test("aliased nodes compile and encode with the wire key", () => {
  const wire = struct.string().alias("wire")
  const encoder = compileJsonEncoder(wire)
  expect(typeof encoder).toBe("function")
  expect(compileJsonEncoder(wire)).toBe(encoder)
  expect(encoder!("ada")).toBe(oracle(wire, "ada"))

  const named = struct.object({ name: struct.string().alias("full_name") })
  expect(compileJsonEncoder(named)).toEqual(expect.any(Function))
  const namedInput = { name: "Miao", extra: 1 }
  const namedOut = encodeValidatedJson(named, namedInput)
  expect(JSON.stringify(namedOut)).toBe(JSON.stringify(oracle(named, namedInput)))
  expect(Object.keys(namedOut as object)).toEqual(["full_name"])

  const swapped = struct.object({
    name: struct.string().alias("full_name"),
    full_name: struct.string().alias("name")
  })
  const swappedInput = { name: "a", full_name: "b" }
  expect(JSON.stringify(encodeValidatedJson(swapped, swappedInput))).toBe(
    JSON.stringify({ full_name: "a", name: "b" })
  )
  expect(outcome(() => encodeValidatedJson(swapped, swappedInput))).toBe(
    outcome(() => oracle(swapped, swappedInput))
  )

  const empty = struct.object({ name: struct.string().alias("") })
  const emptyOut = encodeValidatedJson(empty, { name: "Ada" }) as { [key: string]: unknown }
  expect(Object.keys(emptyOut)).toEqual([""])
  expect(emptyOut[""]).toBe("Ada")

  const proto = struct.object({ name: struct.string().alias("__proto__") })
  const protoOut = encodeValidatedJson(proto, { name: "x" })
  expect(Object.getPrototypeOf(protoOut)).toBeNull()
  expect(Object.hasOwn(protoOut as object, "__proto__")).toBe(true)
  expect((protoOut as { [key: string]: unknown })["__proto__"]).toBe("x")
  expect(outcome(() => protoOut)).toBe(outcome(() => oracle(proto, { name: "x" })))

  const rooted = struct.object({ a: struct.string() }).alias("root")
  expect(compileJsonEncoder(rooted)).toEqual(expect.any(Function))
  expect(JSON.stringify(encodeValidatedJson(rooted, { a: "z" }))).toBe('{"a":"z"}')

  expect(
    JSON.stringify(encodeValidatedJson(struct.array(struct.string().alias("item")), ["a"]))
  ).toBe('["a"]')

  expect(() =>
    struct.object({
      left: struct.string().alias("k"),
      right: struct.string().alias("k")
    })
  ).toThrow(TypeError)
})

test("encode island parses in value mode without aliases", () => {
  let reads = 0
  const marked = createPrimitiveStruct({
    decode: (value: string) => {
      reads += 1
      return { ok: true as const, value }
    },
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const inner = struct.object({
    a: marked,
    b: struct.string().alias("wireB")
  })
  const schema = struct.object({ box: struct.tuple([inner]) })
  expect(compileJsonEncoder(schema)).toEqual(expect.any(Function))
  const input = { box: [{ a: "a", b: "b" }] }
  reads = 0
  const encoded = encodeValidatedJson(schema, input)
  const encodedReads = reads
  reads = 0
  const expected = oracle(schema, input)
  expect(encodedReads).toBe(1)
  expect(reads).toBe(1)
  expect(JSON.stringify(encoded)).toBe(JSON.stringify(expected))
  expect(Object.keys((encoded as { box: object[] }).box[0] as object)).toEqual(["a", "wireB"])

  const optionalTuple = struct.tuple([struct.string()]).optional() as RuntimeStruct
  const fieldMode = parseValue(optionalTuple, undefined, [], "field")
  const valueMode = parseValue(optionalTuple, undefined, [], "value")
  expect(fieldMode.ok && fieldMode.value).toBe(OMIT)
  expect(valueMode.ok && valueMode.value).toBeUndefined()
  expect(parseEncodeQuiet(optionalTuple, undefined, [])).toEqual(valueMode)

  const wrapped = struct.object({ pair: optionalTuple })
  expect(compileJsonEncoder(wrapped)).toEqual(expect.any(Function))
  for (const sample of [{}, { pair: undefined }, { pair: ["a"] }]) {
    expect(
      outcome(() => encodeValidatedJson(wrapped, sample)),
      JSON.stringify(sample)
    ).toBe(outcome(() => oracle(wrapped, sample)))
  }
  const hole = [] as unknown[]
  hole.length = 2
  hole[1] = ["z"]
  const listed = struct.array(optionalTuple)
  const listedOut = encodeValidatedJson(listed, hole) as unknown[]
  expect(outcome(() => listedOut)).toBe(outcome(() => oracle(listed, hole)))
  expect(listedOut[0]).toBeUndefined()
  expect(listedOut[0]).not.toBe(OMIT)
})

test("encode island decode hook sees the interpreter path", () => {
  const marked = createPrimitiveStruct({
    decode: (value: string, path: ReadonlyArray<number | string>) => ({
      ok: true as const,
      value: path.join(".")
    }),
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const schema = struct.object({
    box: struct.tuple([marked.alias("item")]),
    name: marked.alias("full_name"),
    tags: struct.array(marked)
  })
  const input = { box: ["a"], name: "b", tags: ["c"] }
  expect(compileJsonEncoder(schema)).toEqual(expect.any(Function))
  expect(JSON.stringify(encodeValidatedJson(schema, input))).toBe(
    JSON.stringify(oracle(schema, input))
  )
})

test("island hooks run in island order and again when a later field falls back", () => {
  const log: string[] = []
  const traced = (label: string) =>
    createPrimitiveStruct({
      decode: (value: string) => {
        log.push(`${label}:decode`)
        return { ok: true as const, value }
      },
      encode: (value: string) => {
        log.push(`${label}:encode`)
        return `${value}!`
      },
      expected: "string",
      is: (value): value is string => typeof value === "string",
      kind: "string"
    })
  const schema = struct.object({ left: traced("left"), right: traced("right") })
  expect(compileJsonEncoder(schema)).toEqual(expect.any(Function))
  log.length = 0
  const encoded = encodeValidatedJson(schema, { left: "L", right: "R" })
  expect(log).toEqual(["left:decode", "left:encode", "right:decode", "right:encode"])
  expect(JSON.stringify(encoded)).toBe('{"left":"L!","right":"R!"}')
  log.length = 0
  oracle(schema, { left: "L", right: "R" })
  expect(log).toEqual(["left:decode", "right:decode", "left:encode", "right:encode"])

  log.length = 0
  const failed = outcome(() => encodeValidatedJson(schema, { left: "L", right: 1 }))
  expect(log).toEqual(["left:decode", "left:encode", "left:decode"])
  log.length = 0
  expect(failed).toBe(outcome(() => oracle(schema, { left: "L", right: 1 })))
  expect(log).toEqual(["left:decode"])
})

test("parsed undefined omits the field and an undefined encode stays an own key", () => {
  const log: string[] = []
  const dropping = createPrimitiveStruct({
    decode: (_value: string) => {
      log.push("decode")
      return { ok: true as const, value: undefined }
    },
    encode: () => {
      log.push("encode")
      return "nope"
    },
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const schema = struct.object({ name: dropping, n: struct.number() })
  expect(compileJsonEncoder(schema)).toEqual(expect.any(Function))
  const input = { name: "Ada", n: 1 }
  log.length = 0
  const encoded = encodeValidatedJson(schema, input)
  expect(log).toEqual(["decode"])
  expect(Object.hasOwn(encoded as object, "name")).toBe(false)
  log.length = 0
  expect(outcome(() => encoded)).toBe(outcome(() => oracle(schema, input)))
  expect(log).toEqual(["decode"])

  const blanking = createPrimitiveStruct({
    decode: (value: string) => {
      log.push("decode")
      return { ok: true as const, value }
    },
    encode: () => {
      log.push("encode")
      return undefined
    },
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const blank = struct.object({ name: blanking })
  log.length = 0
  const blankOut = encodeValidatedJson(blank, { name: "Ada" })
  expect(log).toEqual(["decode", "encode"])
  expect(Object.hasOwn(blankOut as object, "name")).toBe(true)
  expect((blankOut as { name?: unknown }).name).toBeUndefined()
  log.length = 0
  expect(outcome(() => blankOut)).toBe(outcome(() => oracle(blank, { name: "Ada" })))
  expect(log).toEqual(["decode", "encode"])

  log.length = 0
  const rooted = encodeValidatedJson(dropping, "Ada")
  expect(log).toEqual(["decode", "encode"])
  expect(rooted).toBe("nope")
  log.length = 0
  expect(rooted).toBe(oracle(dropping, "Ada"))
  expect(log).toEqual(["decode", "encode"])

  log.length = 0
  const listed = encodeValidatedJson(struct.array(dropping), ["Ada"])
  expect(log).toEqual(["decode", "encode"])
  expect(listed).toEqual(["nope"])
  log.length = 0
  expect(outcome(() => listed)).toBe(outcome(() => oracle(struct.array(dropping), ["Ada"])))
  expect(log).toEqual(["decode", "encode"])
})

test("lazy getter schema stays on the interpreter", () => {
  let reads = 0
  const lazy = () =>
    struct.object({
      id: struct.string(),
      get child() {
        reads += 1
        return struct.array(struct.string())
      }
    })
  const input = { id: "a", child: ["z"] }
  const schemas = [
    lazy(),
    struct.object({ box: lazy() }),
    struct.array(lazy()),
    struct.or(struct.string(), lazy()),
    struct.tuple([lazy()]),
    struct.record(lazy()),
    struct.intersection(lazy(), struct.object({ extra: struct.number().optional() })),
    struct.discriminatedUnion("kind", [
      struct.object({ kind: struct.literal("a"), body: lazy() }),
      struct.object({ kind: struct.literal("b"), s: struct.string() })
    ])
  ]
  for (const schema of schemas) {
    reads = 0
    expect(compileJsonEncoder(schema)).toBeNull()
    expect(compileJsonEncoder(schema)).toBeNull()
    expect(reads).toBe(0)
  }
  const root = lazy()
  const again = lazy()
  reads = 0
  const fast = outcome(() => encodeValidatedJson(root, input))
  const fastReads = reads
  reads = 0
  expect(fast).toBe(outcome(() => oracle(again, input)))
  expect(fastReads).toBe(reads)
  expect(fastReads).toBeGreaterThan(0)
})

test("island field accessor is read only by the interpreter fallback", () => {
  let reads = 0
  const input = { name: "ada" }
  Object.defineProperty(input, "box", {
    enumerable: true,
    get() {
      reads += 1
      return ["ok"]
    }
  })
  const schema = struct.object({
    name: struct.string(),
    box: struct.tuple([struct.string()])
  })
  expect(compileJsonEncoder(schema)).toEqual(expect.any(Function))
  reads = 0
  const fast = outcome(() => encodeValidatedJson(schema, input))
  const fastReads = reads
  reads = 0
  expect(fast).toBe(outcome(() => oracle(schema, input)))
  expect(fastReads).toBe(1)
  expect(reads).toBe(1)
})

test("union null and ambiguous wire output match the interpreter", () => {
  const nullable = struct.or(struct.literal(null), struct.string())
  const delegated = struct.object({ v: nullable })
  for (const input of [null, "ok", 1, undefined]) {
    expect(
      outcome(() => encodeValidatedJson(nullable, input)),
      String(input)
    ).toBe(outcome(() => oracle(nullable, input)))
    expect(outcome(() => encodeValidatedJson(delegated, { v: input }))).toBe(
      outcome(() => oracle(delegated, { v: input }))
    )
  }
  const tuple = struct.tuple([struct.string()]).nullable()
  expect(encodeValidatedJson(tuple, null)).toBeNull()
  expect(outcome(() => encodeValidatedJson(tuple, null))).toBe(outcome(() => oracle(tuple, null)))

  const ambiguous = struct.or(
    struct.object({ value: struct.string().alias("text") }),
    struct.object({ value: struct.string().alias("label") })
  )
  expect(compileJsonEncoder(ambiguous)).toEqual(expect.any(Function))
  expect(outcome(() => encodeValidatedJson(ambiguous, { value: "x" }))).toBe(
    outcome(() => oracle(ambiguous, { value: "x" }))
  )
  const event = struct.discriminatedUnion("kind", [
    struct.object({ kind: struct.literal("a").alias("type"), n: struct.number() }),
    struct.object({ kind: struct.literal("b"), s: struct.string() })
  ])
  for (const input of [{ kind: "a", n: 1 }, { type: "a", n: 1 }, { n: 1 }, { kind: "b", s: "z" }]) {
    expect(
      outcome(() => encodeValidatedJson(event, input)),
      JSON.stringify(input)
    ).toBe(outcome(() => oracle(event, input)))
  }
})

test("parsed undefined encode failures match the interpreter", () => {
  const failing = (raise: () => never) =>
    createPrimitiveStruct({
      decode: () => ({ ok: true as const, value: undefined }),
      encode: () => raise(),
      expected: "string",
      is: (value): value is string => typeof value === "string",
      kind: "string"
    })
  const typed = failing(() => {
    throw new TypeError("encode-undefined")
  })
  const plain = failing(() => {
    throw new Error("encode-plain")
  })
  const cases: Array<[Parameters<typeof encodeValidatedJson>[0], unknown]> = [
    [typed, "x"],
    [plain, "x"],
    [struct.array(typed), ["x"]],
    [struct.array(plain), ["x"]]
  ]
  for (const [schema, input] of cases) {
    expect(compileJsonEncoder(schema)).toEqual(expect.any(Function))
    expect(outcome(() => encodeValidatedJson(schema, input))).toBe(
      outcome(() => oracle(schema, input))
    )
  }
})

test("island rethrows a non-struct hook error", () => {
  const boom = createPrimitiveStruct({
    decode: () => {
      throw new Error("boom")
    },
    expected: "string",
    is: (value): value is string => typeof value === "string",
    kind: "string"
  })
  const schema = struct.object({ a: boom })
  expect(compileJsonEncoder(schema)).toEqual(expect.any(Function))
  expect(outcome(() => encodeValidatedJson(schema, { a: "x" }))).toBe(
    outcome(() => oracle(schema, { a: "x" }))
  )
})

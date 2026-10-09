import { describe, expect, test } from "bun:test"

import { encodeJson, encodeParsedJson, encodeValidatedJson } from "../../src/codec/json"
import { compileJsonEncoder } from "../../src/compile-encode"
import { StructError } from "../../src/errors"
import { struct } from "../../src/index"
import { parseStructValue } from "../../src/introspection"
import { createPrimitiveStruct } from "../../src/runtime"
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
      expect(compileJsonEncoder(schema)).toBeNull()
      expect(compileJsonEncoder(schema)).toBeNull()
    }
    expect(compileJsonEncoder({} as never)).toBeNull()
    expect(compileJsonEncoder(1 as never)).toBeNull()

    const plain = struct.string()
    expect(compileJsonEncoder(plain.alias("wire"))).toBeNull()
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

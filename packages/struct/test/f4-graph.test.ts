import { describe, expect, test } from "bun:test"
import { decodeJson, encodeJson } from "../src/codec/json"
import { StructError, struct } from "../src/index"
import { encodeStructValue } from "../src/introspection"
import type { StructLike } from "../src/types"
import { mergePlainObjects, PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "../src/value-graph"

function getterChain(depth: number): unknown {
  let value: unknown = null
  for (let index = 0; index < depth; index += 1) {
    const next = value
    value = {
      get next(): unknown {
        return next
      }
    }
  }
  return value
}

function dataChain(depth: number): unknown {
  let value: unknown = null
  for (let index = 0; index < depth; index += 1) {
    value = { next: value }
  }
  return value
}

const recursive = struct.object({
  get next(): StructLike<unknown, unknown, boolean> {
    return recursive.null()
  }
})

describe("Q3-05 direct encode getter graph", () => {
  test("rejects a getter cycle with StructError instead of RangeError", () => {
    const cyclic = {
      get next(): unknown {
        return cyclic
      }
    }
    for (const encode of [encodeStructValue, encodeJson]) {
      let error: unknown
      try {
        encode(recursive, cyclic)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(StructError)
      expect(error).not.toBeInstanceOf(RangeError)
      expect((error as Error).message).toMatch(/contains a cycle/)
    }
  })

  test("accepts 1000 getter objects and rejects 1001", () => {
    for (const encode of [encodeStructValue, encodeJson]) {
      expect(() => encode(recursive, getterChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT))).not.toThrow()
      let error: unknown
      try {
        encode(recursive, getterChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1))
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(StructError)
      expect(error).not.toBeInstanceOf(RangeError)
      expect((error as Error).message).toMatch(/depth limit 1000/)
    }
    expect(() =>
      encodeStructValue(recursive, dataChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT))
    ).not.toThrow()
  })
})

describe("Q3-06 getter materialized passthrough", () => {
  test("rejects a data cycle hidden behind an unknown or any getter", () => {
    for (const terminal of [struct.unknown(), struct.any()]) {
      const schema = struct.object({ child: terminal })
      const cycle: { self?: unknown } = {}
      cycle.self = cycle
      const [dataError] = struct.parse(schema, { child: cycle })
      let reads = 0
      const input = {
        get child(): unknown {
          reads += 1
          return cycle
        }
      }
      const [getterError, parsed] = struct.parse(schema, input)
      expect(dataError).toBeInstanceOf(StructError)
      expect(getterError).toBeInstanceOf(StructError)
      expect(parsed).toBeUndefined()
      expect(reads).toBe(1)
    }
  })

  test("F5 encodeJson rejects the getter materialized data cycle with TypeError", () => {
    for (const terminal of [struct.unknown(), struct.any()]) {
      const schema = struct.object({ child: terminal })
      const cycle: { self?: unknown } = {}
      cycle.self = cycle
      let reads = 0
      const input = {
        get child(): unknown {
          reads += 1
          return cycle
        }
      }
      let error: unknown
      try {
        encodeJson(schema, input)
      } catch (caught) {
        error = caught
      }
      expect(reads).toBe(1)
      expect(error).toBeInstanceOf(TypeError)
      expect(error).not.toBeInstanceOf(StructError)
      expect(error).not.toBeInstanceOf(RangeError)
      expect((error as Error).message).toBe("struct value contains a cycle")
    }
  })

  test("F5 encodeStructValue rejects the getter materialized data cycle with TypeError", () => {
    for (const terminal of [struct.unknown(), struct.any()]) {
      const schema = struct.object({ child: terminal })
      const cycle: { self?: unknown } = {}
      cycle.self = cycle
      const input = {
        get child(): unknown {
          return cycle
        }
      }
      let error: unknown
      try {
        encodeStructValue(schema, input)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(TypeError)
      expect(error).not.toBeInstanceOf(StructError)
      expect(error).not.toBeInstanceOf(RangeError)
      expect((error as Error).message).toBe("struct value contains a cycle")
    }
  })

  test("F5 decodeJson rejects the getter materialized data cycle with StructError", () => {
    for (const terminal of [struct.unknown(), struct.any()]) {
      const schema = struct.object({ child: terminal })
      const cycle: { self?: unknown } = {}
      cycle.self = cycle
      const input = {
        get child(): unknown {
          return cycle
        }
      }
      let error: unknown
      try {
        decodeJson(schema, input)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(StructError)
      expect(error).not.toBeInstanceOf(RangeError)
      expect((error as Error).message).toBe("struct value contains a cycle")
    }
  })

  test("F5 public entries reject a 1001-deep passthrough graph and accept 1000", () => {
    for (const terminal of [struct.unknown(), struct.any()]) {
      const schema = struct.object({ child: terminal })
      const accepted = {
        get child(): unknown {
          return dataChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT)
        }
      }
      const rejected = {
        get child(): unknown {
          return dataChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1)
        }
      }
      const [acceptedError, acceptedValue] = struct.parse(schema, accepted)
      const [rejectedError] = struct.parse(schema, rejected)
      expect(acceptedError).toBeNull()
      expect(acceptedValue?.child).toBeTypeOf("object")
      expect(rejectedError).toBeInstanceOf(StructError)
      expect((rejectedError as Error).message).toMatch(/depth limit 1000/)
      expect(() => encodeJson(schema, accepted)).not.toThrow()
      expect(() => encodeStructValue(schema, accepted)).not.toThrow()
      expect(decodeJson(schema, accepted)).toMatchObject({ child: { next: {} } })
      for (const encode of [encodeJson, encodeStructValue]) {
        let error: unknown
        try {
          encode(schema, rejected)
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(TypeError)
        expect(error).not.toBeInstanceOf(RangeError)
        expect((error as Error).message).toMatch(/depth limit 1000/)
      }
      let decoded: unknown
      try {
        decodeJson(schema, rejected)
      } catch (caught) {
        decoded = caught
      }
      expect(decoded).toBeInstanceOf(StructError)
      expect((decoded as Error).message).toMatch(/depth limit 1000/)
    }
  })

  test("F5 passthrough prescan does not invoke getters inside the materialized value", () => {
    let nestedReads = 0
    const hidden: { self?: unknown } = {}
    Object.defineProperty(hidden, "self", {
      enumerable: true,
      configurable: true,
      get(): unknown {
        nestedReads += 1
        return hidden
      }
    })
    const schema = struct.object({ child: struct.unknown() })
    const input = {
      get child(): unknown {
        return hidden
      }
    }
    const [error, parsed] = struct.parse(schema, input)
    expect(error).toBeNull()
    expect(parsed?.child).toBe(hidden)
    expect(nestedReads).toBe(0)
    expect(encodeStructValue(schema, input)).toEqual({ child: hidden })
    expect(nestedReads).toBe(0)
  })
})

function objectChain(depth: number): { n: unknown } {
  let value: unknown = { leaf: true }
  for (let index = 0; index < depth; index += 1) {
    value = { n: value }
  }
  return value as { n: unknown }
}

describe("Q3-07 nested intersection merge", () => {
  test("keeps both nested fields through parse, alias decode, encode, and JSON", () => {
    const left = struct.object({
      user: struct.object({ id: struct.string().alias("user_id") })
    })
    const right = struct.object({
      user: struct.object({ name: struct.string().alias("full_name") })
    })
    const input = { user: { id: "u1", name: "Ada" } }
    const wire = { user: { user_id: "u1", full_name: "Ada" } }
    for (const mixed of [false, true]) {
      const schema = struct.intersection(mixed ? struct.or(left, struct.number()) : left, right)
      const [error, parsed] = struct.parse(schema, input)
      expect(error).toBeNull()
      expect(parsed).toEqual({ user: { id: "u1", name: "Ada" } })
      expect(encodeJson(schema, input)).toEqual(wire)
      expect(decodeJson(schema, wire)).toEqual({ user: { id: "u1", name: "Ada" } })
      const roundTrip = JSON.parse(JSON.stringify(encodeJson(schema, input))) as unknown
      expect(decodeJson(schema, roundTrip)).toEqual({ user: { id: "u1", name: "Ada" } })
    }
  })

  test("merges 1000 nested plain objects and rejects 1001", () => {
    expect(mergePlainObjects(objectChain(999), objectChain(999))).toEqual(objectChain(999))
    let error: unknown
    try {
      mergePlainObjects(objectChain(1000), objectChain(1000))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StructError)
    expect(error).not.toBeInstanceOf(RangeError)
    expect((error as Error).message).toMatch(/depth limit 1000/)
  })

  test("keeps a shared reference and replaces values that are not plain objects", () => {
    const shared = { n: 1 }
    expect(mergePlainObjects(shared, shared)).toBe(shared)
    expect(mergePlainObjects({ flag: true }, { flag: false })).toEqual({ flag: false })
    expect(mergePlainObjects({ flag: true }, 1)).toBe(1)
    expect(mergePlainObjects(1, { flag: false })).toEqual({ flag: false })
  })
})

describe("Q4-01 non-object encode graphs", () => {
  test("rejects getter cycles for array, tuple, record, and intersection roots", () => {
    const cyclic = {
      get next(): unknown {
        return cyclic
      }
    }
    const cases = [
      ["array", struct.array(recursive), [cyclic]],
      ["tuple", struct.tuple([recursive]), [cyclic]],
      ["record", struct.record(recursive), { child: cyclic }],
      ["intersection", struct.intersection(recursive, struct.object({})), cyclic]
    ] as const
    for (const [kind, schema, input] of cases) {
      for (const encode of [encodeJson, encodeStructValue]) {
        let error: unknown
        try {
          encode(schema, input)
        } catch (caught) {
          error = caught
        }
        expect(error, kind).toBeInstanceOf(StructError)
        expect(error, kind).not.toBeInstanceOf(RangeError)
        expect((error as Error).message, kind).toMatch(/contains a cycle/)
      }
    }
  })

  test("accepts 1000 intersection getter objects and rejects 1001 from encodeJson", () => {
    const left = struct.object({
      id: struct.string(),
      get next(): StructLike<unknown, unknown, boolean> {
        return left.null()
      }
    })
    const right = struct.object({
      name: struct.string(),
      get next(): StructLike<unknown, unknown, boolean> {
        return right.null()
      }
    })
    const schema = struct.intersection(left, right)
    expect(() => encodeJson(schema, getterChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT))).not.toThrow()
    let error: unknown
    try {
      encodeJson(schema, getterChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StructError)
    expect(error).not.toBeInstanceOf(RangeError)
    expect((error as Error).message).toMatch(/depth limit 1000/)
  })
})

describe("Q4-02 union match graphs", () => {
  test("rejects a getter cycle while selecting a union branch", () => {
    const cyclic = {
      get next(): unknown {
        return cyclic
      }
    }
    const schema = struct.or(recursive, struct.number())
    expect(encodeJson(schema, getterChain(2))).toEqual(getterChain(2))
    expect(encodeStructValue(schema, 4)).toBe(4)
    for (const encode of [encodeJson, encodeStructValue]) {
      let error: unknown
      try {
        encode(schema, cyclic)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(StructError)
      expect(error).not.toBeInstanceOf(RangeError)
      expect((error as Error).message).toMatch(/contains a cycle/)
    }
  })

  test("accepts 1000 union getter objects and rejects 1001", () => {
    const schema = struct.or(recursive, struct.number())
    for (const encode of [encodeJson, encodeStructValue]) {
      expect(() => encode(schema, getterChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT))).not.toThrow()
      let error: unknown
      try {
        encode(schema, getterChain(PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1))
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(StructError)
      expect(error).not.toBeInstanceOf(RangeError)
      expect((error as Error).message).toMatch(/depth limit 1000/)
    }
  })
})

describe("Q4-03 reentrant public encode", () => {
  test("does not treat an independent nested encode as a cycle", () => {
    for (const encode of [encodeJson, encodeStructValue]) {
      const inner = struct.object({ ref: struct.unknown() })
      const outer = struct.object({ n: struct.number() })
      const input: { readonly n: number } = {
        get n(): number {
          const encoded = encode(inner, { ref: input }) as { ref: unknown }
          expect(encoded.ref).toBe(input)
          return 1
        }
      }
      expect((encode(inner, { ref: input }) as { ref: unknown }).ref).toBe(input)
      expect((encode(outer, input) as { n: number }).n).toBe(1)
    }
  })
})

describe("Q4-04 intersecting arrays", () => {
  test("merges equal arrays of plain objects by index and keeps the depth limit", () => {
    const shared = [{ id: "same" }]
    expect(mergePlainObjects(shared, shared)).toBe(shared)
    expect(mergePlainObjects([{ id: "u1" }], [{ name: "Ada" }])).toEqual([
      { id: "u1", name: "Ada" }
    ])
    expect(mergePlainObjects([1, { id: "u1" }], [2, { name: "Ada" }])).toEqual([
      2,
      { id: "u1", name: "Ada" }
    ])
    const incoming = [1, 2, 3]
    expect(() => mergePlainObjects([1], incoming)).toThrow(StructError)
    expect(mergePlainObjects([1], [2], PORTABLE_VALUE_GRAPH_DEPTH_LIMIT)).toEqual([2])
    let error: unknown
    try {
      mergePlainObjects([1], [2], PORTABLE_VALUE_GRAPH_DEPTH_LIMIT + 1)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StructError)
    expect(error).not.toBeInstanceOf(RangeError)
    expect((error as Error).message).toMatch(/depth limit 1000/)
  })

  test("keeps required fields of intersecting array elements", () => {
    const samples = [
      {
        left: struct.object({
          items: struct.array(struct.object({ id: struct.string() }))
        }),
        right: struct.object({
          items: struct.array(struct.object({ name: struct.string() }))
        }),
        input: { items: [{ id: "u1", name: "Ada" }] },
        wire: { items: [{ id: "u1", name: "Ada" }] }
      },
      {
        left: struct.object({
          items: struct.array(struct.object({ id: struct.string().alias("user_id") }))
        }),
        right: struct.object({
          items: struct.array(struct.object({ name: struct.string().alias("full_name") }))
        }),
        input: { items: [{ id: "u1", name: "Ada" }] },
        wire: { items: [{ user_id: "u1", full_name: "Ada" }] }
      }
    ]
    for (const sample of samples) {
      for (const mixed of [false, true]) {
        const schema = struct.intersection(
          mixed ? struct.or(sample.left, struct.number()) : sample.left,
          sample.right
        )
        const [error, parsed] = struct.parse(schema, sample.input)
        expect(error).toBeNull()
        expect(parsed).toEqual(sample.input)
        expect(decodeJson(schema, sample.wire)).toEqual(sample.input)
        expect(encodeJson(schema, sample.input)).toEqual(sample.wire)
        expect(encodeStructValue(schema, sample.input)).toEqual(sample.input)
        const roundTrip = JSON.parse(JSON.stringify(encodeJson(schema, sample.input))) as unknown
        expect(decodeJson(schema, roundTrip)).toEqual(sample.input)
      }
    }
  })
})

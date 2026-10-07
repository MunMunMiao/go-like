import { describe, expect, test } from "bun:test"

import { decodeJson, encodeJson } from "../src/codec/json"
import { StructError, struct } from "../src/index"
import { encodeStructValue } from "../src/introspection"
import { mergePlainObjects, PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "../src/value-graph"

const id = struct.object({ id: struct.string() })
const name = struct.object({ name: struct.string() })

/** Wraps a value in `depth` single-element arrays. */
function arrayChain(depth: number): unknown {
  let value: unknown = ["leaf"]
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

describe("Q5-01 nested intersection arrays", () => {
  test("deep-merges nested array elements through parse and encode", () => {
    for (const mixed of [false, true]) {
      for (const depth of [2, 3]) {
        let left: ReturnType<typeof struct.array> | typeof id = id
        let right: ReturnType<typeof struct.array> | typeof name = name
        let items: unknown = { id: "u1", name: "Ada" }
        for (let index = 0; index < depth; index += 1) {
          left = struct.array(left)
          right = struct.array(right)
          items = [items]
        }
        const schema = struct.intersection(
          mixed
            ? struct.or(struct.object({ items: left }), struct.number())
            : struct.object({ items: left }),
          struct.object({ items: right })
        )
        const input = { items } as {
          items: { id: string; name: string } | { id: string; name: string }[]
        }
        const [error, parsed] = struct.parse(schema, input)
        expect(error).toBeNull()
        expect(parsed).toEqual(input)
        expect(decodeJson(schema, input as never)).toEqual(input)
        expect(encodeJson(schema, input as never)).toEqual(input)
        expect(encodeStructValue(schema, input as never)).toEqual(input)
        const [again] = struct.parse(schema, encodeJson(schema, input as never))
        expect(again).toBeNull()
      }
    }
  })

  test("merges nested arrays inside the shared helper and enforces the depth limit", () => {
    expect(mergePlainObjects([[{ id: "u1" }]], [[{ name: "Ada" }]])).toEqual([
      [{ id: "u1", name: "Ada" }]
    ])
    expect(mergePlainObjects(arrayChain(999), arrayChain(999))).toEqual(arrayChain(999))
    let error: unknown
    try {
      mergePlainObjects(arrayChain(1000), arrayChain(1000))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StructError)
    expect(error).not.toBeInstanceOf(RangeError)
    expect((error as Error).message).toMatch(/depth limit 1000/)
    expect(mergePlainObjects([1], [2], PORTABLE_VALUE_GRAPH_DEPTH_LIMIT)).toEqual([2])
  })

  test("rejects unequal intersection arrays instead of dropping elements", () => {
    const left = [{ id: "u1" }, { id: "u2" }]
    const right = [{ name: "Ada" }]
    expect(() => mergePlainObjects(left, right)).toThrow(StructError)
    try {
      mergePlainObjects(left, right)
    } catch (error) {
      expect(error).toBeInstanceOf(StructError)
      expect((error as Error).message).toMatch(/different lengths/)
      expect(error).not.toBe(right)
    }

    const schema = struct.intersection(
      struct.object({ items: struct.array(id).alias("left") }),
      struct.object({ items: struct.array(name).alias("right") })
    )
    const wire = { left: [{ id: "u1" }, { id: "u2" }], right: [{ name: "Ada" }] }
    let thrown: unknown
    let parsed: ReturnType<typeof struct.parse> | undefined
    try {
      parsed = struct.parse(schema, wire, { aliases: true })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeUndefined()
    expect(parsed?.[0]).toBeInstanceOf(StructError)
    expect(parsed?.[0]?.message).toMatch(/different lengths/)
    expect(parsed?.[1]).toBeUndefined()
    expect(() => decodeJson(schema, wire)).toThrow(StructError)
  })
})

describe("Q5-02 root array and tuple intersections", () => {
  test("deep-merges a root array or tuple instead of keeping only the last side", () => {
    const input = [{ id: "u1", name: "Ada" }]
    for (const schema of [
      struct.intersection(struct.array(id), struct.array(name)),
      struct.intersection(struct.tuple([id]), struct.tuple([name]))
    ]) {
      const [error, parsed] = struct.parse(schema, input)
      expect(error).toBeNull()
      expect(parsed).toEqual(input)
      expect(decodeJson(schema, input)).toEqual(input)
      expect(encodeJson(schema, input)).toEqual(input)
      expect(encodeStructValue(schema, input)).toEqual(input)
    }
  })
})

describe("Q5-01 parse still surfaces non-merge failures", () => {
  test("rethrows a getter TypeError instead of converting it into StructError", () => {
    const input = {
      get name(): string {
        throw new TypeError("boom")
      }
    }
    expect(() => struct.parse(struct.object({ name: struct.string() }), input)).toThrow(TypeError)
  })
})

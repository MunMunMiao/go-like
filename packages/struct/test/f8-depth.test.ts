import { describe, expect, test } from "bun:test"

import { decodeJson, encodeJson } from "../src/codec/json"
import { StructError, struct } from "../src/index"
import { encodeStructValue } from "../src/introspection"
import type { StructLike } from "../src/types"

/** Builds a recursive object whose next field is a nested union. */
function nestedOrNode(): StructLike<unknown, unknown, boolean> {
  const node = struct.object({
    tag: struct.literal("node"),
    get next(): StructLike<unknown, unknown, boolean> {
      return struct.or(struct.or(node, struct.null()), struct.string())
    }
  })
  return node
}

/** Builds `depth` plain nodes ending at null. */
function chain(depth: number): unknown {
  let value: unknown = null
  for (let index = 0; index < depth; index += 1) value = { tag: "node", next: value }
  return value
}

/** Blows the call stack. The trailing addition keeps the call from being a tail call. */
function blowStack(): never {
  function recurse(depth: number): number {
    return recurse(depth + 1) + 1
  }
  return recurse(0) as never
}

describe("Q6-03 recursion depth", () => {
  test("1000 nested-or containers parse and encode without RangeError", () => {
    const schema = nestedOrNode()
    const input = chain(1000)
    const [error, parsed] = struct.parse(schema, input)
    expect(error).toBeNull()
    expect(parsed).toEqual(input)
    expect(decodeJson(schema, input)).toEqual(input)
    expect(encodeJson(schema, input)).toEqual(input)
    expect(encodeStructValue(schema, input)).toEqual(input)
  })

  test("call-stack RangeError becomes StructError and other RangeError still propagates", () => {
    const previous = Error.stackTraceLimit
    Error.stackTraceLimit = 0
    try {
      const overflowing = struct.object({
        get name(): ReturnType<typeof struct.string> {
          return blowStack()
        }
      })
      const [error, value] = struct.parse(overflowing, {})
      expect(value).toBeUndefined()
      expect(error).toBeInstanceOf(StructError)
      expect(error?.message).toContain("supported call stack depth")
      expect(error).not.toBeInstanceOf(RangeError)

      expect(() => decodeJson(overflowing, {})).toThrow(StructError)
      expect(() => encodeStructValue(overflowing, {})).toThrow(StructError)
      expect(() => encodeJson(overflowing, {})).toThrow(StructError)

      const other = struct.object({
        get name(): ReturnType<typeof struct.string> {
          throw new RangeError("alias length is invalid")
        }
      })
      expect(() => struct.parse(other, {})).toThrow(RangeError)
      try {
        struct.parse(other, {})
      } catch (caught) {
        expect(caught).toBeInstanceOf(RangeError)
        expect(caught).not.toBeInstanceOf(StructError)
        expect((caught as Error).message).toBe("alias length is invalid")
      }
    } finally {
      Error.stackTraceLimit = previous
    }
  })
})

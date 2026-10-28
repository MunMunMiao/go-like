import { expect, test } from "bun:test"

import { decodeJson, encodeJson } from "../src/codec/json"
import { struct } from "../src/index"
import { encodeStructValue } from "../src/introspection"
import type { StructLike } from "../src/types"

/** Builds a 1000-capable recursive union or discriminated object chain. */
function recursiveNode(kind: "union" | "discriminated"): StructLike<unknown, unknown, boolean> {
  const node = struct.object({
    tag: struct.literal("node"),
    get next(): StructLike<unknown, unknown, boolean> {
      return kind === "union"
        ? struct.or(node, struct.null())
        : struct.discriminatedUnion("tag", [node]).null()
    }
  })
  return node
}

/** Builds `depth` plain `{ tag, next }` nodes ending at null. */
function chain(depth: number): unknown {
  let value: unknown = null
  for (let index = 0; index < depth; index += 1) value = { tag: "node", next: value }
  return value
}

test("Q5-03 nested or() and discriminatedUnion() fields fail closed inside child matching", () => {
  const nestedOr = struct.or(
    struct.array(struct.or(struct.string(), struct.number())),
    struct.array(struct.boolean())
  )
  expect(encodeJson(nestedOr, [true])).toEqual([true])
  expect(encodeJson(nestedOr, ["ok"])).toEqual(["ok"])

  const tagged = struct.discriminatedUnion("tag", [
    struct.object({ tag: struct.literal("a"), n: struct.number() })
  ])
  const nestedTag = struct.or(struct.array(tagged), struct.array(struct.string()))
  expect(encodeJson(nestedTag, [{ tag: "a", n: 1 }])).toEqual([{ tag: "a", n: 1 }])
  expect(encodeJson(nestedTag, ["plain"])).toEqual(["plain"])
  expect(encodeJson(nestedTag, [{ tag: "nope" }])).toEqual([{ tag: "nope" }])
})

test("Q5-03 1000-deep or() and discriminatedUnion() parse and encode on the default stack", () => {
  for (const kind of ["union", "discriminated"] as const) {
    const schema = recursiveNode(kind)
    const input = chain(1000)
    const [error, parsed] = struct.parse(schema, input)
    expect(error).toBeNull()
    expect(parsed).toEqual(input)
    expect(decodeJson(schema, input)).toEqual(input)
    expect(encodeJson(schema, input)).toEqual(input)
    expect(encodeStructValue(schema, input)).toEqual(input)
  }
}, 30_000)

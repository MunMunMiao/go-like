import { describe, expect, test } from "bun:test"

import { decodeJson, encodeJson } from "../src/codec/json"
import { StructError, struct } from "../src/index"
import { encodeStructValue } from "../src/introspection"
import { decodeJsonBody, encodeJsonBody } from "../../transport/src/json"
import type { Struct, StructLike } from "../src/types"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Outcome = { ok: false } | { ok: true; value: unknown }

/** Copies null-prototype objects into ordinary objects for deep equality. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === "object") {
    if (value instanceof Uint8Array) return decoder.decode(value)
    const output: { [key: string]: unknown } = {}
    for (const key of Object.keys(value)) output[key] = plain(Reflect.get(value, key))
    return output
  }
  return value
}

/** Parses one schema and keeps only success versus failure. */
function parseOutcome(schema: StructLike<unknown, unknown, boolean>, input: unknown): Outcome {
  const [error, value] = struct.parse(schema, input)
  if (error) return { ok: false }
  return { ok: true, value: plain(value) }
}

/** Runs one entry, mapping StructError and TypeError to failure. */
function callOutcome(run: () => unknown): Outcome {
  try {
    return { ok: true, value: plain(run()) }
  } catch (error) {
    if (error instanceof StructError || error instanceof TypeError) return { ok: false }
    throw error
  }
}

/** Reads the six public entries. JSON entries use the wire text, not the runtime value. */
function sixEntries(
  schema: Struct<unknown, unknown>,
  input: unknown,
  json: string
): { [key: string]: Outcome } {
  const decoded = JSON.parse(json) as unknown
  return {
    parse: parseOutcome(schema, input),
    decodeJson: callOutcome(() => decodeJson(schema, decoded)),
    encodeJson: callOutcome(() => encodeJson(schema, input)),
    encodeStructValue: callOutcome(() => encodeStructValue(schema, input)),
    decodeJsonBody: callOutcome(() => decodeJsonBody(schema, encoder.encode(json))),
    encodeJsonBody: callOutcome(() =>
      JSON.parse(decoder.decode(encodeJsonBody(schema, input as never)))
    )
  }
}

/** Two object structs joined, then given one presence modifier. */
function branch(modifier: "null" | "nullish" | "optional") {
  const joined = struct.intersection(
    struct.object({ a: struct.string() }),
    struct.object({ b: struct.number() })
  )
  if (modifier === "null") return joined.null()
  if (modifier === "nullish") return joined.nullish()
  return joined.optional()
}

describe("Q7-01 modified intersections stay intact inside another combinator", () => {
  test("intersecting two nullable intersections accepts null on every public entry", () => {
    const side = branch("null")
    const schema = struct.intersection(side, side)
    const accepted = { ok: true, value: null }

    expect(struct.parse(side, null)).toEqual([null, null])
    expect(sixEntries(schema, null, "null")).toEqual({
      parse: accepted,
      decodeJson: accepted,
      encodeJson: accepted,
      encodeStructValue: accepted,
      decodeJsonBody: accepted,
      encodeJsonBody: accepted
    })
  })

  test("a nullish intersection nested in an intersection or union accepts null", () => {
    const side = branch("nullish")
    const intersected = struct.intersection(side, side)
    const united = struct.or(struct.intersection(side, side), struct.string())
    const accepted = { ok: true, value: null }

    expect(sixEntries(intersected, null, "null")).toEqual({
      parse: accepted,
      decodeJson: accepted,
      encodeJson: accepted,
      encodeStructValue: accepted,
      decodeJsonBody: accepted,
      encodeJsonBody: accepted
    })
    expect(sixEntries(united, null, "null")).toEqual({
      parse: accepted,
      decodeJson: accepted,
      encodeJson: accepted,
      encodeStructValue: accepted,
      decodeJsonBody: accepted,
      encodeJsonBody: accepted
    })
  })

  test("a nullable intersection round-trips an object on every public entry", () => {
    const side = struct
      .intersection(
        struct.object({ name: struct.string().alias("full_name") }),
        struct.object({ id: struct.string().alias("account_id") })
      )
      .null()
    const schema = struct.intersection(side, side)
    const input = { id: "u_1", name: "Miao" }
    const wire = { account_id: "u_1", full_name: "Miao" }
    const parsed = { ok: true, value: input }
    const encoded = { ok: true, value: wire }

    expect(sixEntries(schema, input, JSON.stringify(wire))).toEqual({
      parse: parsed,
      decodeJson: callOutcome(() => decodeJson(schema, wire)),
      encodeJson: encoded,
      encodeStructValue: parsed,
      decodeJsonBody: parsed,
      encodeJsonBody: encoded
    })
    expect(decodeJson(schema, null)).toBeNull()
  })

  test("object().null() sides keep null without being flattened away", () => {
    const schema = struct.intersection(
      struct.object({ a: struct.string() }).null(),
      struct.object({ b: struct.number() }).null()
    )
    const accepted = { ok: true, value: null }

    expect(sixEntries(schema, null, "null")).toEqual({
      parse: accepted,
      decodeJson: accepted,
      encodeJson: accepted,
      encodeStructValue: accepted,
      decodeJsonBody: accepted,
      encodeJsonBody: accepted
    })
    expect(plain(struct.parse(schema, { a: "x", b: 1 })[1])).toEqual({ a: "x", b: 1 })
  })

  test("an unmodified nested intersection still merges object fields", () => {
    const inner = struct.intersection(
      struct.object({ a: struct.string() }),
      struct.object({ b: struct.number() })
    )
    const schema = struct.intersection(inner, struct.object({ c: struct.boolean() }))

    expect(struct.parse(schema, null)[0]).toBeInstanceOf(StructError)
    expect(plain(struct.parse(schema, { a: "x", b: 1, c: true })[1])).toEqual({
      a: "x",
      b: 1,
      c: true
    })
  })

  test("a non-optional outer intersection rejects undefined before optional sides", () => {
    const side = branch("optional")
    const schema = struct.intersection(side, side)

    expect(struct.parse(side, undefined)).toEqual([null, undefined])
    expect(struct.parse(schema, undefined)[0]).toBeInstanceOf(StructError)
    expect(struct.parse(struct.or(side, struct.string()), undefined)[0]).toBeInstanceOf(StructError)
    expect(plain(struct.parse(schema, { a: "x", b: 1 })[1])).toEqual({ a: "x", b: 1 })
  })
})

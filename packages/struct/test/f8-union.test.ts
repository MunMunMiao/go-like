import { describe, expect, test } from "bun:test"

import { decodeJson, encodeJson } from "../src/codec/json"
import { StructError, struct } from "../src/index"
import { createPrimitiveStruct } from "../src/runtime"
import type { StructLike } from "../src/types"
import { success } from "../src/utils"

const sentinel = struct.literal("%%alt%%")

type Modifier = "none" | "optional" | "null" | "nullish"

/** Copies null-prototype objects into ordinary objects for deep equality. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === "object") {
    const output: { [key: string]: unknown } = {}
    for (const key of Object.keys(value)) output[key] = plain(Reflect.get(value, key))
    return output
  }
  return value
}

/** Applies one presence modifier. `none` returns the schema unchanged. */
function modify(
  schema: StructLike<unknown, unknown, boolean>,
  modifier: Modifier
): StructLike<unknown, unknown, boolean> {
  const methods = schema as StructLike<unknown, unknown, boolean> & {
    null(): StructLike<unknown, unknown, boolean>
    nullish(): StructLike<unknown, unknown, boolean>
    optional(): StructLike<unknown, unknown, boolean>
  }
  if (modifier === "optional") return methods.optional()
  if (modifier === "null") return methods.null()
  if (modifier === "nullish") return methods.nullish()
  return schema
}

type Outcome = { ok: false } | { ok: true; value: unknown }

/** Parses one schema and keeps only success versus failure. */
function parseOutcome(
  schema: StructLike<unknown, unknown, boolean>,
  input: unknown,
  aliases: boolean
): Outcome {
  const [error, value] = struct.parse(schema, input, aliases ? { aliases: true } : undefined)
  if (error) return { ok: false }
  return { ok: true, value: plain(value) }
}

/** Decodes one schema, mapping StructError to failure. */
function decodeOutcome(schema: StructLike<unknown, unknown, boolean>, input: unknown): Outcome {
  try {
    return { ok: true, value: plain(decodeJson(schema, input)) }
  } catch (error) {
    if (error instanceof StructError) return { ok: false }
    throw error
  }
}

/** Encodes one schema, mapping StructError and TypeError to failure. */
function encodeOutcome(schema: StructLike<unknown, unknown, boolean>, input: unknown): Outcome {
  try {
    return { ok: true, value: plain(encodeJson(schema, input)) }
  } catch (error) {
    if (error instanceof StructError || error instanceof TypeError) return { ok: false }
    throw error
  }
}

/**
 * First successful branch, after the union's own undefined exclusion.
 * UnionInput strips undefined, so a non-optional union never selects an optional member for it.
 */
function firstBranch(
  branches: readonly StructLike<unknown, unknown, boolean>[],
  input: unknown,
  run: (schema: StructLike<unknown, unknown, boolean>, input: unknown) => Outcome
): Outcome {
  if (input === undefined) return { ok: false }
  for (const branch of branches) {
    const outcome = run(branch, input)
    if (outcome.ok) return outcome
  }
  return { ok: false }
}

describe("Q6-01 nullable union fast path", () => {
  test("or(object.null(), string) accepts JSON null on every public JSON entry", () => {
    const nullable = struct.object({ name: struct.string() }).null()
    const schema = struct.or(nullable, struct.string())

    expect(struct.parse(nullable, null)).toEqual([null, null])
    expect(struct.parse(schema, null)).toEqual([null, null])
    expect(decodeJson(schema, null)).toBeNull()
    expect(encodeJson(schema, null)).toBeNull()
    expect(encodeJson(nullable, null)).toBeNull()
  })

  test("object fast path matches branch-by-branch parse for modifiers", () => {
    const base = {
      array: struct.array(struct.number()),
      tuple: struct.tuple([struct.string(), struct.number()]),
      record: struct.record(struct.string()),
      literal: struct.literal("ok"),
      enum: struct.enum(["red", "blue"] as const),
      object: struct.object({ name: struct.string(), extra: struct.number().optional() }),
      aliased: struct.object({ name: struct.string().alias("wire_name") }),
      discriminatedUnion: struct.discriminatedUnion("tag", [
        struct.object({ tag: struct.literal("a"), n: struct.number() })
      ]),
      intersection: struct.intersection(
        struct.object({ name: struct.string() }),
        struct.object({ name: struct.string(), extra: struct.number().optional() })
      )
    }
    const inputs: { [key: string]: unknown[] } = {
      array: [null, undefined, [], [1, 2], [1, "x"], { extra: true }, "no"],
      tuple: [null, undefined, ["a"], ["a", 1], ["a", 1, true], "no", {}],
      record: [null, undefined, {}, { id: "a" }, { id: 1 }, [], "no"],
      literal: [null, undefined, "ok", "no", 1, {}],
      enum: [null, undefined, "red", "green", 1, {}],
      object: [
        null,
        undefined,
        {},
        { name: "ada" },
        { name: "ada", extra: 1, unknown: true },
        { name: 1 },
        { extra: 1 },
        []
      ],
      aliased: [null, undefined, {}, { name: "ada" }, { wire_name: "ada" }, { name: 1 }],
      discriminatedUnion: [
        null,
        undefined,
        {},
        { tag: "a", n: 1 },
        { tag: "a", n: 1, extra: true },
        { tag: "b", n: 1 },
        { tag: "a" },
        []
      ],
      intersection: [
        null,
        undefined,
        {},
        { name: "ada" },
        { name: "ada", extra: 2, unknown: true },
        { name: 1 },
        []
      ]
    }
    const modifiers: readonly Modifier[] = ["none", "optional", "null", "nullish"]

    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      for (const modifier of modifiers) {
        const branch = modify(base[key], modifier)
        const branches = [branch, sentinel] as const
        const union = struct.or(branch, sentinel)
        for (const input of inputs[key] ?? []) {
          for (const aliases of [false, true]) {
            const actual = parseOutcome(union, input, aliases)
            const expected = firstBranch(branches, input, (schema, value) =>
              parseOutcome(schema, value, aliases)
            )
            expect(actual).toEqual(expected)
          }
          expect(decodeOutcome(union, input)).toEqual(
            firstBranch(branches, input, (schema, value) => decodeOutcome(schema, value))
          )
          const encodedBranch = firstBranch(branches, input, (schema, value) => {
            const parsed = parseOutcome(schema, value, false)
            if (!parsed.ok) return parsed
            return encodeOutcome(schema, value)
          })
          if (encodedBranch.ok) expect(encodeOutcome(union, input)).toEqual(encodedBranch)
        }
      }
    }
  })
})

describe("Q6-02 union merge fallback", () => {
  test("continues after an intersection merge StructError and accepts the next branch", () => {
    const first = struct.intersection(
      struct.object({ items: struct.array(struct.number()).alias("left") }),
      struct.object({ items: struct.array(struct.number()).alias("right") })
    )
    const fallback = struct.object({
      left: struct.array(struct.number()),
      right: struct.array(struct.number())
    })
    const schema = struct.or(first, fallback)
    const input = { left: [1, 2], right: [3] }

    expect(struct.parse(first, input, { aliases: true })[0]).toBeInstanceOf(StructError)
    expect(struct.parse(fallback, input, { aliases: true })).toEqual([null, input])
    expect(struct.parse(schema, input, { aliases: true })).toEqual([null, input])
    expect(decodeJson(schema, input)).toEqual(input)
  })

  test("continues after a mixed intersection merge StructError", () => {
    const shrink = createPrimitiveStruct<unknown[], number[]>({
      decode: (input) => success(input.slice(0, 1) as number[]),
      expected: "shrunk array",
      is: (value): value is unknown[] => Array.isArray(value),
      kind: "string"
    })
    const mixed = struct.intersection(struct.array(struct.number()), shrink)
    const fallback = struct.array(struct.number())
    const input = [1, 2]

    expect(struct.parse(mixed, input)[0]).toBeInstanceOf(StructError)
    expect(struct.parse(struct.or(mixed, fallback), input)).toEqual([null, input])
  })
})

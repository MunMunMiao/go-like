import { expect, test } from "bun:test"

import { unionOptionsProvablyDisjoint } from "../src/compile-encode"
import { struct } from "../src/index"
import { selectUnionOptions } from "../src/match"
import { createPrimitiveStruct } from "../src/runtime"
import { DEFINITION } from "../src/symbols"
import type { RuntimeStruct, UnionDefinition } from "../src/types"

function options(...items: object[]): RuntimeStruct[] {
  return items as unknown as RuntimeStruct[]
}

const hooked = createPrimitiveStruct({
  decode: (value: string) => ({ ok: true as const, value: `${value}!` }),
  encode: (value: string) => value.toUpperCase(),
  expected: "string",
  is: (value): value is string => typeof value === "string",
  kind: "string"
})

test("provably disjoint union options", () => {
  const cases: Array<[string, RuntimeStruct[]]> = [
    ["string | number", options(struct.string(), struct.number())],
    [
      "string | number | boolean | null",
      options(struct.string(), struct.number(), struct.boolean(), struct.null())
    ],
    ["literal a | literal b", options(struct.literal("a"), struct.literal("b"))],
    ["literal 0 | literal -0", options(struct.literal(0), struct.literal(-0))],
    ["string | null", options(struct.string(), struct.null())],
    ["string | literal null", options(struct.string(), struct.literal(null))],
    ["boolean | literal 1", options(struct.boolean(), struct.literal(1))],
    ["boolean | enum strings", options(struct.boolean(), struct.enum(["a", "b"]))],
    ["number | literal NaN", options(struct.number(), struct.literal(NaN))],
    ["array | number", options(struct.array(struct.string()), struct.number())],
    [
      "object tags",
      options(
        struct.object({ n: struct.number(), tag: struct.literal("a") }),
        struct.object({ s: struct.string(), tag: struct.literal("b") })
      )
    ],
    [
      "object tag | string",
      options(struct.object({ tag: struct.literal("a"), n: struct.number() }), struct.string())
    ],
    [
      "enum strings | enum numbers",
      options(struct.enum(["a", "b"]), struct.enum({ off: 0, on: 1 }))
    ],
    ["enum | disjoint literal", options(struct.enum(["a", "b"]), struct.literal("c"))],
    ["nullable string | number", options(struct.string().nullable(), struct.number())],
    ["optional string | number", options(struct.string().optional(), struct.number())],
    ["nullish string | number", options(struct.string().nullish(), struct.number())],
    ["aliased string | number", options(struct.string().alias("wire"), struct.number())],
    ["single option", options(struct.string())],
    ["no options", options()]
  ]
  for (const [name, unionOptions] of cases) {
    expect(unionOptionsProvablyDisjoint(unionOptions), name).toBe(true)
  }
})

test("union options are not provably disjoint", () => {
  let reads = 0
  const lazy = struct.object({
    get child() {
      reads += 1
      return struct.string()
    }
  })
  const cases: Array<[string, RuntimeStruct[]]> = [
    [
      "overlapping objects",
      options(
        struct.object({ a: struct.string() }),
        struct.object({ a: struct.string(), b: struct.number() })
      )
    ],
    [
      "same literal tag",
      options(
        struct.object({ n: struct.number(), tag: struct.literal("a") }),
        struct.object({ s: struct.string(), tag: struct.literal("a") })
      )
    ],
    [
      "different literal keys",
      options(
        struct.object({ tag: struct.literal("a") }),
        struct.object({ kind: struct.literal("b") })
      )
    ],
    ["string | literal a", options(struct.string(), struct.literal("a"))],
    ["enum | literal", options(struct.enum(["a", "b"]), struct.literal("a"))],
    ["number | literal 1", options(struct.number(), struct.literal(1))],
    ["enum zero | literal -0", options(struct.enum({ off: 0 }), struct.literal(-0))],
    ["boolean | literal true", options(struct.boolean(), struct.literal(true))],
    ["hooked option", options(hooked, struct.number())],
    ["nested or", options(struct.string(), struct.or(struct.number(), struct.boolean()))],
    [
      "nested discriminatedUnion",
      options(
        struct.string(),
        struct.discriminatedUnion("kind", [
          struct.object({ kind: struct.literal("a") }),
          struct.object({ kind: struct.literal("b") })
        ])
      )
    ],
    ["any", options(struct.any(), struct.string())],
    ["unknown", options(struct.unknown(), struct.number())],
    [
      "intersection",
      options(
        struct.intersection(
          struct.object({ a: struct.string() }),
          struct.object({ b: struct.number() })
        ),
        struct.string()
      )
    ],
    ["tuple", options(struct.tuple([struct.string()]), struct.number())],
    ["record", options(struct.record(struct.string()), struct.number())],
    ["two arrays", options(struct.array(struct.string()), struct.array(struct.number()))],
    ["nullable string | null", options(struct.string().nullable(), struct.null())],
    [
      "optional string | optional number",
      options(struct.string().optional(), struct.number().optional())
    ],
    ["null | literal null", options(struct.null(), struct.literal(null))],
    ["string | string", options(struct.string(), struct.string())],
    ["date", options(struct.date(), struct.string())],
    ["bigint", options(struct.bigint(), struct.number())],
    ["blob", options(struct.blob(), struct.string())],
    ["file", options(struct.file(), struct.number())],
    ["arrayBuffer", options(struct.arrayBuffer(), struct.string())],
    ["object with hook", options(struct.object({ name: hooked }), struct.number())],
    [
      "object with nested or",
      options(
        struct.object({ name: struct.or(struct.string(), struct.number()) }),
        struct.boolean()
      )
    ],
    [
      "array of unions",
      options(struct.array(struct.or(struct.string(), struct.number())), struct.boolean())
    ],
    ["lazy object", options(lazy, struct.number())],
    ["enum NaN", options(struct.enum({ bad: NaN }), struct.literal(NaN))]
  ]
  for (const [name, unionOptions] of cases) {
    expect(unionOptionsProvablyDisjoint(unionOptions), name).toBe(false)
  }
  expect(reads).toBe(0)
})

test("classifier disjoint unions match at most one interpreter option", () => {
  const unions = [
    struct.or(struct.string(), struct.number()),
    struct.or(struct.string(), struct.number(), struct.boolean(), struct.null()),
    struct.or(struct.literal("a"), struct.literal("b")),
    struct.or(struct.literal(0), struct.literal(-0)),
    struct.or(struct.string(), struct.literal(null)),
    struct.or(struct.enum(["a", "b"]), struct.literal("c")),
    struct.or(struct.enum(["a", "b"]), struct.enum({ off: 0, on: 1 })),
    struct.or(struct.array(struct.string()), struct.number()),
    struct.or(
      struct.object({ n: struct.number(), tag: struct.literal("a") }),
      struct.object({ s: struct.string(), tag: struct.literal("b") })
    ),
    struct.or(struct.object({ tag: struct.literal("a") }), struct.string()),
    struct.or(struct.string().nullable(), struct.number()),
    struct.or(struct.boolean(), struct.literal(1))
  ]
  const values: unknown[] = [
    undefined,
    null,
    0,
    -0,
    1,
    NaN,
    Number.POSITIVE_INFINITY,
    "",
    "a",
    "b",
    "c",
    true,
    false,
    [],
    ["a"],
    ["b"],
    {},
    { tag: "a" },
    { tag: "b" },
    { tag: "a", extra: 1 },
    { n: 1, tag: "a" },
    { s: "z", tag: "b" },
    { kind: "a" },
    { kind: "b" },
    { a: "x", b: 1 },
    { tag: "a", kind: "b" }
  ]
  for (const union of unions) {
    const definition = (union as unknown as RuntimeStruct)[DEFINITION] as UnionDefinition
    expect(unionOptionsProvablyDisjoint(definition.options as unknown as RuntimeStruct[])).toBe(
      true
    )
    for (const value of values) {
      const matches = selectUnionOptions(definition.options, value)
      expect(matches.length, JSON.stringify(value)).toBeLessThanOrEqual(1)
    }
  }
})

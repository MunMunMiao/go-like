import { describe, expect, test } from "bun:test"
import {
  decodeObjectByAlias,
  encodeObjectByAlias,
  mapAliasedObjectFields
} from "../src/codec/common"
import { decodeJson, encodeJson } from "../src/codec/json"
import { encodeValue, matchesDefinition } from "../src/encode"
import { StructError } from "../src/errors"
import { struct as directStruct } from "../src/facade"
import { isStruct } from "../src/guards"
import { struct } from "../src/index"
import { resolveStructFields } from "../src/fields"
import { getStructFields, parseStructTuple as parse, parseStructValue } from "../src/introspection"
import { matchesRuntimeValue } from "../src/match"
import { buildZeroValue, isFieldRequired, parseValue, safeZeroValue } from "../src/parse"
import { DEFAULT_FLAGS, makeStruct } from "../src/runtime"
import { assertStruct, resolveObjectShape } from "../src/shape"
import { DEFINITION, OMIT } from "../src/symbols"
import type { ObjectDefinition, RuntimeStruct, StructDefinition } from "../src/types"
import { describeValue, expectedType } from "../src/utils"

function runtime(value: unknown): RuntimeStruct {
  return value as RuntimeStruct
}

function definition(value: unknown): StructDefinition {
  return runtime(value)[DEFINITION]
}

describe("struct coverage boundary cases", () => {
  test("direct runtime exports stay wired", async () => {
    const testStruct = directStruct.object({ id: directStruct.string() })

    expect(isStruct(testStruct)).toBe(true)
    expect(typeof DEFINITION).toBe("symbol")
    expect(typeof OMIT).toBe("symbol")

    expect(parseValue(runtime(directStruct.string()), "x", [], "value")).toEqual({
      ok: true,
      value: "x"
    })
    expect(encodeJson(testStruct, { id: "u_1" })).toEqual({ id: "u_1" })
    expect(decodeJson(testStruct, { id: "u_1" })).toEqual({ id: "u_1" })
  })

  test("constructor guards reject invalid enum and object definitions", () => {
    expect(() => struct.enum({} as { [key: string]: never })).toThrow(
      "enum struct requires at least one string or number value"
    )
    expect(() => struct.object(null as never)).toThrow("object struct requires a plain object")
  })

  test("internal parse tuple returns native struct validation errors", () => {
    const [error] = parse(struct.number(), "bad")
    expect(error).toBeInstanceOf(StructError)
  })

  test("encode non-matching paths and branch matchers are explicit", () => {
    expect(encodeValue(runtime(struct.array(struct.string())), "not-array")).toBe("not-array")
    expect(encodeValue(runtime(struct.tuple([struct.string()])), "not-tuple")).toBe("not-tuple")
    expect(encodeValue(runtime(struct.tuple([struct.string()])), ["x", 1])).toEqual(["x", 1])

    const requiredObject = struct.object({
      id: struct.string(),
      nickname: struct.string().optional()
    })
    expect(matchesDefinition(definition(requiredObject), {}, runtime(requiredObject))).toBe(false)
    expect(
      matchesDefinition(definition(requiredObject), { id: "u_1" }, runtime(requiredObject))
    ).toBe(true)
    expect(
      matchesDefinition(definition(requiredObject), { id: "u_1" }, runtime(struct.string()))
    ).toBe(true)

    const literalObject = struct.object({ type: struct.literal("message") })
    expect(
      matchesDefinition(definition(literalObject), { type: "count" }, runtime(literalObject))
    ).toBe(false)

    const enumObject = struct.object({ status: struct.enum(["draft", "published"]) })
    expect(
      matchesDefinition(definition(enumObject), { status: "archived" }, runtime(enumObject))
    ).toBe(false)

    expect(
      matchesDefinition(
        definition(struct.record(struct.string())),
        [],
        runtime(struct.record(struct.string()))
      )
    ).toBe(false)
    expect(
      matchesDefinition(
        definition(struct.enum(["draft", "published"])),
        "draft",
        runtime(struct.enum(["draft", "published"]))
      )
    ).toBe(true)
  })

  test("error formatting reuses existing tree nodes and root prettify paths", () => {
    const err = new StructError([
      {
        code: "custom",
        expected: "valid value",
        message: "profile failed",
        path: ["profile"],
        received: undefined
      },
      {
        code: "custom",
        expected: "valid value",
        message: "name failed",
        path: ["profile", "name"],
        received: undefined
      }
    ])

    expect(err.format()).toEqual({
      _errors: [],
      profile: {
        _errors: ["profile failed"],
        name: { _errors: ["name failed"] }
      }
    })
    expect(
      new StructError([
        {
          code: "custom",
          expected: "valid value",
          message: "root failed",
          path: [],
          received: undefined
        }
      ]).prettify()
    ).toBe("× <root>: root failed")
  })

  test("introspection and shape guards reject non-object structs", () => {
    expect(() => getStructFields(struct.string())).toThrow("object struct is required")
    expect(() => parseStructValue(struct.string(), 1)).toThrow(StructError)
    expect(() => assertStruct({}, "value")).toThrow("value must be a struct")

    const objectStruct = runtime(struct.object({ id: struct.string() }))
    const objectDefinition = objectStruct[DEFINITION] as ObjectDefinition
    const first = resolveObjectShape(objectStruct, objectDefinition)
    expect(resolveObjectShape(objectStruct, objectDefinition)).toBe(first)
  })

  test("runtime alias guard rejects non-string names", () => {
    expect(() => struct.string().alias(null as never)).toThrow("alias() requires a string name")
  })

  test("zero value helpers cover optional, nullable, any, unknown, and composite structs", () => {
    expect(isFieldRequired(definition(struct.string()))).toBe(true)
    expect(isFieldRequired(definition(struct.string().optional()))).toBe(false)
    expect(isFieldRequired(definition(struct.string().null()))).toBe(false)

    expect(safeZeroValue(runtime(struct.any()))).toBeUndefined()
    expect(safeZeroValue(runtime(struct.unknown()))).toBeUndefined()
    expect(safeZeroValue(runtime(struct.string().optional()))).toBeUndefined()
    expect(safeZeroValue(runtime(struct.string().null()))).toBeNull()
    expect(safeZeroValue(runtime(struct.string().nullish()))).toBeNull()
    expect(
      safeZeroValue(
        runtime(
          struct.object({
            optional: struct.string().optional(),
            nullable: struct.string().null(),
            nullish: struct.string().nullish()
          })
        )
      )
    ).toEqual({
      nullable: null,
      nullish: null
    })
    expect(
      buildZeroValue(runtime(struct.or(struct.string().optional(), struct.number())), [])
    ).toBeUndefined()
    expect(
      buildZeroValue(
        runtime(
          struct.discriminatedUnion("type", [
            struct.object({
              payload: struct.string().optional(),
              type: struct.literal("message")
            })
          ])
        ),
        []
      )
    ).toEqual({ type: "message" })

    // intersection zero value: both sides are plain objects → merged
    expect(
      buildZeroValue(
        runtime(
          struct.intersection(
            struct.object({ a: struct.string() }),
            struct.object({ b: struct.number() })
          )
        ),
        []
      )
    ).toEqual({
      a: "",
      b: 0
    })
    // intersection zero value: one side is not plain object → right side wins
    expect(buildZeroValue(runtime(struct.intersection(struct.string(), struct.number())), [])).toBe(
      0
    )

    const [err, value] = parse(struct.intersection(struct.any(), struct.string()), "plain")
    if (err) {
      throw err
    }
    expect(value).toBe("plain")
  })

  test("parse covers primitive, enum, and record branches", () => {
    expect(parseValue(runtime(struct.string()), null, [], "value")).toEqual({ ok: true, value: "" })
    expect(parseValue(runtime(struct.enum(["draft", "published"])), "draft", [], "value")).toEqual({
      ok: true,
      value: "draft"
    })
    expect(
      parseValue(runtime(struct.enum(["draft", "published"])), "archived", [], "value").ok
    ).toBe(false)
    expect(
      parseValue(
        runtime(struct.record(struct.string().optional())),
        { skip: undefined },
        [],
        "value"
      )
    ).toEqual({
      ok: true,
      value: {}
    })
  })

  test("expectedType covers every runtime definition kind", () => {
    const message = struct.object({ type: struct.literal("message") })
    const structs = [
      [struct.any(), "any"],
      [struct.array(struct.string()), "array<string>"],
      [struct.arrayBuffer(), "ArrayBuffer"],
      [struct.blob(), "Blob"],
      [struct.bigint(), "bigint"],
      [struct.boolean(), "boolean"],
      [struct.date(), "Date"],
      [struct.file(), "File"],
      [struct.null(), "null"],
      [struct.number(), "number"],
      [struct.string(), "string"],
      [struct.enum(["draft", "published"]), '"draft" | "published"'],
      [struct.literal("ok"), '"ok"'],
      [struct.intersection(struct.string(), struct.number()), "string & number"],
      [struct.object({ id: struct.string() }), "object"],
      [struct.or(struct.string(), struct.number()), "string | number"],
      [struct.discriminatedUnion("type", [message]), '"message"'],
      [struct.record(struct.string()), "record<string>"],
      [struct.tuple([struct.string()]), "tuple"],
      [struct.unknown(), "unknown"]
    ] as const

    for (const [struct, expected] of structs) {
      expect(expectedType(definition(struct))).toBe(expected)
    }
  })

  test("describeValue covers human-readable runtime labels", () => {
    expect(describeValue(null)).toBe("null")
    expect(describeValue(undefined)).toBe("undefined")
    expect(describeValue("x")).toBe('"x"')
    expect(describeValue(true)).toBe("true")
    expect(describeValue(new File(["x"], "avatar.png"))).toBe("File(avatar.png)")
    expect(describeValue(new Blob(["x"]))).toBe("Blob(application/octet-stream)")
    expect(describeValue(new ArrayBuffer(3))).toBe("ArrayBuffer(3)")
    expect(describeValue([])).toBe("array")
    expect(describeValue({})).toBe("object")
    expect(describeValue(Symbol("s"))).toBe("[object Symbol]")
  })

  test("aliased object codec covers skip, non-object, primitive, and nested paths", () => {
    const profile = struct.object({
      internal: struct.string(),
      name: struct.string().alias("full_name"),
      omitted: struct.string().alias("omitted")
    })

    expect(encodeObjectByAlias(struct.string(), "x")).toBe("x")
    expect(encodeObjectByAlias(profile, { name: "Miao", omitted: undefined })).toEqual({
      full_name: "Miao"
    })
    expect(() => encodeObjectByAlias(profile, "bad")).toThrow("json encode expects object value")

    const profiles = struct.array(profile)
    expect(encodeObjectByAlias(profiles, [{ name: "Miao", omitted: undefined }])).toEqual([
      { full_name: "Miao" }
    ])

    expect(decodeObjectByAlias(struct.string(), "x")).toBe("x")
    expect(decodeObjectByAlias(profile, { full_name: "Miao" })).toEqual({
      internal: "",
      name: "Miao",
      omitted: ""
    })
    expect(() => decodeObjectByAlias(profile, "bad")).toThrow("json decode expects object value")

    expect(() => decodeObjectByAlias(struct.array(profile), "bad")).toThrow(StructError)
    expect(() => decodeObjectByAlias(struct.tuple([profile]), "bad")).toThrow(StructError)
    expect(
      decodeObjectByAlias(struct.tuple([profile]), [{ full_name: "Miao" }, { untouched: true }])
    ).toEqual([{ internal: "", name: "Miao", omitted: "" }])
    expect(() => decodeObjectByAlias(struct.record(profile), "bad")).toThrow(StructError)

    const event = struct.or(
      struct.object({
        payload: struct.string().alias("body"),
        type: struct.literal("message").alias("kind")
      }),
      struct.object({
        count: struct.number().alias("count"),
        type: struct.literal("count").alias("kind")
      })
    )
    expect(() => decodeObjectByAlias(event, "bad")).toThrow(StructError)

    const discriminated = struct.discriminatedUnion("type", [
      struct.object({
        payload: struct.string().alias("body"),
        type: struct.literal("message").alias("kind")
      })
    ])
    expect(() => decodeObjectByAlias(discriminated, { kind: "unknown" })).toThrow(StructError)
  })

  test("guard helpers reject malformed struct metadata", () => {
    expect(isStruct({ [DEFINITION]: null })).toBe(false)
    expect(
      isStruct({ [DEFINITION]: { flags: { nullable: false, optional: false }, kind: "not-real" } })
    ).toBe(false)
  })

  test("union flag and alias codecs cover optional and ambiguous encode branches", () => {
    const optional = struct.string().optional()
    expect(matchesDefinition(definition(optional), undefined, runtime(optional))).toBe(true)

    const conflicting = struct.or(
      struct.object({ count: struct.number() }).alias("left"),
      struct.object({ count: struct.number() }).alias("right")
    )
    expect(() => encodeObjectByAlias(conflicting, { count: 1 })).toThrow(
      "ambiguous union encode: multiple union branches match with different wire output"
    )
  })

  test("public codecs cover repeated composites and wire-key ordering edges", () => {
    const tuple = struct.tuple([struct.string()])
    expect(decodeObjectByAlias(tuple, ["first", "untyped"])).toEqual(["first"])

    const nested = struct.object({ value: struct.number() }).alias("nested")
    expect(
      decodeObjectByAlias(struct.object({ nested }), {
        nested: { value: 1 },
        NESTED: { value: 2 }
      })
    ).toEqual({ nested: { value: 2 } })

    const record = struct.record(struct.number())
    expect(Object.keys(encodeValue(runtime(record), { a: 1, b: 2 }) as object)).toEqual(["a", "b"])
    expect(Object.keys(encodeValue(runtime(record), { a: 1, aa: 2 }) as object)).toEqual([
      "a",
      "aa"
    ])
  })

  test("public matching and parsing reject the opposite intersection and unknown tuple input", () => {
    const intersection = struct.intersection(
      struct.object({ left: struct.string() }),
      struct.object({ right: struct.number() })
    )
    expect(matchesRuntimeValue(runtime(intersection), { left: "ok", right: "bad" })).toBe(false)
    const [error, value] = parse(struct.tuple([struct.number()]), undefined)
    expect(error).toBeNull()
    expect(value).toEqual([0])
  })

  test("field and discriminator helpers cover remaining branch edges", () => {
    const duplicate = runtime(
      struct.object({
        first: struct.string().alias("same"),
        second: struct.string().alias("same")
      })
    )
    const duplicateDefinition = duplicate[DEFINITION] as ObjectDefinition
    const duplicateShape = resolveObjectShape(duplicate, duplicateDefinition)
    expect(resolveObjectShape(duplicate, duplicateDefinition)).toBe(duplicateShape)
    expect(getStructFields(duplicate)).toEqual([])

    const ambiguous = struct.discriminatedUnion("type", [
      struct.object({ type: struct.literal("a").alias("kind_a") }),
      struct.object({ type: struct.literal("b").alias("kind_b") })
    ])
    expect(() => decodeObjectByAlias(ambiguous, { kind_a: "a", kind_b: "b" })).toThrow(
      "ambiguous discriminated union discriminator"
    )
  })

  test("coverage guards cover defensive branches without changing public semantics", () => {
    const duplicateDefinition = {
      cache: {
        resolvedShape: {
          first: struct.string().alias("same"),
          second: struct.string().alias("same")
        }
      },
      flags: DEFAULT_FLAGS,
      kind: "object",
      shape: Object.create(null)
    } as ObjectDefinition
    expect(resolveStructFields(runtime(struct.object({})), duplicateDefinition)).toEqual([])

    const dateWithoutRuntimeGuard = makeStruct({
      expected: "Date",
      flags: DEFAULT_FLAGS,
      is: (value): value is Date => value instanceof Date,
      kind: "date",
      zero: () => new Date(0)
    })
    expect(matchesRuntimeValue(dateWithoutRuntimeGuard, new Date(0))).toBe(true)

    expect(() => mapAliasedObjectFields(runtime(struct.string()), {}, () => undefined)).toThrow(
      "json encode expects object struct"
    )

    const nonObjectDiscriminator = makeStruct({
      discriminator: "type",
      expected: '"text"',
      flags: DEFAULT_FLAGS,
      kind: "discriminatedUnion",
      map: new Map([["text", struct.object({ type: struct.literal("text") })]]),
      options: [struct.string() as never]
    })
    expect(decodeObjectByAlias(nonObjectDiscriminator, { type: "text" })).toEqual({ type: "text" })

    const bodyAliasOption = struct.object({ payload: struct.string().alias("body") })
    const rawDiscriminator = makeStruct({
      discriminator: "type",
      expected: '"text"',
      flags: DEFAULT_FLAGS,
      kind: "discriminatedUnion",
      map: new Map([["text", bodyAliasOption]]),
      options: [bodyAliasOption]
    })
    expect(() => decodeObjectByAlias(rawDiscriminator, { body: "hello", type: "text" })).toThrow(
      StructError
    )

    const suppressedOption = struct.object({
      type: struct.literal("text").alias("same"),
      other: struct.string().alias("same")
    })
    const suppressedUnion = struct.discriminatedUnion("type", [suppressedOption])
    expect(() => decodeObjectByAlias(suppressedUnion, { type: "text", other: "value" })).toThrow(
      StructError
    )

    const missingWireDiscriminator = struct.discriminatedUnion("type", [
      struct.object({ type: struct.literal("text").alias("kind") })
    ])
    expect(() => decodeObjectByAlias(missingWireDiscriminator, { other: "text" })).toThrow(
      StructError
    )
    expect(() => decodeObjectByAlias(missingWireDiscriminator, "not-object")).toThrow(StructError)

    let reads = 0
    const unstableObjectStruct = {
      _struct: undefined,
      get [DEFINITION]() {
        reads += 1
        return {
          flags: DEFAULT_FLAGS,
          kind: reads < 3 ? "object" : "string"
        }
      }
    }
    expect(() => decodeObjectByAlias(unstableObjectStruct as never, {})).toThrow(
      "json decode expects object struct"
    )
  })

  test("remaining parser and encoder edge paths are exercised by public codecs", () => {
    const tupleField = struct.object({ values: struct.tuple([struct.string()]) })
    expect(decodeObjectByAlias(tupleField, { values: ["first", "unknown"] })).toEqual({
      values: ["first"]
    })

    const repeatedObject = struct.object({
      nested: struct.object({ value: struct.string() }).alias("nested")
    })
    expect(
      decodeObjectByAlias(repeatedObject, {
        nested: { value: "first" },
        NESTED: { value: "second" }
      })
    ).toEqual({ nested: { value: "second" } })

    expect(
      encodeValue(runtime(struct.intersection(struct.string(), struct.number())), "not-an-object")
    ).toBe("not-an-object")
    expect(
      matchesRuntimeValue(
        runtime(
          struct.intersection(
            struct.object({ left: struct.string() }),
            struct.object({ right: struct.number() })
          )
        ),
        { left: "ok", right: 1 }
      )
    ).toBe(true)
    expect(safeZeroValue(runtime(struct.tuple([struct.string()])))).toEqual([""])

    expect(() => struct.discriminatedUnion("type", [struct.string() as never])).toThrow(
      "discriminatedUnion options must be object structs"
    )
    expect(() =>
      struct.discriminatedUnion("type", [struct.object({ type: struct.string() }) as never])
    ).toThrow('discriminator "type" must be a literal struct')
  })
})

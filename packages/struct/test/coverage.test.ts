import { describe, expect, test } from "bun:test"
import { decodeObjectByAlias, encodeObjectByAlias } from "../src/codec/common"
import { decodeJson, encodeJson } from "../src/codec/json"
import { encodeValue, matchesDefinition } from "../src/encode"
import { StructError } from "../src/errors"
import { struct as directStruct } from "../src/facade"
import { isStruct } from "../src/guards"
import { struct } from "../src/index"
import { getStructFields, parseStructTuple as parse, parseStructValue } from "../src/introspection"
import { matchesRuntimeValue } from "../src/match"
import { parseValue } from "../src/parse"
import { assertStruct } from "../src/shape"
import { DEFINITION } from "../src/symbols"
import type { RuntimeStruct } from "../src/types"
import { describeValue, expectedType } from "../src/utils"

function runtime(value: unknown): RuntimeStruct {
  return value as RuntimeStruct
}

function definition(value: unknown) {
  return runtime(value)[DEFINITION]
}

describe("struct strict boundary cases", () => {
  test("direct runtime exports stay wired", () => {
    const user = directStruct.object({ id: directStruct.string() })

    expect(isStruct(user)).toBe(true)
    expect(parseValue(runtime(directStruct.string()), "x", [], "value")).toEqual({
      ok: true,
      value: "x"
    })
    expect(encodeJson(user, { id: "u_1" })).toEqual({ id: "u_1" })
    expect(decodeJson(user, { id: "u_1" })).toEqual({ id: "u_1" })
  })

  test("constructor guards reject invalid definitions", () => {
    expect(() => struct.enum({} as { [key: string]: never })).toThrow(
      "enum struct requires at least one string or number value"
    )
    expect(() => struct.object(null as never)).toThrow("object struct requires a plain object")
    expect(() => struct.string().alias(null as never)).toThrow("alias() requires a string name")
  })

  test("internal parser and public parser return strict errors", () => {
    expect(parseValue(runtime(struct.number()), "bad", [], "value").ok).toBe(false)
    const [error, value] = parse(struct.number(), "bad")
    expect(error).toBeInstanceOf(StructError)
    expect(value).toBeUndefined()
    expect(() => parseStructValue(struct.number(), "bad")).toThrow(StructError)
  })

  test("encoder and matcher preserve non-matching values", () => {
    expect(encodeValue(runtime(struct.array(struct.string())), "not-array")).toBe("not-array")
    expect(encodeValue(runtime(struct.null()), "kept")).toBe("kept")
    expect(encodeValue(runtime(struct.tuple([struct.string()])), ["x", 1])).toEqual(["x", 1])

    const user = struct.object({ id: struct.string(), nickname: struct.string().optional() })
    expect(matchesDefinition(definition(user), {}, runtime(user))).toBe(false)
    expect(matchesDefinition(definition(user), { id: "u_1" }, runtime(user))).toBe(true)
    expect(matchesRuntimeValue(runtime(user), { id: "u_1" })).toBe(true)
    const sparse: number[] = []
    sparse[0] = 1
    sparse.length = 2
    expect(matchesRuntimeValue(runtime(struct.array(struct.number())), sparse)).toBe(true)
  })

  test("error formatting keeps the first issue and safe paths", () => {
    const error = new StructError([
      { code: "custom", expected: "value", message: "root failed", path: [], received: undefined },
      {
        code: "custom",
        expected: "value",
        message: "nested failed",
        path: ["__proto__"],
        received: undefined
      }
    ])

    expect(error.prettify()).toContain("× <root>: root failed")
    const formatted = error.format()
    expect(Object.hasOwn(formatted, "__proto__")).toBe(true)
    expect(error.flatten().formErrors).toEqual(["root failed"])
  })

  test("introspection and shape guards reject invalid inputs", () => {
    expect(() => getStructFields(struct.string())).toThrow("object struct is required")
    expect(() => assertStruct({}, "value")).toThrow("value must be a struct")
    expect(() => parseStructValue(struct.object({ id: struct.string() }), {})).toThrow(StructError)
    expect(getStructFields(struct.object({ id: struct.string().alias("user_id") }))).toEqual([
      expect.objectContaining({ alias: "user_id", key: "id" })
    ])
  })

  test("strict aliases are exact and unknown keys are dropped", () => {
    const user = struct.object({ name: struct.string().alias("full_name") })

    expect(encodeObjectByAlias(user, { name: "Miao" })).toEqual({ full_name: "Miao" })
    expect(decodeObjectByAlias(user, { full_name: "Miao" })).toEqual({ name: "Miao" })
    expect(() => decodeObjectByAlias(user, { Full_Name: "Miao" })).toThrow(StructError)
    expect(parse(user, { name: "Miao", extra: true })).toEqual([null, { name: "Miao" }])
  })

  test("strict composites retain valid values", () => {
    const profile = struct.object({ name: struct.string().alias("full_name") })
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

    expect(decodeObjectByAlias(struct.array(profile), [{ full_name: "Miao" }])).toEqual([
      { name: "Miao" }
    ])
    expect(decodeObjectByAlias(event, { body: "hello", kind: "message" })).toEqual({
      payload: "hello",
      type: "message"
    })
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

    const nullableProfile = profile.null()
    const optionalProfile = profile.optional()
    expect(encodeJson(nullableProfile, null)).toBeNull()
    expect(encodeJson(optionalProfile, undefined)).toBeUndefined()
    expect(decodeJson(nullableProfile, null)).toBeNull()
    expect(decodeJson(optionalProfile, undefined)).toBeUndefined()
  })

  test("runtime labels cover public definition kinds", () => {
    const message = struct.object({ type: struct.literal("message") })
    const cases = [
      [struct.any(), "any"],
      [struct.array(struct.string()), "array<string>"],
      [struct.arrayBuffer(), "ArrayBuffer"],
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

    for (const [value, expected] of cases) {
      expect(expectedType(definition(value))).toBe(expected)
    }
    expect(describeValue(null)).toBe("null")
    expect(describeValue(undefined)).toBe("undefined")
    expect(describeValue("x")).toBe('"x"')
  })

  test("duplicate wire keys fail while defining an object", () => {
    expect(() =>
      struct.object({ first: struct.string().alias("same"), second: struct.string().alias("same") })
    ).toThrow(TypeError)
  })
})

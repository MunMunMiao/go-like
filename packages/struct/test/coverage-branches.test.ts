import { describe, expect, test } from "bun:test"
import { mapAliasedObjectFields } from "../src/codec/common"
import { decodeJson, encodeJson } from "../src/codec/json"
import { matchesDefinition } from "../src/encode"
import { isStruct } from "../src/guards"
import { StructError, struct } from "../src/index"
import { encodeStructValue, parseStructTuple as parse } from "../src/introspection"
import { matchesRuntimeValue } from "../src/match"
import { DEFINITION } from "../src/symbols"
import type { RuntimeStruct, StructLike } from "../src/types"
import { describeValue } from "../src/utils"

function runtime(value: unknown): RuntimeStruct {
  return value as RuntimeStruct
}

function expectQuietUnionFailure(
  schema: StructLike<unknown, unknown, boolean>,
  value: unknown,
  options?: { aliases?: boolean }
): void {
  const [error, parsed] = parse(schema, value, options)

  expect(parsed).toBeUndefined()
  expect(error).toBeInstanceOf(StructError)
  expect(error?.issues).toHaveLength(1)
  expect(error?.issues[0]?.code).toBe("invalid_union")
}

describe("struct branches required by strict parsing", () => {
  test("reuses an enum member index after the first successful parse", () => {
    const status = struct.enum(["draft", "published"] as const)

    expect(parse(status, "draft")).toEqual([null, "draft"])
    expect(parse(status, "published")).toEqual([null, "published"])
    expect(parse(status, "archived")[0]).toBeInstanceOf(StructError)
  })

  test("literal numbers and booleans keep their own expected text", () => {
    expect(parse(struct.literal(1), "x")[0]?.message).toContain("Expected 1 at <root>")
    expect(parse(struct.literal(false), "x")[0]?.message).toContain("Expected false at <root>")
  })

  test("describeValue labels the remaining runtime values", () => {
    const emptyBlob = new Blob(["x"])
    const typedBlob = new Blob(["x"], { type: "text/plain" })

    expect(describeValue(1)).toBe("1")
    expect(describeValue(false)).toBe("false")
    expect(describeValue(new File(["x"], "avatar.png"))).toBe("File(avatar.png)")
    expect(describeValue(emptyBlob)).toBe(`Blob(${emptyBlob.type || "application/octet-stream"})`)
    expect(describeValue(typedBlob)).toBe(`Blob(${typedBlob.type})`)
    expect(describeValue(new ArrayBuffer(3))).toBe("ArrayBuffer(3)")
    expect(describeValue([])).toBe("array")
    expect(describeValue({ a: 1 })).toBe("object")
    expect(describeValue(Symbol("s"))).toBe("[object Symbol]")
  })

  test("rejects values that are not plain objects when encoding an object", () => {
    const user = struct.object({ id: struct.string() })

    expect(() => encodeJson(user, "no")).toThrow("json encode expects object value")
    expect(() => encodeJson(user, [])).toThrow("json encode expects object value")
    expect(() => encodeJson(user, null)).toThrow("json encode expects object value")
  })

  test("rejects a non-object struct passed to aliased field encoding", () => {
    expect(() => mapAliasedObjectFields(runtime(struct.string()), {}, () => undefined)).toThrow(
      "json encode expects object struct"
    )
  })

  test("does not accept a null definition or an unknown kind as a struct", () => {
    expect(isStruct({ [DEFINITION]: null })).toBe(false)
    expect(isStruct({ [DEFINITION]: "object" })).toBe(false)
    expect(
      isStruct({
        [DEFINITION]: { flags: { nullable: false, optional: false }, kind: "not-real" }
      })
    ).toBe(false)
  })

  test("matches an explicit undefined only when the field is optional", () => {
    const optionalName = struct.string().optional()
    const requiredName = struct.string()

    expect(
      matchesDefinition(runtime(optionalName)[DEFINITION], undefined, runtime(optionalName))
    ).toBe(true)
    expect(
      matchesDefinition(runtime(requiredName)[DEFINITION], undefined, runtime(requiredName))
    ).toBe(false)

    const user = struct.object({ id: struct.string(), nickname: struct.string().optional() })
    expect(matchesRuntimeValue(runtime(user), { id: "u_1", nickname: undefined })).toBe(true)
    expect(matchesRuntimeValue(runtime(user), { id: undefined })).toBe(false)
  })

  test("does not match a discriminated union without its discriminator", () => {
    const event = struct.discriminatedUnion("type", [
      struct.object({ payload: struct.string(), type: struct.literal("a") })
    ])

    expect(matchesRuntimeValue(runtime(event), "no")).toBe(false)
    expect(matchesRuntimeValue(runtime(event), { payload: "x" })).toBe(false)
    expect(matchesRuntimeValue(runtime(event), { payload: "x", type: "a" })).toBe(true)
  })

  test("rejects a non-object discriminated union option at runtime", () => {
    expect(() => struct.discriminatedUnion("type", [struct.string() as never])).toThrow(
      "discriminatedUnion options must be object structs"
    )
  })

  test("does not read getter fields while building a union", () => {
    let reads = 0
    const payload = struct.or(
      struct.object({ name: struct.string() }),
      struct.object({
        get later() {
          reads += 1
          return struct.string()
        }
      })
    )
    const definition = runtime(payload)[DEFINITION]

    expect(reads).toBe(0)
    expect(definition.kind === "or" && definition.uniformIdentityEncode).toBe(false)
    expect(encodeStructValue(payload, { name: "x" })).toEqual({ name: "x" })
  })

  test("encodes an object intersection that is not a plain object as itself", () => {
    const person = struct.intersection(
      struct.object({ name: struct.string() }),
      struct.object({ age: struct.number() })
    )

    expect(encodeStructValue(person, { age: 3, name: "Ada" })).toEqual({ age: 3, name: "Ada" })
    expect(encodeJson(person, { age: 3, name: "Ada" })).toEqual({ age: 3, name: "Ada" })
    expect(encodeStructValue(person, "no")).toBe("no")
    expect(encodeJson(person, ["no"])).toEqual(["no"])
    expect(encodeStructValue(person, null)).toBeNull()
  })

  test("parses mixed intersections by merging each side", () => {
    expect(parse(struct.intersection(struct.unknown(), struct.string()), "x")).toEqual([null, "x"])
    expect(parse(struct.intersection(struct.string(), struct.literal("ok")), "ok")).toEqual([
      null,
      "ok"
    ])

    const [mismatch, mismatchValue] = parse(
      struct.intersection(struct.string(), struct.number()),
      "x"
    )
    expect(mismatch).toBeInstanceOf(StructError)
    expect(mismatchValue).toBeUndefined()
    expect(mismatch?.issues).toHaveLength(1)

    const payload = { extra: true, name: "Ada" }
    const [mergedErr, merged] = parse(
      struct.intersection(struct.unknown(), struct.object({ name: struct.string() })),
      payload
    )
    expect(mergedErr).toBeNull()
    expect(merged).toEqual(payload)

    const [objectErr, objectValue] = parse(
      struct.intersection(
        struct.object({ name: struct.string() }),
        struct.object({ age: struct.number() })
      ),
      "no"
    )
    expect(objectValue).toBeUndefined()
    expect(objectErr?.issues[0]).toMatchObject({ code: "invalid_type", path: [] })
  })

  test("rejects a non-array passed to an array struct", () => {
    const [error, value] = parse(struct.array(struct.string()), "no")

    expect(value).toBeUndefined()
    expect(error?.issues[0]).toMatchObject({ code: "invalid_type", path: [] })
    expect(error?.message).toContain("Expected array at <root>, received string")
  })

  test("keeps one invalid_union when an earlier candidate fails quietly", () => {
    const event = struct.discriminatedUnion("type", [
      struct.object({ body: struct.string(), type: struct.literal("text") })
    ])
    const aliased = struct.discriminatedUnion("type", [
      struct.object({
        body: struct.string(),
        type: struct.literal("text").alias("kind")
      })
    ])

    expectQuietUnionFailure(struct.or(struct.string(), struct.number()), null)
    expectQuietUnionFailure(struct.or(struct.enum(["a"] as const), struct.number()), "no")
    expectQuietUnionFailure(struct.or(struct.tuple([struct.string()]), struct.number()), ["x", "y"])
    expectQuietUnionFailure(
      struct.or(struct.or(struct.string(), struct.number()), struct.boolean()),
      null
    )
    expectQuietUnionFailure(struct.or(event, struct.number()), {})
    expectQuietUnionFailure(struct.or(event, struct.number()), { type: "nope" })
    expectQuietUnionFailure(
      struct.or(aliased, struct.number()),
      { kind: undefined },
      { aliases: true }
    )
    expectQuietUnionFailure(
      struct.or(aliased, struct.number()),
      { kind: "nope" },
      { aliases: true }
    )
    expectQuietUnionFailure(struct.or(aliased, struct.number()), {}, { aliases: true })
  })

  test("reports an explicit undefined alias discriminator as missing", () => {
    const message = struct.discriminatedUnion("type", [
      struct.object({
        body: struct.string(),
        type: struct.literal("text").alias("kind")
      })
    ])

    const [undefinedKey, undefinedValue] = parse(message, { kind: undefined }, { aliases: true })
    expect(undefinedValue).toBeUndefined()
    expect(undefinedKey?.issues[0]).toMatchObject({ code: "missing_key", path: ["type"] })

    const [missingKey, missingValue] = parse(message, { other: 1 }, { aliases: true })
    expect(missingValue).toBeUndefined()
    expect(missingKey?.issues[0]).toMatchObject({ code: "missing_key", path: ["type"] })
    expect(() => decodeJson(message, { kind: undefined })).toThrow(StructError)
    expect(() => decodeJson(message, {})).toThrow(StructError)
  })
})

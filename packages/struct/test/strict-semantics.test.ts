import { describe, expect, test } from "bun:test"
import { decodeJson } from "../src/codec"
import * as root from "../src/index"
import { StructError, struct } from "../src/index"
import { parseStructTuple } from "../src/introspection"

const HINT = "Use optional() or nullish() if the field may be omitted"

describe("strict struct semantics", () => {
  test("rejects a missing required field and names the path", () => {
    const schema = struct.object({
      profile: struct.object({
        email: struct.string()
      })
    })
    const [error, value] = parseStructTuple(schema, { profile: {} })

    expect(error).toBeInstanceOf(StructError)
    expect(value).toBeUndefined()
    expect(error?.issues).toHaveLength(1)
    expect(error?.issues[0]).toMatchObject({ code: "missing_key", path: ["profile", "email"] })
    expect(error?.message).toContain("profile.email")
    expect(error?.message).toContain(HINT)
    expect(error?.issues[0]?.message).toContain(HINT)
  })

  test("rejects null for a non-nullable field and does not substitute a zero value", () => {
    const [error, value] = parseStructTuple(struct.string(), null)

    expect(error).toBeInstanceOf(StructError)
    expect(value).toBeUndefined()
    expect(error?.issues[0]).toMatchObject({ code: "invalid_type", received: null })
  })

  test("distinguishes optional, null, and nullish field presence", () => {
    const schema = struct.object({
      required: struct.string(),
      omitted: struct.string().optional(),
      presentNull: struct.string().null(),
      either: struct.string().nullish()
    })

    const [optionalError, optionalValue] = parseStructTuple(schema, {
      required: "ok",
      presentNull: null,
      either: null
    })
    expect(optionalError).toBeNull()
    expect(optionalValue).toEqual({ required: "ok", presentNull: null, either: null })
    expect(optionalValue && Object.hasOwn(optionalValue, "omitted")).toBe(false)

    const [missingNull, missingNullValue] = parseStructTuple(schema, {
      required: "ok",
      either: "set"
    })
    expect(missingNull).toBeInstanceOf(StructError)
    expect(missingNullValue).toBeUndefined()
    expect(missingNull?.issues[0]).toMatchObject({ code: "missing_key", path: ["presentNull"] })
    expect(missingNull?.message).toContain("presentNull")
    expect(missingNull?.message).toContain(HINT)

    const [nullOnOptional, nullOnOptionalValue] = parseStructTuple(schema, {
      required: "ok",
      omitted: null,
      presentNull: "set",
      either: "set"
    })
    expect(nullOnOptional).toBeInstanceOf(StructError)
    expect(nullOnOptionalValue).toBeUndefined()
    expect(nullOnOptional?.issues[0]?.path).toEqual(["omitted"])
  })

  test("drops unknown fields and matches wire keys exactly", () => {
    const schema = struct.object({
      name: struct.string().alias("full_name"),
      extra: struct.string().optional()
    })

    expect(decodeJson(schema, { full_name: "Ada", unused: true })).toEqual({ name: "Ada" })
    expect(() => decodeJson(schema, { Full_Name: "Ada" })).toThrow(StructError)
    expect(() => decodeJson(schema, { name: "Ada" })).toThrow(StructError)
  })

  test("treats an empty alias as the wire key", () => {
    const schema = struct.object({ name: struct.string().alias("") })

    expect(decodeJson(schema, { "": "Ada" })).toEqual({ name: "Ada" })
    expect(() => decodeJson(schema, { name: "Ada" })).toThrow(StructError)
  })

  test("rejects duplicate static wire keys when the object is defined", () => {
    expect(() =>
      struct.object({
        first: struct.string().alias("same"),
        second: struct.string().alias("same")
      })
    ).toThrow(TypeError)
    expect(() =>
      struct.object({
        first: struct.string().alias(""),
        second: struct.string().alias("")
      })
    ).toThrow(TypeError)
  })

  test("rejects duplicate wire keys on a getter shape at the first parse", () => {
    const node = struct.object({
      id: struct.string(),
      get child() {
        return struct.string().alias("id")
      }
    })

    expect(() => parseStructTuple(node, { id: "n1", child: "n2" })).toThrow(TypeError)
  })

  test("stops at the first issue without reading later getters", () => {
    const objectInput = {
      first: 1,
      get second(): string {
        throw new Error("object parser continued")
      }
    }
    const [objectError, objectValue] = parseStructTuple(
      struct.object({ first: struct.string(), second: struct.string() }),
      objectInput
    )
    expect(objectError).toBeInstanceOf(StructError)
    expect(objectValue).toBeUndefined()
    expect(objectError?.issues).toHaveLength(1)
    expect(objectError?.issues[0]?.path).toEqual(["first"])

    const arrayInput = [1, "unused"]
    Object.defineProperty(arrayInput, 1, {
      enumerable: true,
      get() {
        throw new Error("array parser continued")
      }
    })
    const [arrayError] = parseStructTuple(struct.array(struct.string()), arrayInput)
    expect(arrayError?.issues).toHaveLength(1)
    expect(arrayError?.issues[0]?.path).toEqual([0])

    const recordInput = {
      first: 1,
      get second(): string {
        throw new Error("record parser continued")
      }
    }
    const [recordError] = parseStructTuple(struct.record(struct.string()), recordInput)
    expect(recordError?.issues).toHaveLength(1)
    expect(recordError?.issues[0]?.path).toEqual(["first"])
  })

  test("struct.parse reads logical keys unless aliases is set", () => {
    const schema = struct.object({ name: struct.string().alias("full_name") })

    expect(struct.parse(schema, { name: "Ada" })).toEqual([null, { name: "Ada" }])
    const [wireError, wireValue] = struct.parse(schema, { full_name: "Ada" })
    expect(wireError).toBeInstanceOf(StructError)
    expect(wireValue).toBeUndefined()
    expect(struct.parse(schema, { full_name: "Ada" }, { aliases: true })).toEqual([
      null,
      { name: "Ada" }
    ])
    expect(decodeJson(schema, { full_name: "Ada" })).toEqual({ name: "Ada" })
  })

  test("applies errorMap only to the current parse", () => {
    const custom = struct.parse(struct.number(), "no", {
      errorMap: () => "custom message"
    })
    const standard = struct.parse(struct.number(), "no")
    const nested = struct.parse(
      struct.object({ count: struct.number() }),
      { count: "no" },
      { errorMap: () => "nested custom" }
    )

    expect(custom[0]?.issues[0]?.message).toBe("custom message")
    expect(custom[1]).toBeUndefined()
    expect(standard[0]?.issues[0]?.message).toBe("Expected number at <root>, received string")
    expect(nested[0]?.issues[0]?.message).toBe("nested custom")
    expect(nested[0]?.issues[0]?.path).toEqual(["count"])
  })

  test("does not export a global setErrorMap", () => {
    expect(Object.hasOwn(root, "setErrorMap")).toBe(false)
    expect(Object.keys(root).sort()).toEqual(["StructError", "struct"])
  })
})

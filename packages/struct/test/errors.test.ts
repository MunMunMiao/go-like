import { afterEach, describe, expect, test } from "bun:test"
import type { ErrorMap } from "../src/index"
import { StructError, setErrorMap, struct } from "../src/index"
import { parseStructTuple as parse } from "../src/introspection"

afterEach(() => {
  setErrorMap(undefined)
})

describe("StructError format / flatten / prettify", () => {
  const userStruct = struct.object({
    id: struct.string(),
    profile: struct.object({
      email: struct.string()
    }),
    tags: struct.array(struct.string())
  })

  test("format builds a nested tree of issues", () => {
    const [err] = parse(userStruct, { id: 42, profile: { email: false }, tags: [10] })
    expect(err).toBeInstanceOf(StructError)
    if (!err) {
      throw new Error("expected parse error")
    }

    const tree = err.format()
    expect(tree._errors).toEqual([])
    expect(tree["id"]).toEqual({ _errors: ["Expected string at id, received 42"] })
    expect(tree["profile"]).toEqual({
      _errors: [],
      email: { _errors: ["Expected string at profile.email, received false"] }
    })
    expect(tree["tags"]).toEqual({
      _errors: [],
      "0": { _errors: ["Expected string at tags[0], received 10"] }
    })
  })

  test("flatten groups by first path segment", () => {
    const [err] = parse(userStruct, { id: 42, profile: { email: false }, tags: [10] })
    expect(err).toBeInstanceOf(StructError)
    if (!err) {
      throw new Error("expected parse error")
    }

    const flat = err.flatten()
    expect(flat.formErrors).toEqual([])
    expect(flat.fieldErrors["id"]).toEqual(["Expected string at id, received 42"])
    expect(flat.fieldErrors["profile"]).toEqual([
      "Expected string at profile.email, received false"
    ])
    expect(flat.fieldErrors["tags"]).toEqual(["Expected string at tags[0], received 10"])
  })

  test("flatten places empty-path issues in formErrors", () => {
    const err = new StructError([
      {
        code: "custom",
        expected: "form",
        message: "a must not be empty",
        path: [],
        received: { a: "" }
      }
    ])

    const flat = err.flatten()
    expect(flat.formErrors).toEqual(["a must not be empty"])
    expect(flat.fieldErrors).toEqual({})
  })

  test("prettify renders multi-line human readable output", () => {
    const [err] = parse(userStruct, { id: 42, profile: { email: false }, tags: [10] })
    expect(err).toBeInstanceOf(StructError)
    if (!err) {
      throw new Error("expected parse error")
    }

    const text = err.prettify()
    expect(text).toContain("× id: Expected string at id, received 42")
    expect(text).toContain("× profile.email: Expected string at profile.email, received false")
    expect(text).toContain("× tags[0]: Expected string at tags[0], received 10")
  })

  test("format keeps a declared _errors field separate from node errors", () => {
    const [err] = parse(struct.object({ _errors: struct.string() }), { _errors: 42 })
    expect(err).toBeInstanceOf(StructError)
    if (!err) {
      throw new Error("expected parse error")
    }

    const tree = err.format()
    expect(tree._errors).toEqual([])
    expect(tree["\\_errors"]).toEqual({ _errors: ["Expected string at _errors, received 42"] })
  })

  test("prettify renders deep array paths without stray dots", () => {
    const matrix = struct.array(struct.array(struct.array(struct.string())))
    const [err] = parse(matrix, [[[1]]])
    expect(err).toBeInstanceOf(StructError)

    expect(err?.prettify()).toContain("× [0][0][0]: Expected string at [0][0][0], received 1")
  })

  test("prettify on empty issues falls back to a sane string", () => {
    const error = new StructError([])
    expect(error.prettify()).toBe("Struct parse failed")
  })

  test("format and flatten keep dangerous path keys as own data", () => {
    const error = new StructError([
      {
        code: "custom",
        expected: "safe",
        message: "prototype path",
        path: ["__proto__"],
        received: undefined
      },
      {
        code: "custom",
        expected: "safe",
        message: "constructor path",
        path: ["constructor"],
        received: undefined
      },
      {
        code: "custom",
        expected: "safe",
        message: "nested prototype path",
        path: ["nested", "__proto__"],
        received: undefined
      },
      {
        code: "custom",
        expected: "safe",
        message: "nested constructor path",
        path: ["nested", "constructor"],
        received: undefined
      }
    ])

    const tree = error.format()
    const flat = error.flatten()

    expect(Object.hasOwn(tree, "__proto__")).toBe(true)
    expect(Object.hasOwn(tree, "constructor")).toBe(true)
    expect(tree["__proto__"]).toEqual({ _errors: ["prototype path"] })
    expect(Object.getOwnPropertyDescriptor(tree, "constructor")?.value).toEqual({
      _errors: ["constructor path"]
    })
    const nested = Object.getOwnPropertyDescriptor(tree, "nested")?.value as Record<string, unknown>
    expect(Object.hasOwn(nested, "__proto__")).toBe(true)
    expect(Object.hasOwn(nested, "constructor")).toBe(true)
    expect(nested["__proto__"]).toEqual({ _errors: ["nested prototype path"] })
    expect(Object.getOwnPropertyDescriptor(nested, "constructor")?.value).toEqual({
      _errors: ["nested constructor path"]
    })
    expect(Object.hasOwn(flat.fieldErrors, "__proto__")).toBe(true)
    expect(Object.hasOwn(flat.fieldErrors, "constructor")).toBe(true)
    expect(flat.fieldErrors["__proto__"]).toEqual(["prototype path"])
    expect(flat.fieldErrors["constructor"]).toEqual(["constructor path"])
  })

  test("public errors do not retain or render sensitive string and object values", () => {
    const secret = "secret-token-8f7d"
    const credentials = { password: secret }
    const credentialsStruct = struct.object({
      objectValue: struct.number(),
      stringValue: struct.number()
    })

    const [error] = parse(credentialsStruct, {
      objectValue: credentials,
      stringValue: secret
    })
    if (!error) {
      throw new Error("expected parse error")
    }

    const publicError = JSON.stringify({
      flatten: error.flatten(),
      format: error.format(),
      issues: error.issues,
      message: error.message,
      prettify: error.prettify()
    })
    expect(publicError).not.toContain(secret)
    expect(publicError).not.toContain("password")
    expect(error.issues[0]?.received).not.toBe(credentials)
    expect(error.issues[1]?.received).not.toBe(secret)
  })
})

describe("errors.ts errorMap", () => {
  test("setErrorMap overrides default issue messages", () => {
    const map: ErrorMap = (issue) => {
      if (issue.code === "invalid_type") {
        return `字段 ${issue.path.join(".")} 类型不符（期望 ${issue.expected}）`
      }
      return undefined
    }
    setErrorMap(map)

    const [err] = parse(struct.string(), 42)
    expect(err).toBeInstanceOf(StructError)
    expect(err?.issues[0]?.message).toBe("字段  类型不符（期望 string）")
  })

  test("errorMap returning undefined preserves the default message", () => {
    setErrorMap(() => undefined)

    const [err] = parse(struct.string(), 42)
    expect(err).toBeInstanceOf(StructError)
    expect(err?.issues[0]?.message).toBe("Expected string at <root>, received 42")
  })

  test("clearing errorMap restores defaults", () => {
    setErrorMap(() => "custom")

    const [before] = parse(struct.string(), 42)
    expect(before).toBeInstanceOf(StructError)
    expect(before?.issues[0]?.message).toBe("custom")

    setErrorMap(undefined)

    const [after] = parse(struct.string(), 42)
    expect(after).toBeInstanceOf(StructError)
    expect(after?.issues[0]?.message).toBe("Expected string at <root>, received 42")
  })
})

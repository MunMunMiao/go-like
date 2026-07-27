import { expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@standard-schema/spec"

import { endpoint, type BodyCodec } from "../src/index"
import { jsonCodec } from "../src/json"

/** Creates one small Standard Schema v1 validator for codec tests. */
function schema<T>(
  validate: StandardSchemaV1.Props<unknown, T>["validate"]
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "likego-test",
      validate
    }
  }
}

test("captures one immutable typed endpoint and its codec methods", async () => {
  const source: BodyCodec<string> = {
    contentType: "application/test😀",
    encode(value) {
      expect(this).toBe(source)
      return new TextEncoder().encode(value)
    },
    decode(body) {
      expect(this).toBe(source)
      body[0] = 120
      return new TextDecoder().decode(body)
    }
  }
  const contract = endpoint("greeter", "Hello", source, source)
  Reflect.set(source, "encode", () => new Uint8Array())
  const body = new Uint8Array([97])

  expect(contract).toMatchObject({
    service: "greeter",
    endpoint: "Hello",
    requestCodec: { contentType: "application/test😀" },
    responseCodec: { contentType: "application/test😀" }
  })
  expect(Object.isFrozen(contract)).toBe(true)
  expect(new TextDecoder().decode(await contract.requestCodec.encode("hello"))).toBe("hello")
  expect(await contract.responseCodec.decode(body)).toBe("x")
  expect(body).toEqual(new Uint8Array([97]))
})

test("rejects malformed typed endpoint fields and codecs", () => {
  const valid: BodyCodec<string> = {
    contentType: "application/test",
    encode: () => new Uint8Array(),
    decode: () => ""
  }

  expect(() => endpoint("", "Hello", valid, valid)).toThrow(
    "transport endpoint service must be a visible ASCII route token"
  )
  expect(() => endpoint("greeter", null as never, valid, valid)).toThrow(
    "transport endpoint endpoint must be a visible ASCII route token"
  )
  expect(() => endpoint("greeter", "\ud800", valid, valid)).toThrow(
    "transport endpoint endpoint must be a visible ASCII route token"
  )
  expect(() => endpoint("greeter", "\udc00", valid, valid)).toThrow(
    "transport endpoint endpoint must be a visible ASCII route token"
  )
  for (const [service, name] of [
    ["a/b", "c"],
    ["a", "b/c"],
    ["a*", "c"],
    ["a", "b*"],
    ["a\u0000", "c"],
    ["a", "b\u001f"],
    ["a\u007f", "c"],
    [" a", "c"],
    ["a ", "c"],
    ["a", "b c"],
    ["订单", "c"],
    ["a", "é"],
    ["a", "😀"]
  ] as const) {
    expect(() => endpoint(service, name, valid, valid)).toThrow("route token")
  }
  expect(() => endpoint("greeter", "Hello", null as never, valid)).toThrow(
    "transport endpoint requestCodec must implement BodyCodec"
  )
  expect(() =>
    endpoint(
      "greeter",
      "Hello",
      { contentType: "application/test", encode: null, decode: valid.decode } as never,
      valid
    )
  ).toThrow("transport endpoint requestCodec must implement BodyCodec")
  expect(() =>
    endpoint(
      "greeter",
      "Hello",
      { contentType: "application/test", encode: valid.encode, decode: null } as never,
      valid
    )
  ).toThrow("transport endpoint requestCodec must implement BodyCodec")
  expect(() =>
    endpoint(
      "greeter",
      "Hello",
      { contentType: "", encode: valid.encode, decode: valid.decode },
      valid
    )
  ).toThrow("transport endpoint requestCodec.contentType must be a non-empty well-formed string")
  expect(() =>
    endpoint(
      "greeter",
      "Hello",
      { contentType: "\udc00", encode: valid.encode, decode: valid.decode },
      valid
    )
  ).toThrow("transport endpoint requestCodec.contentType must be a non-empty well-formed string")
})

test("JSON codec validates asynchronous values and uses Web UTF-8 APIs", async () => {
  const codec = jsonCodec(
    schema(async (value) =>
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      typeof value.name === "string"
        ? { value: { name: value.name } }
        : { issues: [{ message: "name is required" }] }
    )
  )
  const encoded = await codec.encode({ name: "LikeGo" })

  expect(codec.contentType).toBe("application/json")
  expect(new TextDecoder().decode(encoded)).toBe('{"name":"LikeGo"}')
  await expect(codec.decode(encoded)).resolves.toEqual({ name: "LikeGo" })
  await expect(codec.decode(new TextEncoder().encode("{}"))).rejects.toThrow(
    "json body validation failed with 1 issue(s)"
  )
  await expect(codec.decode(new TextEncoder().encode("{"))).rejects.toThrow("json body is invalid")
  await expect(codec.decode(new Uint8Array([0xff]))).rejects.toThrow("json body is invalid")
})

test("JSON codec rejects thrown, malformed, and non-serializable values", async () => {
  const cause = new Error("validator failed")
  const throwing = jsonCodec(
    schema(function fail(): StandardSchemaV1.Result<string> {
      throw cause
    })
  )
  await expect(throwing.decode(new TextEncoder().encode('"value"'))).rejects.toMatchObject({
    message: "json body validation failed",
    cause
  })

  const primitive = jsonCodec(schema(() => null as never))
  await expect(primitive.decode(new TextEncoder().encode("null"))).rejects.toThrow(
    "json body validator returned an invalid result"
  )

  const invalidIssues = jsonCodec(schema(() => ({ issues: null }) as never))
  await expect(invalidIssues.decode(new TextEncoder().encode("null"))).rejects.toThrow(
    "json body validator returned an invalid result"
  )

  const missingValue = jsonCodec(schema(() => ({}) as never))
  await expect(missingValue.decode(new TextEncoder().encode("null"))).rejects.toThrow(
    "json body validator returned an invalid result"
  )

  const explicitSuccess = jsonCodec(schema(() => ({ value: "ok", issues: undefined })))
  await expect(explicitSuccess.decode(new TextEncoder().encode("null"))).resolves.toBe("ok")

  const undefinedValue = jsonCodec(schema(() => ({ value: undefined })))
  await expect(undefinedValue.encode(undefined)).rejects.toThrow("json body is not serializable")

  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  const cyclicValue = jsonCodec(schema(() => ({ value: cyclic })))
  await expect(cyclicValue.encode(cyclic)).rejects.toBeInstanceOf(TypeError)
})

test("JSON codec validates its Standard Schema contract at construction", () => {
  expect(() => jsonCodec(null as never)).toThrow(
    "json codec requires a Standard Schema v1 validator"
  )
  expect(() =>
    jsonCodec({
      get "~standard"(): never {
        throw new Error("getter failed")
      }
    } as never)
  ).toThrow("json codec requires a Standard Schema v1 validator")
  expect(() =>
    jsonCodec({
      "~standard": { version: 2, vendor: "", validate: null }
    } as never)
  ).toThrow("json codec requires a Standard Schema v1 validator")
})

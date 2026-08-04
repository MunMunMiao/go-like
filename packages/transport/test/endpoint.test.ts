import { expect, test } from "bun:test"

import { struct } from "@go-like/struct"

import { endpoint } from "../src/index"
import { decodeJsonBody, encodeJsonBody, jsonContentType } from "../src/json"

test("captures one immutable typed endpoint and its Structs", () => {
  const Request = struct.object({ name: struct.string() })
  const Response = struct.object({ greeting: struct.string() })
  const contract = endpoint("greeter", "Hello", Request, Response)

  expect(contract).toMatchObject({ service: "greeter", endpoint: "Hello" })
  expect(contract.request).toBe(Request)
  expect(contract.response).toBe(Response)
  expect(Object.isFrozen(contract)).toBe(true)
})

test("rejects malformed typed endpoint fields and non-Struct contracts", () => {
  const valid = struct.string()

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
    "transport endpoint request must be a Struct"
  )
  expect(() => endpoint("greeter", "Hello", {} as never, valid)).toThrow(
    "transport endpoint request must be a Struct"
  )
  expect(() => endpoint("greeter", "Hello", valid, null as never)).toThrow(
    "transport endpoint response must be a Struct"
  )
})

test("encodes and decodes Struct JSON bodies with Web UTF-8 APIs", () => {
  const Payload = struct.object({ name: struct.string().alias("display_name") })
  const encoded = encodeJsonBody(Payload, { name: "go-like" })

  expect(jsonContentType).toBe("application/json")
  expect(new TextDecoder().decode(encoded)).toBe('{"display_name":"go-like"}')
  expect(decodeJsonBody(Payload, encoded)).toEqual({ name: "go-like" })
  expect(() => decodeJsonBody(Payload, new TextEncoder().encode('{"display_name":1}'))).toThrow()
  expect(() => decodeJsonBody(Payload, new TextEncoder().encode("{"))).toThrow(
    "json body is invalid"
  )
  expect(() => decodeJsonBody(Payload, new Uint8Array([0xff]))).toThrow("json body is invalid")
})

test("rejects values that cannot cross the Struct JSON body boundary", () => {
  const Any = struct.any()
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic

  expect(() => encodeJsonBody(Any, undefined)).toThrow("json body is not serializable")
  expect(() => encodeJsonBody(Any, cyclic)).toThrow("struct value contains a cycle")
})

test("uses native JavaScript JSON number behavior", () => {
  const NumberValue = struct.number()

  expect(decodeJsonBody(NumberValue, new TextEncoder().encode("1.0"))).toBe(1)
  expect(decodeJsonBody(NumberValue, new TextEncoder().encode("1e0"))).toBe(1)
  expect(Object.is(decodeJsonBody(NumberValue, new TextEncoder().encode("-0")), -0)).toBe(true)
  expect(new TextDecoder().decode(encodeJsonBody(NumberValue, Number.POSITIVE_INFINITY))).toBe(
    "null"
  )
})

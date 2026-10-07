import { expect, test } from "bun:test"

import { StructError, struct } from "@go-like/struct"

import { endpoint } from "../src/index"
import { decodeJsonBody, encodeJsonBody, jsonContentType } from "../src/json"

test("captures one immutable typed endpoint and its Structs", () => {
  const Request = struct.object({ name: struct.string() })
  const Response = struct.object({ greeting: struct.string() })
  const contract = endpoint("greeter", "Hello", Request, Response)

  expect(contract).toMatchObject({ service: "greeter", endpoint: "Hello", stream: false })
  expect(contract.request).toBe(Request)
  expect(contract.response).toBe(Response)
  expect(contract.stream).toBe(false)
  expect(Object.isFrozen(contract)).toBe(true)
})

test("records a server stream only when stream is true", () => {
  const valid = struct.string()

  expect(endpoint("pay.v1", "watch", valid, valid, true)).toMatchObject({
    service: "pay.v1",
    endpoint: "watch",
    stream: true
  })
  expect(Object.isFrozen(endpoint("pay.v1", "watch", valid, valid, true))).toBe(true)
  expect(() => endpoint("pay.v1", "watch", valid, valid, false as never)).toThrow(
    "stream must be true or omitted"
  )
  expect(() => endpoint("pay.v1", "watch", valid, valid, "true" as never)).toThrow(
    "stream must be true or omitted"
  )
})

test("rejects malformed typed endpoint fields and non-Struct contracts", () => {
  const valid = struct.string()

  expect(() => endpoint("", "Hello", valid, valid)).toThrow(
    "transport endpoint service must be a URL unreserved route token"
  )
  expect(() => endpoint("greeter", null as never, valid, valid)).toThrow(
    "transport endpoint endpoint must be a URL unreserved route token"
  )
  expect(() => endpoint("greeter", "\ud800", valid, valid)).toThrow(
    "transport endpoint endpoint must be a URL unreserved route token"
  )
  expect(() => endpoint("greeter", "\udc00", valid, valid)).toThrow(
    "transport endpoint endpoint must be a URL unreserved route token"
  )
  for (const [service, name] of [
    ["a/b", "c"],
    ["a", "b/c"],
    ["a*", "c"],
    ["a", "b*"],
    ["a!", "c"],
    ["a", "b+"],
    ["a", "b%"],
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
  expect(endpoint("pay.v1", "a_b~c-d", valid, valid)).toMatchObject({
    service: "pay.v1",
    endpoint: "a_b~c-d"
  })
  expect(() => endpoint(".", "ok", valid, valid)).toThrow(
    "transport endpoint service must be a URL unreserved route token"
  )
  expect(() => endpoint("..", "ok", valid, valid)).toThrow(
    "transport endpoint service must be a URL unreserved route token"
  )
  expect(() => endpoint("ok", ".", valid, valid)).toThrow(
    "transport endpoint endpoint must be a URL unreserved route token"
  )
  expect(() => endpoint("ok", "..", valid, valid)).toThrow(
    "transport endpoint endpoint must be a URL unreserved route token"
  )
  expect(endpoint("a.b", "a..b", valid, valid)).toMatchObject({
    service: "a.b",
    endpoint: "a..b"
  })
  expect(endpoint("...", ".a", valid, valid)).toMatchObject({ service: "...", endpoint: ".a" })
  expect(endpoint("a.", "~_.-", valid, valid)).toMatchObject({ service: "a.", endpoint: "~_.-" })
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

test("F5 encodeJsonBody rejects a data cycle behind an unknown or any getter", () => {
  for (const terminal of [struct.unknown(), struct.any()]) {
    const schema = struct.object({ child: terminal })
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const input = {
      get child(): unknown {
        return cycle
      }
    }
    let error: unknown
    try {
      encodeJsonBody(schema, input)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StructError)
    expect(error).not.toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(RangeError)
    expect((error as Error).message).toBe("struct value contains a cycle")
  }
})

test("rejects values that cannot cross the Struct JSON body boundary", () => {
  const Any = struct.any()
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic

  expect(() => encodeJsonBody(Any, undefined)).toThrow("Expected any at <root>, received undefined")
  expect(() => encodeJsonBody(Any, () => undefined)).toThrow("json body is not serializable")
  expect(() => encodeJsonBody(Any, cyclic)).toThrow("struct value contains a cycle")
})

test("Q4-04 round-trips required fields inside intersecting array elements", () => {
  const left = struct.object({
    items: struct.array(struct.object({ id: struct.string() }))
  })
  const right = struct.object({
    items: struct.array(struct.object({ name: struct.string() }))
  })
  const input = { items: [{ id: "u1", name: "Ada" }] }
  for (const mixed of [false, true]) {
    const schema = struct.intersection(mixed ? struct.or(left, struct.number()) : left, right)
    expect(decodeJsonBody(schema, encodeJsonBody(schema, input))).toEqual(input)
  }
})

test("round-trips a mixed intersection JSON body", () => {
  const schema = struct.intersection(
    struct.or(struct.object({ id: struct.string() }), struct.number()),
    struct.object({ name: struct.string() })
  )
  const value = { id: "u1", name: "Ada" }
  const body = encodeJsonBody(schema, value)
  const [parsedError, parsed] = struct.parse(schema, value)

  expect(parsedError).toBeNull()
  expect(parsed).toEqual(value)
  expect(JSON.parse(new TextDecoder().decode(body))).toEqual(value)
  expect(decodeJsonBody(schema, body)).toEqual(value)
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

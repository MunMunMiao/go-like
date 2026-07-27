import { describe, expect, test } from "bun:test"

import { isServiceError, serviceError, type ServiceError } from "../src/index"
import { decodeServiceError, encodeServiceError, internalServiceError } from "../src/provider"
import * as Headers from "../src/headers"

const Encoder = new TextEncoder()
const Decoder = new TextDecoder()

/** Returns one canonical header carrier for malformed-wire tests. */
function serviceHeaders(code = "denied", status = "403"): Readonly<Record<string, string>> {
  return Object.freeze({
    [Headers.serviceError]: "v1",
    [Headers.serviceErrorCode]: code,
    [Headers.serviceErrorStatus]: status,
    [Headers.contentType]: "application/json; charset=utf-8"
  })
}

/** Returns one canonical ServiceError JSON body for malformed-wire tests. */
function serviceBody(
  code = "denied",
  message = "request denied",
  status = 403,
  metadata: Readonly<Record<string, string>> = {}
): Uint8Array {
  return Encoder.encode(JSON.stringify({ code, message, status, metadata }))
}

describe("ServiceError", () => {
  test("creates a branded frozen snapshot with canonical metadata order", () => {
    const metadata = { z: "last", a: "first" }
    const failure = serviceError("orders.denied", "request denied", 403, metadata)

    metadata.a = "changed"
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      name: "ServiceError",
      code: "orders.denied",
      message: "request denied",
      status: 403,
      metadata: { a: "first", z: "last" }
    })
    expect(Object.keys(failure.metadata)).toEqual(["a", "z"])
    expect(Object.isFrozen(failure)).toBe(true)
    expect(Object.isFrozen(failure.metadata)).toBe(true)
    expect(isServiceError(failure)).toBe(true)

    const forged = Object.assign(new Error("request denied"), {
      name: "ServiceError",
      code: "orders.denied",
      status: 403,
      metadata: Object.freeze({ a: "first", z: "last" })
    })
    expect(isServiceError(forged)).toBe(false)
    expect(isServiceError(null)).toBe(false)
  })

  test("fixes the internal tuple and validates every construction bound", () => {
    const internal = internalServiceError()
    expect(internal).toMatchObject({
      name: "ServiceError",
      code: "internal",
      message: "internal service error",
      status: 500,
      metadata: {}
    })
    expect(isServiceError(internal)).toBe(true)

    for (const code of ["", "Upper", "-bad", "a".repeat(129)]) {
      expect(() => serviceError(code, "failure")).toThrow(TypeError)
    }
    for (const status of [399, 600, 500.5, Number.NaN]) {
      expect(() => serviceError("failure", "failure", status)).toThrow(RangeError)
    }
    expect(() => serviceError("failure", "x".repeat(4_097))).toThrow(RangeError)
    expect(() => serviceError("failure", "\ud800")).toThrow(TypeError)
    expect(serviceError("failure", "😀", 500, { "😀a": "one", "😀": "two" }).message).toBe("😀")
    expect(() => serviceError("failure", "failure", 500, { "\udc00": "value" })).toThrow(TypeError)
    expect(() => serviceError("failure", "failure", 500, { key: "\udc00" })).toThrow(TypeError)
    expect(() =>
      Reflect.apply(serviceError, undefined, ["failure", "failure", 500, { key: 1 }])
    ).toThrow(TypeError)
    expect(() =>
      serviceError("failure", "failure", 500, Object.create({ inherited: "value" }))
    ).toThrow(TypeError)
    expect(() => serviceError("failure", "failure", 500, { ["k".repeat(129)]: "v" })).toThrow(
      RangeError
    )
    expect(() => serviceError("failure", "failure", 500, { k: "v".repeat(1_025) })).toThrow(
      RangeError
    )
    expect(() =>
      serviceError(
        "failure",
        "failure",
        500,
        Object.fromEntries(Array.from({ length: 33 }, (_value, index) => [`k${index}`, "v"]))
      )
    ).toThrow(RangeError)
    expect(() =>
      serviceError(
        "failure",
        "failure",
        500,
        Object.fromEntries(
          Array.from({ length: 9 }, (_value, index) => [`k${index}`, "v".repeat(1_000)])
        )
      )
    ).toThrow(RangeError)
  })

  test("encodes the canonical unary carrier with detached body reads", () => {
    const failure = serviceError("orders.denied", "request denied", 403, { z: "last", a: "first" })
    const unary = encodeServiceError("unary", failure)
    const expectedBody =
      '{"code":"orders.denied","message":"request denied","status":403,"metadata":{"a":"first","z":"last"}}'

    expect(unary).toMatchObject({ serviceStatus: 403, carrierStatus: 200 })
    expect(unary.header).toEqual({
      [Headers.serviceError]: "v1",
      [Headers.serviceErrorCode]: "orders.denied",
      [Headers.serviceErrorStatus]: "403",
      [Headers.contentType]: "application/json; charset=utf-8"
    })
    expect(Decoder.decode(unary.body)).toBe(expectedBody)
    const first = unary.body
    first[0] = 0
    expect(Decoder.decode(unary.body)).toBe(expectedBody)
    expect(Object.isFrozen(unary)).toBe(true)
    expect(Object.isFrozen(unary.header)).toBe(true)

    const forged = Object.assign(new Error("forged"), {
      name: "ServiceError",
      code: "forged",
      status: 500,
      metadata: Object.freeze({})
    }) as ServiceError
    expect(() => encodeServiceError("unary", forged)).toThrow(TypeError)
    expect(() => Reflect.apply(encodeServiceError, undefined, ["other", failure])).toThrow(
      TypeError
    )
  })

  test("decodes header names case-insensitively into a fresh branded error", () => {
    const source = serviceError("orders.denied", "request denied", 403, { tenant: "one" })
    const envelope = encodeServiceError("unary", source)
    const lowerHeaders = Object.freeze(
      Object.fromEntries(
        Object.entries(envelope.header).map(([key, value]) => [key.toLowerCase(), value])
      )
    )
    const decoded = decodeServiceError("unary", 200, lowerHeaders, envelope.body)

    expect(decoded).not.toBe(source)
    expect(decoded).toMatchObject({
      name: "ServiceError",
      code: "orders.denied",
      message: "request denied",
      status: 403,
      metadata: { tenant: "one" }
    })
    expect(isServiceError(decoded)).toBe(true)
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded?.metadata)).toBe(true)
    expect(decodeServiceError("unary", 200, {}, new Uint8Array())).toBeNull()
  })

  test("round-trips metadata keys that are special on Object.prototype", () => {
    const metadata = Object.fromEntries([
      ["__proto__", "prototype"],
      ["constructor", "constructor"]
    ])
    const envelope = encodeServiceError(
      "unary",
      serviceError("metadata.special", "special metadata", 500, metadata)
    )
    const decoded = decodeServiceError("unary", 200, envelope.header, envelope.body)

    expect(decoded?.metadata).toEqual(metadata)
    expect(Object.hasOwn(decoded?.metadata ?? {}, "__proto__")).toBe(true)
  })

  test("enforces unary carrier status and every strict wire component", () => {
    const unary = encodeServiceError("unary", serviceError("denied", "request denied", 403))
    expect(decodeServiceError("unary", 200, unary.header, unary.body)?.status).toBe(403)
    expect(() => decodeServiceError("unary", 403, unary.header, unary.body)).toThrow(
      /ServiceError wire/
    )

    const malformed: readonly [Readonly<Record<string, string>>, Uint8Array][] = [
      [{ ...serviceHeaders(), [Headers.serviceError]: "v2" }, serviceBody()],
      [
        {
          ...serviceHeaders(),
          [Headers.serviceError.toLowerCase()]: "v1"
        },
        serviceBody()
      ],
      [
        {
          ...serviceHeaders(),
          [Headers.serviceErrorCode.toLowerCase()]: "denied"
        },
        serviceBody()
      ],
      [{ ...serviceHeaders(), [Headers.serviceErrorCode]: "other" }, serviceBody()],
      [{ ...serviceHeaders(), [Headers.serviceErrorStatus]: "0403" }, serviceBody()],
      [
        Object.freeze({
          [Headers.serviceError]: "v1",
          [Headers.serviceErrorCode]: "denied",
          [Headers.serviceErrorStatus]: "403"
        }),
        serviceBody()
      ],
      [{ ...serviceHeaders(), [Headers.contentType]: "application/json" }, serviceBody()],
      [serviceHeaders(), new Uint8Array([0xc3, 0x28])],
      [
        serviceHeaders(),
        Encoder.encode('{ "code":"denied","message":"request denied","status":403,"metadata":{} }')
      ],
      [
        serviceHeaders(),
        Encoder.encode(
          '{"code":"denied","message":"request denied","status":403,"metadata":{},"extra":true}'
        )
      ],
      [
        serviceHeaders(),
        Encoder.encode('{"code":1,"message":"request denied","status":403,"metadata":{}}')
      ],
      [
        serviceHeaders(),
        Encoder.encode(
          '{"code":"denied","message":"request denied","status":403,"metadata":{"key":1}}'
        )
      ],
      [serviceHeaders(), serviceBody("denied", "request denied", 404)],
      [serviceHeaders(), new Uint8Array(8_193)]
    ]
    for (const [header, body] of malformed) {
      expect(() => decodeServiceError("unary", 200, header, body)).toThrow(/ServiceError wire/)
    }
    expect(() =>
      decodeServiceError(
        "unary",
        200,
        Object.assign(Object.create({ inherited: "value" }), unary.header),
        unary.body
      )
    ).toThrow(/ServiceError wire/)
  })
})

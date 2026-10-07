import { describe, expect, test } from "bun:test"

import { isServiceError, serviceError, type ServiceError } from "../src/index"
import {
  decodeServiceErrorResponse,
  internalServiceError,
  serviceErrorResponse
} from "../src/provider"

const Encoder = new TextEncoder()

/** Returns one JSON error body with the exact Fetch key set. */
function serviceBody(
  code = "denied",
  message = "request denied",
  metadata: Readonly<Record<string, string>> = {}
): Uint8Array {
  return Encoder.encode(JSON.stringify({ code, message, metadata }))
}

/** Copies encoded bytes into an ArrayBuffer Fetch will accept as a body. */
function responseBytes(body: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(body.byteLength)
  new Uint8Array(copy).set(body)
  return copy
}

/** Returns one non-2xx JSON response for wire rejection cases. */
function serviceResponse(
  body: Uint8Array,
  status = 403,
  contentType = "application/json"
): Response {
  return new Response(responseBytes(body), {
    status,
    headers: { "content-type": contentType }
  })
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

  test("encodes status and the exact JSON key set without carrier headers", async () => {
    const failure = serviceError("orders.denied", "request denied", 403, { z: "last", a: "first" })
    const response = serviceErrorResponse(failure)
    const expectedBody =
      '{"code":"orders.denied","message":"request denied","metadata":{"a":"first","z":"last"}}'

    expect(response.status).toBe(403)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("go-like-service-error")).toBeNull()
    expect(response.headers.get("go-like-service-error-code")).toBeNull()
    expect(response.headers.get("go-like-service-error-status")).toBeNull()
    expect(await response.text()).toBe(expectedBody)

    const forged = Object.assign(new Error("forged"), {
      name: "ServiceError",
      code: "forged",
      status: 500,
      metadata: Object.freeze({})
    }) as ServiceError
    expect(() => serviceErrorResponse(forged)).toThrow(TypeError)
  })

  test("decodes a JSON error into a fresh branded ServiceError", async () => {
    const source = serviceError("orders.denied", "request denied", 403, { tenant: "one" })
    const decoded = await decodeServiceErrorResponse(serviceErrorResponse(source))

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

    const success = serviceResponse(serviceBody(), 200)
    expect(await decodeServiceErrorResponse(success)).toBeNull()
    expect(success.bodyUsed).toBe(false)
    const html = new Response("<html>", {
      status: 502,
      headers: { "content-type": "text/html" }
    })
    expect(await decodeServiceErrorResponse(html)).toBeNull()
    expect(html.bodyUsed).toBe(false)
  })

  test("rejects metadata whose prototype is not a plain object", async () => {
    const parsed = JSON.parse
    JSON.parse = function leakedPrototype(_text: string): unknown {
      return {
        code: "not_found",
        message: "missing",
        metadata: Object.assign(Object.create({ leaked: true }), { tenant: "a" })
      }
    } as typeof JSON.parse
    try {
      expect(
        await decodeServiceErrorResponse(
          new Response("{}", {
            status: 404,
            headers: { "content-type": "application/json" }
          })
        )
      ).toBeNull()
    } finally {
      JSON.parse = parsed
    }
  })

  test("round-trips metadata keys that are special on Object.prototype", async () => {
    const metadata = Object.fromEntries([
      ["__proto__", "prototype"],
      ["constructor", "constructor"]
    ])
    const decoded = await decodeServiceErrorResponse(
      serviceErrorResponse(serviceError("metadata.special", "special metadata", 500, metadata))
    )

    expect(decoded?.metadata).toEqual(metadata)
    expect(Object.hasOwn(decoded?.metadata ?? {}, "__proto__")).toBe(true)
  })

  test("accepts only a strict JSON body and takes status from the response", async () => {
    const spaced = serviceResponse(
      Encoder.encode('{ "code":"denied","message":"request denied","metadata":{} }'),
      403
    )
    expect(await decodeServiceErrorResponse(spaced)).toMatchObject({
      code: "denied",
      status: 403,
      metadata: {}
    })
    const reordered = serviceResponse(
      Encoder.encode('{"metadata":{},"message":"request denied","code":"denied"}'),
      404
    )
    expect((await decodeServiceErrorResponse(reordered))?.status).toBe(404)
    const charset = serviceResponse(serviceBody(), 403, "application/json; charset=utf-8")
    expect((await decodeServiceErrorResponse(charset))?.code).toBe("denied")

    const rejected = [
      serviceResponse(serviceBody(), 399),
      serviceResponse(serviceBody(), 301),
      serviceResponse(serviceBody(), 403, "application/json, text/plain"),
      serviceResponse(new Uint8Array([0xc3, 0x28])),
      serviceResponse(
        Encoder.encode('{"code":"denied","message":"request denied","metadata":{},"status":403}')
      ),
      serviceResponse(Encoder.encode('{"code":1,"message":"request denied","metadata":{}}')),
      serviceResponse(
        Encoder.encode('{"code":"denied","message":"request denied","metadata":{"key":1}}')
      ),
      serviceResponse(Encoder.encode('{"code":"denied","message":"request denied"}')),
      serviceResponse(Encoder.encode('["denied"]')),
      serviceResponse(Encoder.encode("null")),
      serviceResponse(new Uint8Array(8_193)),
      new Response(
        new ReadableStream({
          pull(controller): void {
            controller.error(new Error("broken body"))
          }
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      ),
      serviceResponse(Encoder.encode('{"code":"BAD","message":"request denied","metadata":{}}')),
      new Response(responseBytes(serviceBody()), { status: 403 })
    ]
    for (const response of rejected) {
      expect(await decodeServiceErrorResponse(response)).toBeNull()
    }
    expect(await decodeServiceErrorResponse(null as never)).toBeNull()
  })
})

import { expect, test } from "bun:test"

import * as Headers from "../src/headers"
import * as Transport from "../src/index"
import * as Json from "../src/json"
import * as Provider from "../src/provider"

const ErrorFactories = [
  "newTransportClosedError",
  "newTransportProtocolError",
  "newTransportStateError",
  "newUnsupportedTransportCapabilityError"
] as const

test("root exports exactly the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(Transport).sort()).toEqual([
    "chain",
    "codec",
    "endpoint",
    "fromClientContext",
    "fromServerContext",
    "isServiceError",
    "logger",
    "newClientContext",
    "newServerContext",
    "secure",
    "serviceError",
    "timeout",
    "tlsConfig",
    "withConnClose",
    "withTimeout"
  ])
})

test("json subpath exports only the Struct JSON body boundary", () => {
  expect(Object.keys(Json).sort()).toEqual(["decodeJsonBody", "encodeJsonBody", "jsonContentType"])
})

test("provider subpath exports exactly the reviewed lower-camel wire surface", () => {
  expect(Object.keys(Provider).sort()).toEqual([
    "decodeMetadataHeader",
    "decodeServiceError",
    "encodeMetadataHeader",
    "encodeServiceError",
    "internalServiceError",
    "newTransportClosedError",
    "newTransportProtocolError",
    "newTransportStateError",
    "newUnsupportedTransportCapabilityError",
    "snapshotMessage"
  ])
})

test("headers subpath exports the 18 exact reviewed names and values", () => {
  expect(Headers).toEqual({
    message: "Go-Like-Topic",
    request: "Go-Like-Service",
    error: "Go-Like-Error",
    endpoint: "Go-Like-Endpoint",
    method: "Go-Like-Method",
    metadata: "Go-Like-Metadata",
    id: "Go-Like-ID",
    prefix: "Go-Like-",
    namespace: "Go-Like-Namespace",
    protocol: "Go-Like-Protocol",
    target: "Go-Like-Target",
    contentType: "Content-Type",
    serviceError: "Go-Like-Service-Error",
    serviceErrorCode: "Go-Like-Service-Error-Code",
    serviceErrorStatus: "Go-Like-Service-Error-Status",
    spanId: "Go-Like-Span-ID",
    traceId: "Go-Like-Trace-ID",
    stream: "Go-Like-Stream"
  })
})

test("creates four frozen stable errors that preserve cause identity", () => {
  for (const name of ErrorFactories) {
    const factory = Reflect.get(Provider, name)
    expect(typeof factory).toBe("function")
    if (typeof factory !== "function") continue
    const cause = new Error(`${name} cause`)
    const failure = factory(`${name} message`, cause)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe(`${name} message`)
    expect(failure.cause).toBe(cause)
    expect(Object.isFrozen(failure)).toBe(true)
  }

  const expected = [
    ["newTransportClosedError", "TransportClosedError", "GO_LIKE_TRANSPORT_CLOSED"],
    ["newTransportProtocolError", "TransportProtocolError", "GO_LIKE_TRANSPORT_PROTOCOL"],
    ["newTransportStateError", "TransportStateError", "GO_LIKE_TRANSPORT_STATE"],
    [
      "newUnsupportedTransportCapabilityError",
      "UnsupportedTransportCapabilityError",
      "GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY"
    ]
  ]
  for (const row of expected) {
    const factory = Reflect.get(Provider, row[0] ?? "")
    if (typeof factory !== "function") continue
    expect(factory("failure")).toMatchObject({ name: row[1], code: row[2] })
  }
})

import { expect, test } from "bun:test"

import * as Headers from "../src/headers"
import * as Transport from "../src/index"
import * as Json from "../src/json"
import * as Provider from "../src/provider"
import { verifyPortableTransportRuntime } from "./runtime/portable-runtime"

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

test("json subpath exports only the Web-API JSON codec", () => {
  expect(Object.keys(Json)).toEqual(["jsonCodec"])
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
    message: "Likego-Topic",
    request: "Likego-Service",
    error: "Likego-Error",
    endpoint: "Likego-Endpoint",
    method: "Likego-Method",
    metadata: "Likego-Metadata",
    id: "Likego-ID",
    prefix: "Likego-",
    namespace: "Likego-Namespace",
    protocol: "Likego-Protocol",
    target: "Likego-Target",
    contentType: "Content-Type",
    serviceError: "Likego-Service-Error",
    serviceErrorCode: "Likego-Service-Error-Code",
    serviceErrorStatus: "Likego-Service-Error-Status",
    spanId: "Likego-Span-ID",
    traceId: "Likego-Trace-ID",
    stream: "Likego-Stream"
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
    ["newTransportClosedError", "TransportClosedError", "LIKEGO_TRANSPORT_CLOSED"],
    ["newTransportProtocolError", "TransportProtocolError", "LIKEGO_TRANSPORT_PROTOCOL"],
    ["newTransportStateError", "TransportStateError", "LIKEGO_TRANSPORT_STATE"],
    [
      "newUnsupportedTransportCapabilityError",
      "UnsupportedTransportCapabilityError",
      "LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY"
    ]
  ]
  for (const row of expected) {
    const factory = Reflect.get(Provider, row[0] ?? "")
    if (typeof factory !== "function") continue
    expect(factory("failure")).toMatchObject({ name: row[1], code: row[2] })
  }
})

test("portable runtime contract executes through formal package exports", async () => {
  await expect(verifyPortableTransportRuntime()).resolves.toBeUndefined()
})

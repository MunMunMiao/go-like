import { expect, test } from "bun:test"

import * as Headers from "../src/headers"
import * as Transport from "../src/index"
import * as Json from "../src/json"
import * as Provider from "../src/provider"
import * as Sse from "../src/sse/index"

const ErrorFactories = [
  "newTransportClosedError",
  "newTransportProtocolError",
  "newTransportStateError",
  "newUnsupportedTransportCapabilityError"
] as const

test("root exports exactly the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(Transport).sort()).toEqual([
    "applyResponseObservers",
    "chain",
    "defineService",
    "endpoint",
    "fromClientContext",
    "fromServerContext",
    "isServiceError",
    "logger",
    "newClientContext",
    "newServerContext",
    "observeResponseBody",
    "secure",
    "serviceError",
    "timeout",
    "tlsConfig",
    "withConnClose",
    "withResponseObserver",
    "withTimeout"
  ])
})

test("json subpath exports only the Struct JSON body boundary", () => {
  expect(Object.keys(Json).sort()).toEqual(["decodeJsonBody", "encodeJsonBody", "jsonContentType"])
})

test("provider subpath exports exactly the reviewed lower-camel wire surface", () => {
  expect(Object.keys(Provider).sort()).toEqual([
    "decodeMetadataHeader",
    "decodeServiceErrorResponse",
    "encodeMetadataHeader",
    "internalServiceError",
    "newTransportClosedError",
    "newTransportProtocolError",
    "newTransportStateError",
    "newUnsupportedTransportCapabilityError",
    "observeCall",
    "serviceErrorResponse"
  ])
})

test("sse subpath exports the parser and event encoder", () => {
  expect(Object.keys(Sse).sort()).toEqual([
    "SSEParserLimitError",
    "createLineParser",
    "createMessageParser",
    "defaultSSEMaxMessageBytes",
    "encodeSSEComment",
    "encodeSSEEvent",
    "encodeSSEJsonEvent",
    "eventStreamContentType",
    "readStreamBytes"
  ])
})

test("headers subpath exports only the reviewed Fetch names and values", () => {
  expect(Headers).toEqual({
    metadata: "Go-Like-Metadata",
    timeout: "Go-Like-Timeout-Ms"
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

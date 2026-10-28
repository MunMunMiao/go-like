import { expect, test } from "bun:test"
import * as grpc from "../src/index"
import * as native from "../src/native"

test("exports only the portable first-phase runtime", () => {
  expect(Object.keys(grpc)).toEqual(["callOptions", "fromHandlerContext", "newHandler"])
})

test("native exports only the managed standard-gRPC client and server API", () => {
  expect(Object.keys(native).sort()).toEqual([
    "address",
    "advertise",
    "clientAuth",
    "newClient",
    "newServer",
    "tlsConfig",
    "withBlock",
    "withDiscovery",
    "withEndpoint",
    "withSelector",
    "withTLSConfig"
  ])
})

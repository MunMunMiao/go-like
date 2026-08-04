import * as Headers from "@go-like/transport/headers"
import * as Transport from "@go-like/transport"
import { struct } from "@go-like/struct"
import { decodeJsonBody, encodeJsonBody } from "@go-like/transport/json"
import * as Provider from "@go-like/transport/provider"

const expectedRootExports = [
  "chain",
  "fromClientContext",
  "codec",
  "endpoint",
  "isServiceError",
  "logger",
  "secure",
  "fromServerContext",
  "serviceError",
  "timeout",
  "tlsConfig",
  "newClientContext",
  "withConnClose",
  "newServerContext",
  "withTimeout"
].sort()

const expectedProviderExports = [
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
].sort()

const actualRootExports = Object.keys(Transport).sort()
if (JSON.stringify(actualRootExports) !== JSON.stringify(expectedRootExports)) {
  throw new Error(`unexpected @go-like/transport exports: ${actualRootExports.join(",")}`)
}
const actualProviderExports = Object.keys(Provider).sort()
if (JSON.stringify(actualProviderExports) !== JSON.stringify(expectedProviderExports)) {
  throw new Error(
    `unexpected @go-like/transport/provider exports: ${actualProviderExports.join(",")}`
  )
}
if (
  Object.keys(Headers).length !== 18 ||
  Headers.prefix !== "Go-Like-" ||
  Headers.metadata !== "Go-Like-Metadata" ||
  Headers.contentType !== "Content-Type"
) {
  throw new Error("unexpected @go-like/transport/headers contract")
}
const body = new Uint8Array([1, 2])
const snapshot = Provider.snapshotMessage({ header: { topic: "orders" }, body })
body[0] = 99
if (snapshot.body[0] !== 1 || snapshot.header.topic !== "orders") {
  throw new Error("built Message snapshot is not defensive")
}

const cause = new Error("runtime cause")
const failure = Provider.newTransportClosedError("closed", cause)
if (
  failure.code !== "GO_LIKE_TRANSPORT_CLOSED" ||
  failure.cause !== cause ||
  !Object.isFrozen(failure)
) {
  throw new Error("built transport error contract is invalid")
}

const Portable = struct.object({ value: struct.string() })
const json = encodeJsonBody(Portable, { value: "portable" })
if (decodeJsonBody(Portable, json).value !== "portable") {
  throw new Error("built Struct JSON body boundary is invalid")
}

console.log("go-like-transport-runtime ok")

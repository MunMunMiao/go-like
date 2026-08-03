import * as Headers from "@likego/transport/headers"
import * as Transport from "@likego/transport"
import { struct } from "@likego/struct"
import { decodeJsonBody, encodeJsonBody } from "@likego/transport/json"
import * as Provider from "@likego/transport/provider"

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
  throw new Error(`unexpected @likego/transport exports: ${actualRootExports.join(",")}`)
}
const actualProviderExports = Object.keys(Provider).sort()
if (JSON.stringify(actualProviderExports) !== JSON.stringify(expectedProviderExports)) {
  throw new Error(
    `unexpected @likego/transport/provider exports: ${actualProviderExports.join(",")}`
  )
}
if (
  Object.keys(Headers).length !== 18 ||
  Headers.prefix !== "Likego-" ||
  Headers.metadata !== "Likego-Metadata" ||
  Headers.contentType !== "Content-Type"
) {
  throw new Error("unexpected @likego/transport/headers contract")
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
  failure.code !== "LIKEGO_TRANSPORT_CLOSED" ||
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

console.log("likego-transport-runtime ok")

import * as Headers from "../../src/transport/internal/headers"
import * as Transport from "../../src/transport"
import { struct } from "../../src/struct"
import { decodeJsonBody, encodeJsonBody } from "../../src/transport/internal/json"
import * as Provider from "../../src/transport/provider"
import { serviceErrorResponse } from "../../src/transport/errors"
import * as Sse from "../../src/transport/internal/sse"

const expectedRootExports = [
  "defineService",
  "endpoint",
  "fromClientContext",
  "fromServerContext",
  "isServiceError",
  "secure",
  "serviceError",
  "timeout",
  "tlsConfig",
  "withConnClose",
  "withTimeout"
].sort()

const expectedProviderExports = [
  "newServerContext",
  "newTransportClosedError",
  "newTransportProtocolError",
  "newTransportStateError",
  "newUnsupportedTransportCapabilityError",
  "observeResponseBody"
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
  Object.keys(Headers).length !== 2 ||
  Headers.metadata !== "Go-Like-Metadata" ||
  Headers.timeout !== "Go-Like-Timeout-Ms"
) {
  throw new Error("unexpected @go-like/transport/headers contract")
}
const actualSseExports = Object.keys(Sse).sort()
const expectedSseExports = [
  "SSEParserLimitError",
  "createLineParser",
  "createMessageParser",
  "defaultSSEMaxMessageBytes",
  "encodeSSEComment",
  "encodeSSEEvent",
  "encodeSSEJsonEvent",
  "eventStreamContentType",
  "readStreamBytes"
].sort()
if (JSON.stringify(actualSseExports) !== JSON.stringify(expectedSseExports)) {
  throw new Error(`unexpected @go-like/transport/sse exports: ${actualSseExports.join(",")}`)
}
if (Sse.eventStreamContentType !== "text/event-stream" || Sse.encodeSSEComment().byteLength < 3) {
  throw new Error("built SSE encoder contract is invalid")
}
const failureResponse = serviceErrorResponse(Transport.serviceError("not_found", "missing", 404))
if (
  failureResponse.status !== 404 ||
  failureResponse.headers.get("content-type") !== "application/json"
) {
  throw new Error("built ServiceError response contract is invalid")
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

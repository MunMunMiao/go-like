import * as Headers from "@likego/transport/headers"
import * as Transport from "@likego/transport"
import { jsonCodec } from "@likego/transport/json"
import * as Provider from "@likego/transport/provider"

const ExpectedRootExports = [
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

const ExpectedProviderExports = [
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

const ExpectedHeaders = {
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
}

/** Verifies the built package's portable runtime surface without runtime-specific APIs. */
export async function verifyPortableTransportRuntime(): Promise<void> {
  const actualRoot = Object.keys(Transport).sort()
  if (JSON.stringify(actualRoot) !== JSON.stringify(ExpectedRootExports)) {
    throw new Error(`unexpected @likego/transport exports: ${actualRoot.join(",")}`)
  }
  const actualProvider = Object.keys(Provider).sort()
  if (JSON.stringify(actualProvider) !== JSON.stringify(ExpectedProviderExports)) {
    throw new Error(`unexpected @likego/transport/provider exports: ${actualProvider.join(",")}`)
  }
  const headerKeys = Object.keys(Headers).sort()
  const expectedHeaderKeys = Object.keys(ExpectedHeaders).sort()
  if (JSON.stringify(headerKeys) !== JSON.stringify(expectedHeaderKeys)) {
    throw new Error(`unexpected @likego/transport/headers exports: ${headerKeys.join(",")}`)
  }
  for (const key of expectedHeaderKeys) {
    if (Reflect.get(Headers, key) !== Reflect.get(ExpectedHeaders, key)) {
      throw new Error(`unexpected @likego/transport/headers value for ${key}`)
    }
  }
  const snapshotMessage = Reflect.get(Provider, "snapshotMessage")
  if (typeof snapshotMessage !== "function") throw new Error("snapshotMessage export is missing")
  const sourceBody = new Uint8Array([1, 2, 3])
  const snapshot = snapshotMessage({ header: { topic: "orders" }, body: sourceBody })
  sourceBody[0] = 99
  if (snapshot.body[0] !== 1 || snapshot.header.topic !== "orders") {
    throw new Error("built Message snapshot is not defensive")
  }

  const newTransportClosedError = Reflect.get(Provider, "newTransportClosedError")
  if (typeof newTransportClosedError !== "function") {
    throw new Error("newTransportClosedError export is missing")
  }
  const cause = new Error("portable cause")
  const failure = newTransportClosedError("closed", cause)
  if (
    failure.name !== "TransportClosedError" ||
    failure.code !== "LIKEGO_TRANSPORT_CLOSED" ||
    failure.cause !== cause ||
    !Object.isFrozen(failure)
  ) {
    throw new Error("built transport error contract is invalid")
  }

  const serviceError = Reflect.get(Transport, "serviceError")
  const encodeServiceError = Reflect.get(Provider, "encodeServiceError")
  const decodeServiceError = Reflect.get(Provider, "decodeServiceError")
  const isServiceError = Reflect.get(Transport, "isServiceError")
  if (
    typeof serviceError !== "function" ||
    typeof encodeServiceError !== "function" ||
    typeof decodeServiceError !== "function" ||
    typeof isServiceError !== "function"
  ) {
    throw new Error("ServiceError exports are missing")
  }
  const serviceFailure = serviceError("denied", "request denied", 403, { tenant: "one" })
  const envelope = encodeServiceError("unary", serviceFailure)
  const decoded = decodeServiceError("unary", 200, envelope.header, envelope.body)
  if (
    !isServiceError(decoded) ||
    decoded.code !== "denied" ||
    decoded.status !== 403 ||
    decoded.metadata.tenant !== "one" ||
    envelope.carrierStatus !== 200
  ) {
    throw new Error("built ServiceError wire contract is invalid")
  }

  const json = jsonCodec({
    "~standard": {
      version: 1,
      vendor: "likego-runtime",
      validate(value) {
        return typeof value === "string" ? { value } : { issues: [{ message: "string required" }] }
      }
    }
  })
  const encoded = await json.encode("portable")
  if ((await json.decode(encoded)) !== "portable") {
    throw new Error("built JSON body codec is invalid")
  }
}

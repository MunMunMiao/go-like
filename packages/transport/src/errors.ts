import type {
  ServiceError,
  TransportClosedError,
  TransportProtocolError,
  TransportStateError,
  UnsupportedTransportCapabilityError
} from "./types"

const ServiceErrorContentType = "application/json"
const MaximumServiceErrorMessageBytes = 4_096
const MaximumServiceErrorMetadataEntries = 32
const MaximumServiceErrorMetadataKeyBytes = 128
const MaximumServiceErrorMetadataValueBytes = 1_024
const MaximumServiceErrorBodyBytes = 8_192
const ServiceErrorCode = /^[a-z0-9][a-z0-9._-]{0,127}$/
const Encoder = new TextEncoder()
const Decoder = new TextDecoder("utf-8", { fatal: true })
const ServiceErrorBrand = new WeakSet<object>()

/** Reports whether a value is a non-array object suitable for structural inspection. */
function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one own data property without invoking an inherited member. */
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Returns the exact UTF-8 length of one already well-formed string. */
function utf8Length(value: string): number {
  return Encoder.encode(value).byteLength
}

/** Compares two strings lexicographically by Unicode code point. */
function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = Number(left.codePointAt(leftIndex))
    const rightPoint = Number(right.codePointAt(rightIndex))
    if (leftPoint < rightPoint) return -1
    if (leftPoint > rightPoint) return 1
    leftIndex += leftPoint > 0xffff ? 2 : 1
    rightIndex += rightPoint > 0xffff ? 2 : 1
  }
  return leftIndex < left.length ? 1 : rightIndex < right.length ? -1 : 0
}

/** Copies, validates, code-point sorts, and freezes one ServiceError metadata record. */
function snapshotServiceErrorMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new TypeError("ServiceError metadata must be a string record")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("ServiceError metadata must be a plain string record")
  }
  const keys = Object.keys(value)
  if (keys.length > MaximumServiceErrorMetadataEntries) {
    throw new RangeError("ServiceError metadata exceeds 32 entries")
  }
  keys.sort(compareCodePoints)
  const entries: [string, string][] = []
  for (const key of keys) {
    const item = own(value, key)
    if (!key.isWellFormed() || typeof item !== "string" || !item.isWellFormed()) {
      throw new TypeError("ServiceError metadata must contain well-formed string keys and values")
    }
    if (utf8Length(key) > MaximumServiceErrorMetadataKeyBytes) {
      throw new RangeError("ServiceError metadata key exceeds 128 UTF-8 bytes")
    }
    if (utf8Length(item) > MaximumServiceErrorMetadataValueBytes) {
      throw new RangeError("ServiceError metadata value exceeds 1024 UTF-8 bytes")
    }
    entries.push([key, item])
  }
  const metadata = Object.create(null) as Record<string, string>
  for (const [key, item] of entries) metadata[key] = item
  return Object.freeze(metadata)
}

/** Encodes one already validated ServiceError as its exact canonical JSON bytes. */
function canonicalServiceErrorBody(error: ServiceError): Uint8Array {
  return Encoder.encode(
    JSON.stringify({
      code: error.code,
      message: error.message,
      metadata: error.metadata
    })
  )
}

/** Creates one immutable branded ServiceError after all public bounds have been checked. */
function newServiceError(
  code: string,
  message: string,
  status: number,
  metadata: Readonly<Record<string, string>>
): ServiceError {
  const error = new Error(message)
  const details: Pick<ServiceError, "name" | "code" | "status" | "metadata"> = {
    name: "ServiceError",
    code,
    status,
    metadata
  }
  const branded = Object.assign(error, details)
  Object.defineProperty(branded, "name", {
    configurable: true,
    enumerable: false,
    value: "ServiceError",
    writable: true
  })
  ServiceErrorBrand.add(branded)
  return Object.freeze(branded)
}

/** Creates one validated immutable provider-neutral service failure. */
export function serviceError(
  code: string,
  message: string,
  status = 500,
  metadata: Readonly<Record<string, string>> = Object.freeze({})
): ServiceError {
  if (typeof code !== "string" || !ServiceErrorCode.test(code)) {
    throw new TypeError("ServiceError code is invalid")
  }
  if (typeof message !== "string" || !message.isWellFormed()) {
    throw new TypeError("ServiceError message must be a well-formed string")
  }
  if (utf8Length(message) > MaximumServiceErrorMessageBytes) {
    throw new RangeError("ServiceError message exceeds 4096 UTF-8 bytes")
  }
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError("ServiceError status must be an integer from 400 through 599")
  }
  const metadataSnapshot = snapshotServiceErrorMetadata(metadata)
  const error = newServiceError(code, message, status, metadataSnapshot)
  if (canonicalServiceErrorBody(error).byteLength > MaximumServiceErrorBodyBytes) {
    throw new RangeError("ServiceError canonical body exceeds 8192 bytes")
  }
  return error
}

/** Reports whether a value was created by this package's ServiceError boundary. */
export function isServiceError(value: unknown): value is ServiceError {
  if (typeof value !== "object" || value === null) return false
  return ServiceErrorBrand.has(value)
}

/** Creates the fixed secret-safe ServiceError used for unknown server failures. */
export function internalServiceError(): ServiceError {
  return serviceError("internal", "internal service error", 500)
}

/** Copies parsed metadata into a string record, or throws when the value is not one. */
function parsedMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new TypeError("ServiceError body metadata must be an object")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("ServiceError body metadata must be a plain object")
  }
  const metadata = Object.create(null) as Record<string, string>
  for (const key of Object.keys(value)) {
    const item = own(value, key)
    if (typeof item !== "string") {
      throw new TypeError("ServiceError body metadata values must be strings")
    }
    metadata[key] = item
  }
  return metadata
}

/** Reports whether the media type is exactly application/json, ignoring parameters. */
function jsonMediaType(response: Response): boolean {
  const raw = response.headers.get("content-type")
  if (raw === null) return false
  return raw.split(";", 1)[0]?.trim().toLowerCase() === ServiceErrorContentType
}

/** Reports whether a parsed object has exactly the Fetch ServiceError keys. */
function exactServiceErrorKeys(value: object): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === 3 &&
    keys.includes("code") &&
    keys.includes("message") &&
    keys.includes("metadata")
  )
}

/** Copies encoded bytes into a standalone ArrayBuffer accepted as a Fetch body. */
function responseBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/** Encodes a ServiceError as the Fetch response required by the internal wire. */
export function serviceErrorResponse(error: ServiceError): Response {
  if (!isServiceError(error)) throw new TypeError("ServiceError response requires a branded error")
  return new Response(responseBytes(canonicalServiceErrorBody(error)), {
    status: error.status,
    headers: { "content-type": ServiceErrorContentType }
  })
}

/** Decodes a Fetch ServiceError response, or returns null when the body is not canonical. */
export async function decodeServiceErrorResponse(response: Response): Promise<ServiceError | null> {
  if (!(response instanceof Response)) return null
  if (!Number.isInteger(response.status) || response.status < 400 || response.status > 599) {
    return null
  }
  if (!jsonMediaType(response)) return null
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch {
    return null
  }
  if (bytes.byteLength > MaximumServiceErrorBodyBytes) return null
  try {
    const parsed: unknown = JSON.parse(Decoder.decode(bytes))
    if (!isRecord(parsed) || !exactServiceErrorKeys(parsed)) return null
    const code = own(parsed, "code")
    const message = own(parsed, "message")
    if (typeof code !== "string" || typeof message !== "string") return null
    return serviceError(code, message, response.status, parsedMetadata(own(parsed, "metadata")))
  } catch {
    return null
  }
}

/** Creates a frozen stable error for an operation on a closed transport resource. */
export function newTransportClosedError(message: string, cause?: Error): TransportClosedError {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  const details: Pick<TransportClosedError, "name" | "code" | "cause"> = {
    name: "TransportClosedError",
    code: "GO_LIKE_TRANSPORT_CLOSED",
    cause
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates a frozen stable error for an invalid transport state transition. */
export function newTransportStateError(message: string, cause?: Error): TransportStateError {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  const details: Pick<TransportStateError, "name" | "code" | "cause"> = {
    name: "TransportStateError",
    code: "GO_LIKE_TRANSPORT_STATE",
    cause
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates a frozen stable error for an unsupported requested capability. */
export function newUnsupportedTransportCapabilityError(
  message: string,
  cause?: Error
): UnsupportedTransportCapabilityError {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  const details: Pick<UnsupportedTransportCapabilityError, "name" | "code" | "cause"> = {
    name: "UnsupportedTransportCapabilityError",
    code: "GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY",
    cause
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates a frozen stable error for invalid wire or protocol behavior. */
export function newTransportProtocolError(message: string, cause?: Error): TransportProtocolError {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  const details: Pick<TransportProtocolError, "name" | "code" | "cause"> = {
    name: "TransportProtocolError",
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    cause
  }
  return Object.freeze(Object.assign(error, details))
}

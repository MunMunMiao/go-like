import type {
  ServiceError,
  ServiceErrorEnvelope,
  ServiceErrorWireKind,
  TransportClosedError,
  TransportProtocolError,
  TransportStateError,
  UnsupportedTransportCapabilityError
} from "./types"
import {
  contentType,
  serviceError as serviceErrorHeader,
  serviceErrorCode,
  serviceErrorStatus
} from "./headers"

const ServiceErrorContentType = "application/json; charset=utf-8"
const MaximumServiceErrorMessageBytes = 4_096
const MaximumServiceErrorMetadataEntries = 32
const MaximumServiceErrorMetadataKeyBytes = 128
const MaximumServiceErrorMetadataValueBytes = 1_024
const MaximumServiceErrorBodyBytes = 8_192
const ServiceErrorCode = /^[a-z0-9][a-z0-9._-]{0,127}$/
const Encoder = new TextEncoder()
const Decoder = new TextDecoder("utf-8", { fatal: true })
const ServiceErrorBrand = new WeakSet<object>()

interface HeaderValue {
  readonly found: boolean
  readonly value: string
}

/** Reports whether a value is a non-array object suitable for structural inspection. */
function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one own data property without invoking an inherited member. */
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Returns whether a string contains only complete UTF-16 scalar sequences. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
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
    if (!isWellFormed(key) || typeof item !== "string" || !isWellFormed(item)) {
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
  return Object.freeze(Object.fromEntries(entries))
}

/** Encodes one already validated ServiceError as its exact canonical JSON bytes. */
function canonicalServiceErrorBody(error: ServiceError): Uint8Array {
  return Encoder.encode(
    JSON.stringify({
      code: error.code,
      message: error.message,
      status: error.status,
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
  if (typeof message !== "string" || !isWellFormed(message)) {
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

/** Validates one ServiceError wire kind at a public runtime boundary. */
function wireKind(value: unknown): ServiceErrorWireKind {
  if (value !== "unary") throw new TypeError("ServiceError wire kind must be unary")
  return value
}

/** Builds a frozen envelope whose body reads never expose retained canonical bytes. */
function serviceErrorEnvelope(
  _kind: ServiceErrorWireKind,
  error: ServiceError,
  body: Uint8Array
): ServiceErrorEnvelope {
  const retained = new Uint8Array(body)
  const header = Object.freeze({
    [serviceErrorHeader]: "v1",
    [serviceErrorCode]: error.code,
    [serviceErrorStatus]: String(error.status),
    [contentType]: ServiceErrorContentType
  })
  const envelope: ServiceErrorEnvelope = {
    serviceStatus: error.status,
    carrierStatus: 200,
    header,
    /** Returns detached canonical ServiceError bytes for every read. */
    get body(): Uint8Array {
      return new Uint8Array(retained)
    }
  }
  return Object.freeze(envelope)
}

/** Encodes one branded ServiceError through the sole canonical wire helper. */
export function encodeServiceError(
  kind: ServiceErrorWireKind,
  error: ServiceError
): ServiceErrorEnvelope {
  const selectedKind = wireKind(kind)
  if (!isServiceError(error)) throw new TypeError("ServiceError encoder requires a branded error")
  return serviceErrorEnvelope(selectedKind, error, canonicalServiceErrorBody(error))
}

/** Reads one header name case-insensitively and rejects ambiguous case variants. */
function headerValue(header: unknown, expectedName: string): HeaderValue {
  if (!isRecord(header)) throw new TypeError("ServiceError header must be a string record")
  const prototype = Object.getPrototypeOf(header)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("ServiceError header must be a plain string record")
  }
  const expected = expectedName.toLowerCase()
  let found = false
  let value = ""
  for (const key of Object.keys(header)) {
    const item = own(header, key)
    if (typeof item !== "string") throw new TypeError("ServiceError header values must be strings")
    if (key.toLowerCase() !== expected) continue
    if (found) throw new TypeError("ServiceError header contains duplicate case variants")
    found = true
    value = item
  }
  return Object.freeze({ found, value })
}

/** Copies one parsed metadata object into a string record for bounded validation. */
function parsedMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new TypeError("ServiceError body metadata must be an object")
  const entries: [string, string][] = []
  for (const key of Object.keys(value)) {
    const item = own(value, key)
    if (typeof item !== "string") {
      throw new TypeError("ServiceError body metadata values must be strings")
    }
    entries.push([key, item])
  }
  return Object.fromEntries(entries)
}

/** Reports whether two byte sequences are exactly equal. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Decodes one marker-present ServiceError carrier under strict canonical rules. */
function decodeMarkedServiceError(
  _kind: ServiceErrorWireKind,
  carrierStatus: number,
  header: Readonly<Record<string, string>>,
  body: Uint8Array,
  marker: HeaderValue
): ServiceError {
  if (marker.value !== "v1") throw new TypeError("ServiceError marker is unsupported")
  if (!Number.isInteger(carrierStatus))
    throw new TypeError("ServiceError carrier status is invalid")
  if (carrierStatus !== 200) throw new TypeError("unary ServiceError carrier status must be 200")
  const codeHeader = headerValue(header, serviceErrorCode)
  const statusHeader = headerValue(header, serviceErrorStatus)
  const typeHeader = headerValue(header, contentType)
  if (!codeHeader.found || !statusHeader.found || !typeHeader.found) {
    throw new TypeError("ServiceError wire is missing a required header")
  }
  if (typeHeader.value !== ServiceErrorContentType) {
    throw new TypeError("ServiceError content type is invalid")
  }
  if (!(body instanceof Uint8Array) || body.byteLength > MaximumServiceErrorBodyBytes) {
    throw new TypeError("ServiceError body is invalid")
  }
  const text = Decoder.decode(body)
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new TypeError("ServiceError body must be an object")
  if (Object.keys(parsed).join(",") !== "code,message,status,metadata") {
    throw new TypeError("ServiceError body schema is invalid")
  }
  const code = own(parsed, "code")
  const message = own(parsed, "message")
  const status = own(parsed, "status")
  if (typeof code !== "string" || typeof message !== "string" || typeof status !== "number") {
    throw new TypeError("ServiceError body fields are invalid")
  }
  const decoded = serviceError(code, message, status, parsedMetadata(own(parsed, "metadata")))
  if (codeHeader.value !== decoded.code || statusHeader.value !== String(decoded.status)) {
    throw new TypeError("ServiceError header and body disagree")
  }
  if (!equalBytes(body, canonicalServiceErrorBody(decoded))) {
    throw new TypeError("ServiceError body is not canonical")
  }
  return decoded
}

/** Decodes one canonical ServiceError or returns null when its marker is absent. */
export function decodeServiceError(
  kind: ServiceErrorWireKind,
  carrierStatus: number,
  header: Readonly<Record<string, string>>,
  body: Uint8Array
): ServiceError | null {
  const selectedKind = wireKind(kind)
  let marker: HeaderValue
  try {
    marker = headerValue(header, serviceErrorHeader)
  } catch {
    throw newTransportProtocolError("invalid ServiceError wire")
  }
  if (!marker.found) return null
  try {
    return decodeMarkedServiceError(selectedKind, carrierStatus, header, body, marker)
  } catch {
    throw newTransportProtocolError("invalid ServiceError wire")
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

import { type ServiceInstance } from "@go-like/registry"
import { newRegistryProtocolError, snapshotServiceInstance } from "@go-like/registry/provider"

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567"
const wireMarker = "go-like.registry-etcd.instance.v1"
const identityMarker = "go-like.registry-instance.identity.v1"
const contentMarker = "go-like.registry-instance.content.v1"
const maximumPayloadBytes = 1_048_576

/** Describes one immutable canonical record ready for the etcd gateway. */
export interface EncodedRecord {
  readonly key: string
  readonly value: string
  readonly identity: string
  readonly content: string
  readonly instance: ServiceInstance
}

/** Describes one verified record decoded from etcd. */
export interface DecodedRecord {
  readonly identity: string
  readonly content: string
  readonly instance: ServiceInstance
}

/** Reads one own data property without invoking inherited accessors. */
function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Reports whether one unknown value can carry a ServiceInstance. */
function instanceCarrier(value: unknown): value is ServiceInstance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const metadata = property(value, "metadata")
  const endpoints = property(value, "endpoints")
  return (
    typeof property(value, "id") === "string" &&
    typeof property(value, "name") === "string" &&
    typeof property(value, "version") === "string" &&
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    Array.isArray(endpoints)
  )
}

/** Encodes arbitrary bytes as padded RFC 4648 Base64. */
export function base64(bytes: Uint8Array): string {
  let output = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const combined = (first << 16) | (second << 8) | third
    output += base64Alphabet.charAt((combined >>> 18) & 63)
    output += base64Alphabet.charAt((combined >>> 12) & 63)
    output += index + 1 < bytes.length ? base64Alphabet.charAt((combined >>> 6) & 63) : "="
    output += index + 2 < bytes.length ? base64Alphabet.charAt(combined & 63) : "="
  }
  return output
}

/** Decodes canonical padded RFC 4648 Base64 or fails closed. */
export function unbase64(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw newRegistryProtocolError("etcd response contains invalid Base64")
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const bytes = new Uint8Array((value.length / 4) * 3 - padding)
  let offset = 0
  for (let index = 0; index < value.length; index += 4) {
    const first = base64Alphabet.indexOf(value.charAt(index))
    const second = base64Alphabet.indexOf(value.charAt(index + 1))
    const thirdText = value.charAt(index + 2)
    const fourthText = value.charAt(index + 3)
    const third = thirdText === "=" ? 0 : base64Alphabet.indexOf(thirdText)
    const fourth = fourthText === "=" ? 0 : base64Alphabet.indexOf(fourthText)
    const combined = (first << 18) | (second << 12) | (third << 6) | fourth
    if (offset < bytes.length) bytes[offset++] = (combined >>> 16) & 255
    if (offset < bytes.length) bytes[offset++] = (combined >>> 8) & 255
    if (offset < bytes.length) bytes[offset++] = combined & 255
  }
  if (base64(bytes) !== value) {
    throw newRegistryProtocolError("etcd response Base64 is not canonical")
  }
  return bytes
}

/** Encodes one UTF-8 string for an etcd bytes field. */
export function encodeBytes(value: string): string {
  return base64(new TextEncoder().encode(value))
}

/** Decodes one etcd bytes field as fatal UTF-8. */
export function decodeBytes(value: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(unbase64(value))
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "GO_LIKE_REGISTRY_PROTOCOL"
    ) {
      throw error
    }
    throw newRegistryProtocolError(
      "etcd response contains invalid UTF-8",
      error instanceof Error ? error : undefined
    )
  }
}

/** Returns the exclusive byte range end for one non-empty UTF-8 prefix. */
export function prefixRangeEnd(prefix: string): string {
  const bytes = new TextEncoder().encode(prefix)
  if (bytes.length === 0) return "AA=="
  const result = bytes.slice()
  const index = result.length - 1
  result[index] = (result[index] ?? 0) + 1
  return base64(result)
}

/** Returns the exact provider-managed record key prefix. */
export function recordPrefix(prefix: string): string {
  return `${prefix}records/`
}

/** Encodes digest bytes as lowercase RFC 4648 Base32 without padding. */
function base32(bytes: Uint8Array): string {
  let output = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += base32Alphabet.charAt((buffer >>> bits) & 31)
    }
  }
  if (bits > 0) output += base32Alphabet.charAt((buffer << (5 - bits)) & 31)
  return output
}

/** Computes one stable SHA-256 Base32 identifier. */
async function hash(prefix: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return `${prefix}-${base32(new Uint8Array(digest))}`
}

/** Computes the provider wire identity from public name and instance ID only. */
function instanceIdentity(instance: ServiceInstance): Promise<string> {
  return hash("li", [identityMarker, instance.name, instance.id])
}

/** Returns the deterministic etcd identity for one public ServiceInstance. */
export function registrationIdentity(value: ServiceInstance): Promise<string> {
  return instanceIdentity(snapshotServiceInstance(value))
}

/** Computes one complete immutable content fingerprint. */
function instanceContent(instance: ServiceInstance): Promise<string> {
  return hash("lc", [contentMarker, instance])
}

/** Encodes one ServiceInstance as one deterministic lease-backed record. */
export async function encodeRecord(prefix: string, value: ServiceInstance): Promise<EncodedRecord> {
  const instance = snapshotServiceInstance(value)
  const [identity, content] = await Promise.all([
    instanceIdentity(instance),
    instanceContent(instance)
  ])
  const encoded = JSON.stringify([wireMarker, identity, content, instance])
  if (new TextEncoder().encode(encoded).length > maximumPayloadBytes) {
    throw new RangeError(`etcd ServiceInstance payload exceeds ${maximumPayloadBytes} bytes`)
  }
  return Object.freeze({
    key: `${recordPrefix(prefix)}${identity}`,
    value: encoded,
    identity,
    content,
    instance
  })
}

/** Decodes and cryptographically verifies one managed etcd record. */
export async function decodeRecord(
  prefix: string,
  key: string,
  value: string
): Promise<DecodedRecord> {
  if (new TextEncoder().encode(value).length > maximumPayloadBytes) {
    throw newRegistryProtocolError("etcd managed record exceeds the payload ceiling")
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch (error) {
    throw newRegistryProtocolError(
      "etcd managed record is not valid JSON",
      error instanceof Error ? error : undefined
    )
  }
  if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== wireMarker) {
    throw newRegistryProtocolError("etcd managed record has an unsupported wire shape")
  }
  const identity = decoded[1]
  const content = decoded[2]
  const rawInstance = decoded[3]
  if (
    typeof identity !== "string" ||
    typeof content !== "string" ||
    !instanceCarrier(rawInstance)
  ) {
    throw newRegistryProtocolError("etcd managed record fields are invalid")
  }
  let instance: ServiceInstance
  try {
    instance = snapshotServiceInstance(rawInstance)
  } catch (error) {
    throw newRegistryProtocolError(
      "etcd managed record contains an invalid ServiceInstance",
      error instanceof Error ? error : undefined
    )
  }
  const [expectedIdentity, expectedContent] = await Promise.all([
    instanceIdentity(instance),
    instanceContent(instance)
  ])
  if (
    identity !== expectedIdentity ||
    content !== expectedContent ||
    key !== `${recordPrefix(prefix)}${identity}`
  ) {
    throw newRegistryProtocolError("etcd managed record key or canonical hash does not match")
  }
  return Object.freeze({ identity, content, instance })
}

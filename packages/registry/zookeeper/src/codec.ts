import { type ServiceInstance } from "@go-like/registry"
import { newRegistryProtocolError, snapshotServiceInstance } from "@go-like/registry/provider"

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const wireMarker = "go-like.registry-zookeeper.v2"
const maximumPayloadBytes = 1_048_576

/** Describes one immutable instance record stored in an ephemeral znode. */
export interface EncodedRecord {
  readonly path: string
  readonly servicePath: string
  readonly data: Uint8Array
  readonly identity: string
  readonly instance: ServiceInstance
}

/** Describes one verified instance record decoded from ZooKeeper. */
export interface DecodedRecord {
  readonly path: string
  readonly identity: string
  readonly instance: ServiceInstance
}

/** Encodes arbitrary bytes as padded RFC 4648 Base64. */
function base64(bytes: Uint8Array): string {
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
function unbase64(value: string): Uint8Array {
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
    throw newRegistryProtocolError("ZooKeeper path segment Base64 is not canonical")
  }
  return bytes
}

/** Encodes one Unicode value as one slash-free canonical znode segment. */
export function encodePathSegment(value: string): string {
  if (typeof value !== "string") throw new TypeError("ZooKeeper path value must be a string")
  const encoded = base64(new TextEncoder().encode(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
  return `u-${encoded}`
}

/** Decodes one canonical slash-free znode segment as fatal UTF-8. */
export function decodePathSegment(value: string): string {
  if (typeof value !== "string" || !/^u-[A-Za-z0-9_-]*$/.test(value)) {
    throw newRegistryProtocolError("ZooKeeper path segment is invalid")
  }
  const raw = value.slice(2).replaceAll("-", "+").replaceAll("_", "/")
  if (raw.length % 4 === 1) {
    throw newRegistryProtocolError("ZooKeeper path segment has invalid Base64 length")
  }
  const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), "=")
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(unbase64(padded))
    return decoded
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "GO_LIKE_REGISTRY_PROTOCOL") {
      throw error
    }
    throw newRegistryProtocolError(
      "ZooKeeper path segment contains invalid UTF-8",
      error instanceof Error ? error : undefined
    )
  }
}

/** Returns the persistent services directory. */
export function servicesPath(root: string): string {
  return `${root}/services`
}

/** Returns one persistent service directory. */
export function servicePath(root: string, name: string): string {
  return `${servicesPath(root)}/${encodePathSegment(name)}`
}

/** Returns one deterministic instance znode path, matching Kratos name/id semantics. */
export function instancePath(root: string, name: string, id: string): string {
  return `${servicePath(root, name)}/${encodePathSegment(id)}`
}

/** Returns the stable provider-local logical identity. */
export function instanceIdentity(value: ServiceInstance): string {
  return JSON.stringify([value.name, value.id])
}

/** Encodes one ServiceInstance as one deterministic ephemeral record. */
export function encodeRecord(root: string, value: ServiceInstance): EncodedRecord {
  const instance = snapshotServiceInstance(value)
  const text = JSON.stringify([wireMarker, instance])
  const data = new TextEncoder().encode(text)
  if (data.length > maximumPayloadBytes) {
    throw new RangeError(`ZooKeeper service payload exceeds ${maximumPayloadBytes} bytes`)
  }
  return Object.freeze({
    path: instancePath(root, instance.name, instance.id),
    servicePath: servicePath(root, instance.name),
    data,
    identity: instanceIdentity(instance),
    instance
  })
}

/** Decodes and verifies one deterministic managed znode. */
export function decodeRecord(root: string, path: string, bytes: Uint8Array): DecodedRecord {
  if (bytes.length > maximumPayloadBytes) {
    throw newRegistryProtocolError("ZooKeeper managed record exceeds the payload ceiling")
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw newRegistryProtocolError(
      "ZooKeeper managed record contains invalid UTF-8",
      error instanceof Error ? error : undefined
    )
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (error) {
    throw newRegistryProtocolError(
      "ZooKeeper managed record is not valid JSON",
      error instanceof Error ? error : undefined
    )
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== wireMarker) {
    throw newRegistryProtocolError("ZooKeeper managed record has an unsupported wire shape")
  }
  let instance: ServiceInstance
  try {
    instance = snapshotServiceInstance(decoded[1] as ServiceInstance)
  } catch (error) {
    throw newRegistryProtocolError(
      "ZooKeeper managed record contains an invalid ServiceInstance",
      error instanceof Error ? error : undefined
    )
  }
  const expectedPath = instancePath(root, instance.name, instance.id)
  if (path !== expectedPath) {
    throw newRegistryProtocolError("ZooKeeper managed record path does not match its identity")
  }
  return Object.freeze({
    path,
    identity: instanceIdentity(instance),
    instance
  })
}

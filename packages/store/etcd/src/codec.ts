import type { StoreRecord, StoreRecordInput } from "@likego/store"
import { snapshotStoreRecord, snapshotStoreRecordInput } from "@likego/store/provider"

import { newEtcdStoreProtocolError } from "./errors"
import type { EtcdStoreOperation } from "./types"

/** Carries one validated etcd KV together with provider-only wire state. */
export interface EtcdRow {
  readonly record: StoreRecord
  readonly payload: string
  readonly lease: string
}

/** Carries one prefix- and revision-bound pagination continuation. */
export interface EtcdCursor {
  readonly prefix: string
  readonly lastKey: string
  readonly revision: string
}

interface WireRecordCandidate {
  readonly version?: unknown
  readonly operation?: unknown
  readonly value?: unknown
  readonly metadata?: unknown
  readonly expiresAt?: unknown
}

interface CursorCandidate {
  readonly version?: unknown
  readonly prefix?: unknown
  readonly lastKey?: unknown
  readonly revision?: unknown
}

export const maximumKeyBytes = 1_024
export const maximumValueBytes = 524_288
export const maximumPayloadBytes = 786_432
const Base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** Reports whether one value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one own data property without invoking accessors. */
function own(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Reports whether one object contains exactly the selected enumerable keys. */
function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  if (keys.length !== expected.length) return false
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== expected[index]) return false
  }
  return true
}

/** Reports whether one string contains only complete UTF-16 scalar sequences. */
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

/** Validates one decimal signed int64 carrier without precision loss. */
export function decimal(value: unknown, allowZero: boolean, operation: EtcdStoreOperation): string {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
    throw newEtcdStoreProtocolError(operation)
  }
  const parsed = BigInt(value)
  if (
    String(parsed) !== value ||
    (!allowZero && parsed === 0n) ||
    parsed < -9_223_372_036_854_775_808n ||
    parsed > 9_223_372_036_854_775_807n
  ) {
    throw newEtcdStoreProtocolError(operation)
  }
  return String(parsed)
}

/** Validates one non-negative etcd revision without losing precision. */
export function revisionDecimal(
  value: unknown,
  allowZero: boolean,
  operation: EtcdStoreOperation
): string {
  const revision = decimal(value, allowZero, operation)
  if (revision.startsWith("-")) throw newEtcdStoreProtocolError(operation)
  return revision
}

/** Validates one positive opaque Store revision for an etcd MOD comparison. */
export function compareRevision(value: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError("etcd Store revision must be a positive decimal string")
  }
  const parsed = BigInt(value)
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new RangeError("etcd Store revision exceeds signed int64")
  }
  return value
}

/** Returns one exact base64 alphabet symbol for a six-bit value. */
function base64Symbol(index: number): string {
  const symbol = Base64Alphabet[index]
  if (symbol === undefined) throw new RangeError("base64 symbol is invalid")
  return symbol
}

/** Encodes detached bytes as canonical padded RFC 4648 base64. */
export function encodeBase64(bytes: Uint8Array): string {
  let encoded = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    encoded += base64Symbol((first >> 2) & 63)
    encoded += base64Symbol(((first & 3) << 4) | ((second ?? 0) >> 4))
    encoded += second === undefined ? "=" : base64Symbol(((second & 15) << 2) | ((third ?? 0) >> 6))
    encoded += third === undefined ? "=" : base64Symbol(third & 63)
  }
  return encoded
}

/** Decodes bounded canonical base64 without retaining the caller's carrier. */
export function decodeBase64(
  value: unknown,
  maximumBytes: number,
  operation: EtcdStoreOperation
): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw newEtcdStoreProtocolError(operation)
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const length = value.length === 0 ? 0 : (value.length / 4) * 3 - padding
  if (length > maximumBytes) throw newEtcdStoreProtocolError(operation)
  const contentLength = value.length - padding
  for (let index = 0; index < contentLength; index += 1) {
    if (Base64Alphabet.indexOf(value[index] ?? "") < 0) {
      throw newEtcdStoreProtocolError(operation)
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (let index = 0; index < value.length; index += 4) {
    const first = Base64Alphabet.indexOf(value[index] ?? "")
    const second = Base64Alphabet.indexOf(value[index + 1] ?? "")
    const third = value[index + 2] === "=" ? 0 : Base64Alphabet.indexOf(value[index + 2] ?? "")
    const fourth = value[index + 3] === "=" ? 0 : Base64Alphabet.indexOf(value[index + 3] ?? "")
    if (offset < length) bytes[offset] = (first << 2) | (second >> 4)
    if (offset + 1 < length) bytes[offset + 1] = ((second & 15) << 4) | (third >> 2)
    if (offset + 2 < length) bytes[offset + 2] = ((third & 3) << 6) | fourth
    offset += 3
  }
  if (encodeBase64(bytes) !== value) throw newEtcdStoreProtocolError(operation)
  return bytes
}

/** Encodes one exact UTF-8 string for the etcd gateway. */
export function encodeText(value: string): string {
  return encodeBase64(encoder.encode(value))
}

/** Decodes one bounded UTF-8 gateway field. */
function decodeText(value: unknown, maximumBytes: number, operation: EtcdStoreOperation): string {
  try {
    return decoder.decode(decodeBase64(value, maximumBytes, operation))
  } catch {
    throw newEtcdStoreProtocolError(operation)
  }
}

/** Validates one Store key or prefix against etcd provider bounds. */
export function storeKey(value: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || !isWellFormed(value)) {
    throw new TypeError("etcd Store key must be a well-formed string")
  }
  if (encoder.encode(value).byteLength > maximumKeyBytes) {
    throw new RangeError(`etcd Store key exceeds ${maximumKeyBytes} UTF-8 bytes`)
  }
  return value
}

/** Encodes one validated Store input into the stable LikeGo etcd payload. */
export function encodeRecordPayload(
  value: StoreRecordInput,
  operation: string,
  expiresAt: number | null
): string {
  const record = snapshotStoreRecordInput(value)
  if (record.value.byteLength > maximumValueBytes) {
    throw new RangeError(`etcd Store value exceeds ${maximumValueBytes} bytes`)
  }
  const payload = JSON.stringify({
    version: 1,
    operation,
    value: encodeBase64(record.value),
    metadata: record.metadata ?? {},
    expiresAt
  })
  if (encoder.encode(payload).byteLength > maximumPayloadBytes) {
    throw new RangeError(`etcd Store encoded record exceeds ${maximumPayloadBytes} bytes`)
  }
  return payload
}

/** Copies one string-only metadata carrier without prototype-sensitive assignment. */
function decodeMetadata(
  value: unknown,
  operation: EtcdStoreOperation
): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw newEtcdStoreProtocolError(operation)
  const entries: [string, string][] = []
  for (const key of Object.keys(value)) {
    const item = own(value, key)
    if (!isWellFormed(key) || typeof item !== "string" || !isWellFormed(item)) {
      throw newEtcdStoreProtocolError(operation)
    }
    entries.push([key, item])
  }
  return Object.fromEntries(entries)
}

/** Decodes one LikeGo payload and retains no mutable JSON carrier. */
function decodePayload(
  key: string,
  revision: string,
  payload: string,
  lease: string,
  operation: EtcdStoreOperation
): StoreRecord {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw newEtcdStoreProtocolError(operation)
  }
  if (
    !isRecord(value) ||
    !hasKeys(value, ["expiresAt", "metadata", "operation", "value", "version"])
  ) {
    throw newEtcdStoreProtocolError(operation)
  }
  const candidate: WireRecordCandidate = value
  const marker = candidate.operation
  const expiresAt = candidate.expiresAt
  if (
    candidate.version !== 1 ||
    typeof marker !== "string" ||
    marker.length === 0 ||
    !isWellFormed(marker) ||
    (expiresAt !== null &&
      (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0)) ||
    (expiresAt === null) !== (lease === "0")
  ) {
    throw newEtcdStoreProtocolError(operation)
  }
  try {
    return snapshotStoreRecord({
      key,
      value: decodeBase64(candidate.value, maximumValueBytes, operation),
      metadata: decodeMetadata(candidate.metadata, operation),
      revision,
      expiresAt
    })
  } catch {
    throw newEtcdStoreProtocolError(operation)
  }
}

/** Decodes one exact etcd KV into a validated Store row. */
export function decodeRow(value: unknown, operation: EtcdStoreOperation): EtcdRow {
  try {
    if (!isRecord(value)) throw newEtcdStoreProtocolError(operation)
    const key = storeKey(decodeText(own(value, "key"), maximumKeyBytes, operation), false)
    const revision = revisionDecimal(own(value, "mod_revision"), false, operation)
    const lease = decimal(own(value, "lease") ?? "0", true, operation)
    const payload = decodeText(own(value, "value"), maximumPayloadBytes, operation)
    return Object.freeze({
      record: decodePayload(key, revision, payload, lease, operation),
      payload,
      lease
    })
  } catch {
    throw newEtcdStoreProtocolError(operation)
  }
}

/** Reports whether exact readback proves one intended payload and lease. */
export function matches(row: EtcdRow | null, payload: string, lease: string): boolean {
  return row !== null && row.payload === payload && row.lease === lease
}

/** Returns the exclusive end key required by one etcd prefix range. */
export function prefixRangeEnd(prefix: string): string {
  const bytes = encoder.encode(prefix)
  if (bytes.length === 0) return encodeBase64(new Uint8Array([0]))
  const end = new Uint8Array(bytes)
  const index = end.length - 1
  const byte = end[index] ?? 0
  end[index] = byte + 1
  return encodeBase64(end)
}

/** Returns the inclusive etcd range start for a prefix page. */
export function pageStart(prefix: string, lastKey: string | null): string {
  if (lastKey !== null) return encodeText(`${lastKey}\0`)
  return prefix === "" ? encodeBase64(new Uint8Array([0])) : encodeText(prefix)
}

/** Encodes one prefix- and revision-bound opaque pagination cursor. */
export function encodeCursor(prefix: string, lastKey: string, revision: string): string {
  const json = JSON.stringify({ version: 1, prefix, lastKey, revision })
  return encodeBase64(encoder.encode(json))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

/** Decodes one canonical opaque cursor and binds it to the selected prefix. */
export function decodeCursor(value: string, prefix: string): EtcdCursor {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("etcd Store cursor is invalid")
  const standard = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=")
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(decodeBase64(padded, 8_192, "list")))
  } catch {
    throw new TypeError("etcd Store cursor is invalid")
  }
  if (!isRecord(parsed) || !hasKeys(parsed, ["lastKey", "prefix", "revision", "version"])) {
    throw new TypeError("etcd Store cursor is invalid")
  }
  const candidate: CursorCandidate = parsed
  if (
    candidate.version !== 1 ||
    candidate.prefix !== prefix ||
    typeof candidate.lastKey !== "string" ||
    candidate.lastKey.length === 0 ||
    !isWellFormed(candidate.lastKey) ||
    typeof candidate.revision !== "string"
  ) {
    throw new TypeError("etcd Store cursor is invalid")
  }
  try {
    storeKey(candidate.lastKey, false)
    compareRevision(candidate.revision)
  } catch {
    throw new TypeError("etcd Store cursor is invalid")
  }
  if (!candidate.lastKey.startsWith(prefix)) {
    throw new TypeError("etcd Store cursor is invalid")
  }
  return Object.freeze({
    prefix,
    lastKey: candidate.lastKey,
    revision: candidate.revision
  })
}

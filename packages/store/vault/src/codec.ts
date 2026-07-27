import type { StoreRecord, StoreRecordInput } from "@likego/store"
import { snapshotStoreRecord, snapshotStoreRecordInput } from "@likego/store/provider"

import { newProtocolError } from "./errors"
import type { VaultStoreOperation } from "./types"

/** Carries one decoded public record plus its private idempotency marker. */
export interface VaultRow {
  readonly record: StoreRecord
  readonly operation: string
}

export const maximumKeyBytes = 1_024
export const maximumValueBytes = 1_048_576
const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

/** Reports whether one value is a non-array object. */
function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one own JSON data property without consulting its prototype. */
function own(value: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(value, name)?.value
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

/** Encodes detached bytes as canonical standard base64. */
export function encodeBase64(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Decodes and round-trips canonical standard base64. */
export function decodeBase64(value: unknown, operation: VaultStoreOperation): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw newProtocolError(operation)
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw newProtocolError(operation)
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (encodeBase64(bytes) !== value) throw newProtocolError(operation)
  return bytes
}

/** Encodes one logical key into a canonical single-segment UTF-8 base64url name. */
export function physicalKey(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError("Vault Store key must be a non-empty well-formed string")
  }
  const bytes = utf8.encode(value)
  if (bytes.byteLength > maximumKeyBytes) {
    throw new RangeError(`Vault Store key exceeds ${maximumKeyBytes} UTF-8 bytes`)
  }
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

/** Decodes and canonicalizes one physical Vault metadata key. */
function logicalKey(value: unknown, operation: "list"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw newProtocolError(operation)
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=")
  let decoded: string
  try {
    decoded = utf8Decoder.decode(decodeBase64(padded, operation))
    if (physicalKey(decoded) !== value) throw new Error("non-canonical")
  } catch {
    throw newProtocolError(operation)
  }
  return decoded
}

/** Copies one JSON string map without prototype mutation. */
function decodeMetadata(
  value: unknown,
  operation: VaultStoreOperation
): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw newProtocolError(operation)
  const entries: [string, string][] = []
  for (const key of Object.keys(value)) {
    const item = own(value, key)
    if (typeof item !== "string") throw newProtocolError(operation)
    entries.push([key, item])
  }
  return Object.fromEntries(entries)
}

/** Reads one positive Vault integer version. */
function version(value: unknown, operation: VaultStoreOperation): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw newProtocolError(operation)
  }
  return value
}

/** Encodes one detached Store record as a versioned, idempotency-marked Vault data envelope. */
export function encodeWriteBody(raw: StoreRecordInput, operation: string): string {
  const record = snapshotStoreRecordInput(raw)
  if (record.value.byteLength > maximumValueBytes) {
    throw new RangeError(`Vault Store value exceeds ${maximumValueBytes} bytes`)
  }
  if (typeof operation !== "string" || operation.length === 0) {
    throw new TypeError("Vault Store write operation marker must be non-empty")
  }
  return JSON.stringify({
    data: {
      version: 1,
      operation,
      value: encodeBase64(record.value),
      metadata: record.metadata ?? {}
    }
  })
}

/** Decodes one parsed KV v2 data response into a detached Store row. */
export function decodeDataEnvelope(
  envelope: unknown,
  key: string,
  operation: "read" | "delete" | "list" | "write"
): VaultRow {
  if (!isRecord(envelope)) throw newProtocolError(operation)
  const outer = own(envelope, "data")
  if (!isRecord(outer)) throw newProtocolError(operation)
  const data = own(outer, "data")
  const metadata = own(outer, "metadata")
  if (!isRecord(data) || !isRecord(metadata) || own(data, "version") !== 1) {
    throw newProtocolError(operation)
  }
  const marker = own(data, "operation")
  if (typeof marker !== "string" || marker.length === 0) throw newProtocolError(operation)
  return Object.freeze({
    record: snapshotStoreRecord({
      key,
      value: decodeBase64(own(data, "value"), operation),
      metadata: decodeMetadata(own(data, "metadata"), operation),
      revision: String(version(own(metadata, "version"), operation)),
      expiresAt: null
    }),
    operation: marker
  })
}

/** Decodes one parsed KV v2 write response version. */
export function decodeWriteVersion(envelope: unknown): string {
  if (!isRecord(envelope)) throw newProtocolError("write")
  const data = own(envelope, "data")
  if (!isRecord(data)) throw newProtocolError("write")
  return String(version(own(data, "version"), "write"))
}

/** Decodes one flat KV v2 metadata listing into canonical logical keys. */
export function decodeListKeys(envelope: unknown, operation: "list"): readonly string[] {
  if (!isRecord(envelope)) throw newProtocolError(operation)
  const data = own(envelope, "data")
  if (!isRecord(data)) throw newProtocolError(operation)
  const keys = own(data, "keys")
  if (!Array.isArray(keys)) throw newProtocolError(operation)
  const decoded: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const logical = logicalKey(key, operation)
    if (seen.has(logical)) throw newProtocolError(operation)
    seen.add(logical)
    decoded.push(logical)
  }
  return Object.freeze(decoded)
}

/** Reports whether one exact parsed Vault version has a soft-delete marker. */
export function decodeDeletedVersion(envelope: unknown, expectedVersion: number): boolean {
  if (!isRecord(envelope)) throw newProtocolError("delete")
  const outer = own(envelope, "data")
  if (!isRecord(outer)) throw newProtocolError("delete")
  const metadata = own(outer, "metadata")
  if (!isRecord(metadata) || version(own(metadata, "version"), "delete") !== expectedVersion) {
    throw newProtocolError("delete")
  }
  const deletionTime = own(metadata, "deletion_time")
  if (typeof deletionTime !== "string") throw newProtocolError("delete")
  return deletionTime.length !== 0
}

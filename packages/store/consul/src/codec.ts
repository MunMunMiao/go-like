import type { StoreRecord, StoreRecordInput } from "@go-like/store"
import { snapshotStoreRecord, snapshotStoreRecordInput } from "@go-like/store/provider"

import { newConsulStoreProtocolError } from "./errors"
import type { ConsulStoreOperation } from "./types"

/** Carries one validated Consul KV row and its provider-only wire state. */
export interface ConsulRow {
  readonly record: StoreRecord
  readonly payload: string
  readonly session: string | null
}

interface WireRecord {
  readonly version: 1
  readonly operation: string
  readonly value: string
  readonly metadata: Readonly<Record<string, string>>
  readonly expiresAt: number | null
}

/** Carries one validated Consul pagination position. */
export interface ConsulCursor {
  readonly lastKey: string
  readonly index: string
}

const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

/** Reports whether a value is a non-array object. */
function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one own JSON data property without consulting its prototype. */
function own(value: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(value, name)?.value
}

/** Encodes detached bytes as canonical standard base64. */
export function encodeBase64(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Decodes canonical standard base64 into detached bytes. */
export function decodeBase64(value: unknown, operation: ConsulStoreOperation): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw newConsulStoreProtocolError(operation)
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw newConsulStoreProtocolError(operation)
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Encodes one validated Store input into the stable go-like Consul payload. */
export function encodeRecordPayload(
  value: StoreRecordInput,
  operation: string,
  expiresAt: number | null
): string {
  const record = snapshotStoreRecordInput(value)
  const wire: WireRecord = {
    version: 1,
    operation,
    value: encodeBase64(record.value),
    metadata: record.metadata ?? Object.freeze({}),
    expiresAt
  }
  return JSON.stringify(wire)
}

/** Copies and validates one JSON metadata object without retaining its carrier. */
function decodeMetadata(
  value: object,
  operation: ConsulStoreOperation
): Readonly<Record<string, string>> {
  const entries: Array<[string, string]> = []
  for (const key of Object.keys(value)) {
    const item = own(value, key)
    if (typeof item !== "string") throw newConsulStoreProtocolError(operation)
    entries.push([key, item])
  }
  return Object.fromEntries(entries)
}

/** Decodes one go-like payload while retaining no mutable JSON carrier. */
function decodeRecordPayload(
  key: string,
  revision: string,
  payload: string,
  operation: ConsulStoreOperation
): StoreRecord {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw newConsulStoreProtocolError(operation)
  }
  if (!isRecord(value)) throw newConsulStoreProtocolError(operation)
  const version = own(value, "version")
  const operationId = own(value, "operation")
  const encoded = own(value, "value")
  const metadata = own(value, "metadata")
  const expiresAt = own(value, "expiresAt")
  if (
    version !== 1 ||
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    !isRecord(metadata) ||
    (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || typeof expiresAt !== "number"))
  ) {
    throw newConsulStoreProtocolError(operation)
  }
  try {
    return snapshotStoreRecord({
      key,
      value: decodeBase64(encoded, operation),
      metadata: decodeMetadata(metadata, operation),
      revision,
      expiresAt
    })
  } catch {
    throw newConsulStoreProtocolError(operation)
  }
}

/** Decodes and validates one complete Consul KV JSON response. */
export function decodeRows(
  text: string,
  operation: ConsulStoreOperation,
  keyPrefix: string
): readonly ConsulRow[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw newConsulStoreProtocolError(operation)
  }
  if (!Array.isArray(value)) throw newConsulStoreProtocolError(operation)
  const rows: ConsulRow[] = []
  for (const item of value) {
    if (!isRecord(item)) throw newConsulStoreProtocolError(operation)
    const key = own(item, "Key")
    const index = own(item, "ModifyIndex")
    const encoded = own(item, "Value")
    const rawSession = own(item, "Session")
    if (
      typeof key !== "string" ||
      !Number.isSafeInteger(index) ||
      typeof index !== "number" ||
      index < 1 ||
      (rawSession !== undefined && rawSession !== null && typeof rawSession !== "string")
    ) {
      throw newConsulStoreProtocolError(operation)
    }
    let payload: string
    try {
      payload = decoder.decode(decodeBase64(encoded, operation))
    } catch {
      throw newConsulStoreProtocolError(operation)
    }
    if (!key.startsWith(keyPrefix) || key.length === keyPrefix.length) {
      throw newConsulStoreProtocolError(operation)
    }
    const revision = String(index)
    rows.push(
      Object.freeze({
        record: decodeRecordPayload(key.slice(keyPrefix.length), revision, payload, operation),
        payload,
        session: typeof rawSession === "string" ? rawSession : null
      })
    )
  }
  return Object.freeze(rows)
}

/** Encodes one prefix- and Consul-index-bound opaque pagination cursor. */
export function encodeCursor(prefix: string, lastKey: string, index: string): string {
  const json = JSON.stringify({ version: 2, prefix, lastKey, index })
  return encodeBase64(encoder.encode(json))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

/** Decodes one opaque cursor and binds it to the current list prefix. */
export function decodeCursor(value: string, prefix: string): ConsulCursor {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("Consul Store cursor is invalid")
  const standard = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=")
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(decodeBase64(padded, "list")))
  } catch {
    throw new TypeError("Consul Store cursor is invalid")
  }
  const lastKey = isRecord(parsed) ? own(parsed, "lastKey") : null
  const index = isRecord(parsed) ? own(parsed, "index") : null
  if (
    !isRecord(parsed) ||
    own(parsed, "version") !== 2 ||
    own(parsed, "prefix") !== prefix ||
    typeof lastKey !== "string" ||
    lastKey === "" ||
    typeof index !== "string" ||
    !/^[1-9]\d*$/u.test(index)
  ) {
    throw new TypeError("Consul Store cursor is invalid")
  }
  return Object.freeze({ lastKey, index })
}

import type { Context } from "@go-like/context"
import { compareStoreKeys } from "@go-like/store/provider"

import {
  decodeRow,
  decimal,
  encodeText,
  pageStart,
  prefixRangeEnd,
  revisionDecimal,
  type EtcdRow
} from "./codec"
import { newEtcdStoreProtocolError } from "./errors"
import { postJson } from "./http"
import type { CapturedOptions } from "./options"
import type { EtcdStoreOperation } from "./types"

/** Describes one exact-key range result and its cluster revision. */
export interface ExactRange {
  readonly revision: string
  readonly row: EtcdRow | null
}

/** Describes one stable prefix page read from an etcd MVCC revision. */
export interface PrefixPage {
  readonly revision: string
  readonly rows: readonly EtcdRow[]
  readonly more: boolean
}

/** Describes one compare-protected put outcome. */
export interface PutTransaction {
  readonly succeeded: boolean
  readonly revision: string
  readonly current: EtcdRow | null
}

/** Describes one compare-protected delete outcome. */
export interface DeleteTransaction {
  readonly succeeded: boolean
  readonly revision: string
  readonly current: EtcdRow | null
}

/** Reports whether one gateway value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one own data property without invoking inherited accessors. */
function property(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one gateway carrier or throws a body-independent protocol error. */
function record(value: unknown, operation: EtcdStoreOperation): Record<string, unknown> {
  if (!isRecord(value)) throw newEtcdStoreProtocolError(operation)
  return value
}

/** Parses one mandatory gateway response header revision. */
function headerRevision(value: Record<string, unknown>, operation: EtcdStoreOperation): string {
  const header = record(property(value, "header"), operation)
  return revisionDecimal(property(header, "revision"), true, operation)
}

/** Parses every KV in one gateway range carrier. */
function keyValues(
  value: Record<string, unknown>,
  operation: EtcdStoreOperation
): readonly EtcdRow[] {
  const raw = property(value, "kvs")
  if (raw === undefined) return Object.freeze([])
  if (!Array.isArray(raw)) throw newEtcdStoreProtocolError(operation)
  const rows: EtcdRow[] = []
  for (const candidate of raw) rows.push(decodeRow(candidate, operation))
  return Object.freeze(rows)
}

/** Parses one exact range carrier and rejects ambiguous or foreign keys. */
function exactRangeResponse(
  value: unknown,
  operation: EtcdStoreOperation,
  key: string
): ExactRange {
  const response = record(value, operation)
  const revision = headerRevision(response, operation)
  const rows = keyValues(response, operation)
  const row = rows[0]
  if (rows.length > 1 || (row !== undefined && row.record.key !== key)) {
    throw newEtcdStoreProtocolError(operation)
  }
  return Object.freeze({ revision, row: row ?? null })
}

/** Reports whether two decoded rows prove the same physical etcd generation. */
function sameRow(left: EtcdRow | null, right: EtcdRow | null): boolean {
  if (left === null || right === null) return left === right
  return (
    left.record.key === right.record.key &&
    left.record.revision === right.record.revision &&
    left.payload === right.payload &&
    left.lease === right.lease
  )
}

/** Parses one transaction's boolean outcome; omitted proto defaults mean false. */
function transactionSucceeded(
  response: Record<string, unknown>,
  operation: "write" | "delete"
): boolean {
  const value = property(response, "succeeded")
  if (value === undefined || value === false) return false
  if (value === true) return true
  throw newEtcdStoreProtocolError(operation)
}

/** Returns the sole etcd transaction operation response. */
function transactionResponse(
  response: Record<string, unknown>,
  operation: "write" | "delete"
): Record<string, unknown> {
  const responses = property(response, "responses")
  if (!Array.isArray(responses) || responses.length !== 1) {
    throw newEtcdStoreProtocolError(operation)
  }
  return record(responses[0], operation)
}

/** Validates one nested transaction header against its enclosing revision. */
function nestedRevision(
  value: Record<string, unknown>,
  operation: "write" | "delete",
  expected: string
): void {
  if (headerRevision(value, operation) !== expected) {
    throw newEtcdStoreProtocolError(operation)
  }
}

/** Reads one exact key, optionally at one historical MVCC revision. */
export async function rangeExact(
  ctx: Context,
  options: CapturedOptions,
  operation: "read" | "write" | "write-readback" | "delete" | "delete-readback",
  key: string,
  revision: string | null = null
): Promise<ExactRange> {
  const body: Record<string, unknown> = { key: encodeText(key) }
  if (revision !== null) body.revision = revision
  const value = await postJson(ctx, options, operation, "/v3/kv/range", body)
  return exactRangeResponse(value, operation, key)
}

/** Reads one ordered prefix page at either a fresh or cursor-bound revision. */
export async function rangePrefix(
  ctx: Context,
  options: CapturedOptions,
  prefix: string,
  lastKey: string | null,
  revision: string | null,
  limit: number | null
): Promise<PrefixPage> {
  const body: Record<string, unknown> = {
    key: pageStart(prefix, lastKey),
    range_end: prefixRangeEnd(prefix),
    sort_order: "ASCEND",
    sort_target: "KEY"
  }
  if (revision !== null) body.revision = revision
  if (limit !== null) body.limit = String(limit)
  const response = record(await postJson(ctx, options, "list", "/v3/kv/range", body), "list")
  const responseRevision = headerRevision(response, "list")
  const rows = keyValues(response, "list")
  const moreValue = property(response, "more")
  if (moreValue !== undefined && typeof moreValue !== "boolean") {
    throw newEtcdStoreProtocolError("list")
  }
  if (moreValue === true && (limit === null || rows.length === 0)) {
    throw newEtcdStoreProtocolError("list")
  }
  let previous = lastKey
  for (const row of rows) {
    if (
      !row.record.key.startsWith(prefix) ||
      (previous !== null && compareStoreKeys(previous, row.record.key) >= 0)
    ) {
      throw newEtcdStoreProtocolError("list")
    }
    previous = row.record.key
  }
  return Object.freeze({
    revision: responseRevision,
    rows,
    more: moreValue === true
  })
}

/** Grants one independent lease and returns its exact signed decimal ID. */
export async function grantLease(
  ctx: Context,
  options: CapturedOptions,
  ttlSeconds: number
): Promise<string> {
  const response = record(
    await postJson(ctx, options, "lease-grant", "/v3/lease/grant", {
      TTL: String(ttlSeconds)
    }),
    "lease-grant"
  )
  const id = decimal(property(response, "ID"), false, "lease-grant")
  const ttl = decimal(property(response, "TTL"), false, "lease-grant")
  if (BigInt(ttl) <= 0n) throw newEtcdStoreProtocolError("lease-grant")
  return id
}

/** Revokes one exact lease after validating the gateway acknowledgement. */
export async function revokeLease(
  ctx: Context,
  options: CapturedOptions,
  lease: string
): Promise<void> {
  const response = record(
    await postJson(ctx, options, "lease-revoke", "/v3/lease/revoke", { ID: lease }),
    "lease-revoke"
  )
  headerRevision(response, "lease-revoke")
}

/** Executes one MOD/VERSION-protected put and returns either success or current state. */
export async function transactPut(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  payload: string,
  lease: string,
  expected: EtcdRow | null
): Promise<PutTransaction> {
  const encodedKey = encodeText(key)
  const compare =
    expected === null
      ? { target: "VERSION", result: "EQUAL", key: encodedKey, version: "0" }
      : {
          target: "MOD",
          result: "EQUAL",
          key: encodedKey,
          mod_revision: expected.record.revision
        }
  const response = record(
    await postJson(ctx, options, "write", "/v3/kv/txn", {
      compare: [compare],
      success: [
        {
          request_put: {
            key: encodedKey,
            value: encodeText(payload),
            lease,
            prev_kv: true
          }
        }
      ],
      failure: [{ request_range: { key: encodedKey } }]
    }),
    "write"
  )
  const revision = headerRevision(response, "write")
  const succeeded = transactionSucceeded(response, "write")
  const operation = transactionResponse(response, "write")
  if (succeeded) {
    if (revision === "0") throw newEtcdStoreProtocolError("write")
    const put = record(property(operation, "response_put"), "write")
    nestedRevision(put, "write", revision)
    const previousValue = property(put, "prev_kv")
    const previous = previousValue === undefined ? null : decodeRow(previousValue, "write")
    if (!sameRow(previous, expected)) throw newEtcdStoreProtocolError("write")
    return Object.freeze({ succeeded: true, revision, current: previous })
  }
  const range = record(property(operation, "response_range"), "write")
  nestedRevision(range, "write", revision)
  const current = exactRangeResponse(range, "write", key).row
  return Object.freeze({ succeeded: false, revision, current })
}

/** Executes one MOD-protected delete and returns either success or current state. */
export async function transactDelete(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  expected: EtcdRow
): Promise<DeleteTransaction> {
  const encodedKey = encodeText(key)
  const response = record(
    await postJson(ctx, options, "delete", "/v3/kv/txn", {
      compare: [
        {
          target: "MOD",
          result: "EQUAL",
          key: encodedKey,
          mod_revision: expected.record.revision
        }
      ],
      success: [{ request_delete_range: { key: encodedKey, prev_kv: true } }],
      failure: [{ request_range: { key: encodedKey } }]
    }),
    "delete"
  )
  const revision = headerRevision(response, "delete")
  const succeeded = transactionSucceeded(response, "delete")
  const operation = transactionResponse(response, "delete")
  if (succeeded) {
    if (revision === "0") throw newEtcdStoreProtocolError("delete")
    const deleted = record(property(operation, "response_delete_range"), "delete")
    nestedRevision(deleted, "delete", revision)
    if (property(deleted, "deleted") !== "1") {
      throw newEtcdStoreProtocolError("delete")
    }
    const previousValues = property(deleted, "prev_kvs")
    if (!Array.isArray(previousValues) || previousValues.length !== 1) {
      throw newEtcdStoreProtocolError("delete")
    }
    const previous = decodeRow(previousValues[0], "delete")
    if (!sameRow(previous, expected)) throw newEtcdStoreProtocolError("delete")
    return Object.freeze({ succeeded: true, revision, current: previous })
  }
  const range = record(property(operation, "response_range"), "delete")
  nestedRevision(range, "delete", revision)
  const current = exactRangeResponse(range, "delete", key).row
  return Object.freeze({ succeeded: false, revision, current })
}

import { background } from "@likego/context"
import { newRegistryProtocolError } from "@likego/registry/provider"

import { decodeBytes, encodeBytes, prefixRangeEnd, recordPrefix, type EncodedRecord } from "./codec"
import { postJson, retryable } from "./http"
import type { OperationOptions } from "./options"
import { operationLease } from "./runtime"

/** Describes one exact etcd key/value carrier. */
export interface KeyValue {
  readonly key: string
  readonly value: string
  readonly lease: string
  readonly modRevision: bigint
}

/** Describes one consistent etcd range response. */
export interface RangeSnapshot {
  readonly revision: bigint
  readonly records: readonly KeyValue[]
}

/** Reads one own data property without invoking inherited accessors. */
function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one unknown JSON value to a plain record carrier. */
function object(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw newRegistryProtocolError(message)
  }
  return value
}

/** Parses one JSON int64 string without losing precision. */
function integer(value: unknown, name: string, allowZero: boolean): bigint {
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) {
    throw newRegistryProtocolError(`etcd ${name} must be a decimal int64 string`)
  }
  const result = BigInt(value)
  if (!allowZero && result === 0n) {
    throw newRegistryProtocolError(`etcd ${name} must be non-zero`)
  }
  return result
}

/** Parses one mandatory gateway response header revision. */
function headerRevision(value: object): bigint {
  const header = object(property(value, "header"), "etcd response omitted its header")
  return integer(property(header, "revision"), "header revision", true)
}

/** Parses and validates every KV in one range response. */
function keyValues(value: object): readonly KeyValue[] {
  const raw = property(value, "kvs")
  if (raw === undefined) return Object.freeze([])
  if (!Array.isArray(raw)) throw newRegistryProtocolError("etcd range kvs must be an array")
  const records: KeyValue[] = []
  for (const candidate of raw) {
    const carrier = object(candidate, "etcd range contains an invalid KV")
    const encodedKey = property(carrier, "key")
    const encodedValue = property(carrier, "value")
    const lease = property(carrier, "lease")
    const modRevision = property(carrier, "mod_revision")
    if (typeof encodedKey !== "string" || typeof encodedValue !== "string") {
      throw newRegistryProtocolError("etcd range KV bytes fields are invalid")
    }
    records.push(
      Object.freeze({
        key: decodeBytes(encodedKey),
        value: decodeBytes(encodedValue),
        lease: String(integer(lease ?? "0", "KV lease", true)),
        modRevision: integer(modRevision, "KV mod_revision", false)
      })
    )
  }
  return Object.freeze(records)
}

/** Grants one independent lease and returns its exact decimal ID. */
export async function grantLease(
  options: OperationOptions,
  ttlSeconds: number,
  signal: AbortSignal
): Promise<string> {
  const response = object(
    await postJson(options, "lease-grant", "/v3/lease/grant", { TTL: String(ttlSeconds) }, signal),
    "etcd lease grant response is invalid"
  )
  const id = integer(property(response, "ID"), "lease ID", false)
  const ttl = integer(property(response, "TTL"), "lease TTL", false)
  if (ttl <= 0n) throw newRegistryProtocolError("etcd lease grant returned a non-positive TTL")
  return String(id)
}

/** Renews one lease once and reports whether the lease still exists. */
export async function keepAlive(
  options: OperationOptions,
  lease: string,
  signal: AbortSignal
): Promise<boolean> {
  const response = object(
    await postJson(options, "lease-keepalive", "/v3/lease/keepalive", { ID: lease }, signal),
    "etcd lease keepalive response is invalid"
  )
  const result = object(
    property(response, "result"),
    "etcd lease keepalive response omitted its result"
  )
  const id = integer(property(result, "ID"), "keepalive lease ID", true)
  if (String(id) !== lease) {
    throw newRegistryProtocolError("etcd keepalive returned another lease ID")
  }
  const ttlValue = property(result, "TTL")
  if (ttlValue === undefined) return false
  return integer(ttlValue, "keepalive TTL", true) > 0n
}

/** Revokes one exact lease; already-missing leases are accepted by etcd. */
export async function revokeLease(
  options: OperationOptions,
  lease: string,
  signal: AbortSignal
): Promise<void> {
  const response = object(
    await postJson(options, "lease-revoke", "/v3/lease/revoke", { ID: lease }, signal),
    "etcd lease revoke response is invalid"
  )
  headerRevision(response)
}

/** Reads one exact key or one complete provider prefix at a consistent revision. */
export async function range(
  options: OperationOptions,
  key: string,
  prefix: boolean,
  signal: AbortSignal
): Promise<RangeSnapshot> {
  const body: Record<string, string> = { key: encodeBytes(key) }
  if (prefix) body.range_end = prefixRangeEnd(key)
  const response = object(
    await postJson(options, "range", "/v3/kv/range", body, signal),
    "etcd range response is invalid"
  )
  return Object.freeze({ revision: headerRevision(response), records: keyValues(response) })
}

/** Reads every provider-managed registration record. */
export function rangeRecords(
  options: OperationOptions,
  signal: AbortSignal
): Promise<RangeSnapshot> {
  return range(options, recordPrefix(options.prefix), true, signal)
}

/** Reads one exact wire ownership state. */
export async function owns(
  options: OperationOptions,
  record: EncodedRecord,
  lease: string,
  signal: AbortSignal
): Promise<boolean> {
  const snapshot = await range(options, record.key, false, signal)
  const found = snapshot.records[0]
  return (
    snapshot.records.length === 1 &&
    found?.key === record.key &&
    found.value === record.value &&
    found.lease === lease
  )
}

/** Confirms one mutation outcome with an independent bounded readback. */
async function readback(
  options: OperationOptions,
  record: EncodedRecord,
  lease: string
): Promise<boolean> {
  const operation = operationLease(background(), null, options.timeoutMs)
  try {
    return await owns(options, record, lease, operation.signal)
  } finally {
    operation.release()
  }
}

/** Publishes one deterministic key and accepts an ambiguous response only after exact readback. */
export async function publish(
  options: OperationOptions,
  record: EncodedRecord,
  lease: string,
  signal: AbortSignal
): Promise<void> {
  let uncertain: unknown = null
  try {
    await postJson(
      options,
      "txn",
      "/v3/kv/txn",
      {
        compare: [],
        success: [
          {
            request_put: {
              key: encodeBytes(record.key),
              value: encodeBytes(record.value),
              lease
            }
          }
        ],
        failure: []
      },
      signal
    )
  } catch (error) {
    if (!retryable(error)) throw error
    uncertain = error
  }
  if (await readback(options, record, lease)) return
  if (uncertain !== null) throw uncertain
  throw newRegistryProtocolError("etcd transaction did not establish exact ownership")
}

/** Restores one expired record only while no other publisher owns its identity. */
export async function restore(
  options: OperationOptions,
  record: EncodedRecord,
  lease: string,
  signal: AbortSignal
): Promise<boolean> {
  let uncertain: unknown = null
  try {
    await postJson(
      options,
      "txn",
      "/v3/kv/txn",
      {
        compare: [
          {
            target: "CREATE",
            result: "EQUAL",
            key: encodeBytes(record.key),
            create_revision: "0"
          }
        ],
        success: [
          {
            request_put: {
              key: encodeBytes(record.key),
              value: encodeBytes(record.value),
              lease
            }
          }
        ],
        failure: [{ request_range: { key: encodeBytes(record.key) } }]
      },
      signal
    )
  } catch (error) {
    if (!retryable(error)) throw error
    uncertain = error
  }
  if (await readback(options, record, lease)) return true
  if (uncertain !== null) throw uncertain
  return false
}

/** Deletes one exact owned record and leaves a newer foreign generation untouched. */
export async function remove(
  options: OperationOptions,
  record: EncodedRecord,
  signal: AbortSignal
): Promise<void> {
  let uncertain: unknown = null
  try {
    await postJson(
      options,
      "txn",
      "/v3/kv/txn",
      {
        compare: [
          {
            target: "VALUE",
            result: "EQUAL",
            key: encodeBytes(record.key),
            value: encodeBytes(record.value)
          }
        ],
        success: [{ request_delete_range: { key: encodeBytes(record.key) } }],
        failure: [{ request_range: { key: encodeBytes(record.key) } }]
      },
      signal
    )
  } catch (error) {
    if (!retryable(error)) throw error
    uncertain = error
  }
  const operation = operationLease(background(), null, options.timeoutMs)
  try {
    const snapshot = await range(options, record.key, false, operation.signal)
    if (snapshot.records.length === 0) return
    const found = snapshot.records[0]
    if (found?.value !== record.value) return
    if (uncertain !== null) throw uncertain
    throw newRegistryProtocolError("etcd exact owned record remains after remove")
  } finally {
    operation.release()
  }
}

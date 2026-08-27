import { cause, type Context } from "@go-like/context"
import {
  type DeleteOption,
  type ListOption,
  type StorePage,
  type StoreRecord,
  type StoreRecordInput,
  type WriteOption
} from "@go-like/store"
import {
  compareStoreKeys,
  deleteOptions,
  listOptions,
  newStoreConflictError,
  snapshotStorePage,
  snapshotStoreRecordInput,
  writeOptions
} from "@go-like/store/provider"

import { decodeCursor, encodeCursor, encodeRecordPayload, type ConsulRow } from "./codec"
import {
  isUncertainFailure,
  newConsulStoreProtocolError,
  newConsulStoreUncertainError,
  newConsulStoreUnsupportedCombinationError
} from "./errors"
import {
  createSession,
  destroySession,
  encodedKey,
  mutateKey,
  queryExact,
  queryIndexedRows,
  type MutationMode
} from "./http"
import { captureOptions, isWellFormed, type CapturedOptions } from "./options"
import type { ConsulStore, ConsulStoreOptions } from "./types"

const MaximumKeyBytes = 1_024
// Leaves room for the largest safe expiresAt, UUID operation marker, and JSON envelope.
const MaximumValueBytes = 393_126
const MaximumPayloadBytes = 524_288
const MaximumListLimit = 1_000
const MinimumTtlMs = 10_000
const MaximumTtlMs = 86_400_000

/** Returns one exact Context terminal cause or null while active. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Rejects a canceled operation before provider validation or I/O. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Validates one Store key or list prefix against Consul provider bounds. */
function storeKey(value: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || !isWellFormed(value)) {
    throw new TypeError("Consul Store key must be a well-formed string")
  }
  if (new TextEncoder().encode(value).byteLength > MaximumKeyBytes) {
    throw new RangeError(`Consul Store key exceeds ${MaximumKeyBytes} UTF-8 bytes`)
  }
  encodedKey(value)
  return value
}

/** Reports whether one decoded record is no longer visible by declared TTL. */
function expired(row: ConsulRow): boolean {
  const expiresAt = row.record.expiresAt
  return expiresAt !== null && Date.now() >= expiresAt
}

/** Generates one per-write marker used by exact uncertain-response readback. */
function operationId(): string {
  return crypto.randomUUID()
}

/** Validates one payload against the documented Consul KV and provider value bounds. */
function writePayload(
  record: StoreRecordInput,
  operation: string,
  expiresAt: number | null
): string {
  if (record.value.byteLength > MaximumValueBytes) {
    throw new RangeError(`Consul Store value exceeds ${MaximumValueBytes} bytes`)
  }
  const payload = encodeRecordPayload(record, operation, expiresAt)
  if (new TextEncoder().encode(payload).byteLength > MaximumPayloadBytes) {
    throw new RangeError(`Consul Store encoded record exceeds ${MaximumPayloadBytes} bytes`)
  }
  return payload
}

/** Reports whether exact readback proves one intended payload and session owner. */
function matches(row: ConsulRow | null, payload: string, session: string | null): boolean {
  return row !== null && row.payload === payload && row.session === session
}

/** Executes one write mutation and always obtains its admitted ModifyIndex by exact readback. */
async function writeMutation(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  payload: string,
  mode: MutationMode,
  session: string | null
): Promise<ConsulRow | null> {
  let primary: Error | null = null
  try {
    if (!(await mutateKey(ctx, options, "write", key, payload, mode))) return null
  } catch (value) {
    if (!isUncertainFailure(value)) throw value
    primary = value instanceof Error ? value : newConsulStoreProtocolError("write")
  }
  let row: ConsulRow | null
  try {
    row = await queryExact(ctx, options, "write", key)
  } catch (value) {
    throw newConsulStoreUncertainError("write", primary ?? value)
  }
  if (matches(row, payload, session)) return row
  throw newConsulStoreUncertainError("write", primary ?? newConsulStoreProtocolError("write"))
}

/** Destroys a newly created session while preserving an earlier operation failure. */
async function rejectAfterSessionCleanup(
  ctx: Context,
  options: CapturedOptions,
  session: string,
  value: unknown
): Promise<never> {
  const primary = value instanceof Error ? value : newConsulStoreProtocolError("write")
  try {
    await destroySession(ctx, options, session)
  } catch (cleanup) {
    const failure =
      cleanup instanceof Error ? cleanup : newConsulStoreProtocolError("session-destroy")
    throw Object.freeze(
      new AggregateError([primary, failure], "Consul Store write and session cleanup failed")
    )
  }
  throw primary
}

/** Writes one persistent payload, atomically releasing an existing record session when needed. */
async function writePersistent(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  payload: string,
  current: ConsulRow | null
): Promise<StoreRecord> {
  const oldSession = current?.session ?? null
  const mode: MutationMode =
    oldSession === null
      ? Object.freeze({ kind: "plain" })
      : Object.freeze({ kind: "release", session: oldSession })
  const written = await writeMutation(ctx, options, key, payload, mode, null)
  if (written === null) {
    throw newConsulStoreUncertainError("write", newConsulStoreProtocolError("write"))
  }
  if (oldSession !== null) await destroySession(ctx, options, oldSession)
  return written.record
}

/** Writes one TTL payload under a newly created behavior-delete Consul session. */
async function writeExpiring(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  payload: string,
  operation: string,
  ttlMs: number,
  current: ConsulRow | null
): Promise<StoreRecord> {
  const session = await createSession(ctx, options, operation, ttlMs)
  try {
    const mode: MutationMode = Object.freeze({ kind: "acquire", session })
    let written = await writeMutation(ctx, options, key, payload, mode, session)
    if (written === null && current?.session !== null && current?.session !== undefined) {
      await destroySession(ctx, options, current.session)
      written = await writeMutation(ctx, options, key, payload, mode, session)
    }
    if (written === null) {
      throw newConsulStoreUncertainError("write", newConsulStoreProtocolError("write"))
    }
    return written.record
  } catch (value) {
    return await rejectAfterSessionCleanup(ctx, options, session, value)
  }
}

/** Deletes one exact decoded row through its ModifyIndex and then releases only its session. */
async function deleteRow(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  row: ConsulRow
): Promise<boolean> {
  const mode: MutationMode = Object.freeze({ kind: "cas", revision: row.record.revision })
  let primary: Error | null = null
  let accepted = false
  try {
    accepted = await mutateKey(ctx, options, "delete", key, null, mode)
  } catch (value) {
    if (!isUncertainFailure(value)) throw value
    primary = value instanceof Error ? value : newConsulStoreProtocolError("delete")
    let readback: ConsulRow | null
    try {
      readback = await queryExact(ctx, options, "delete", key)
    } catch {
      throw newConsulStoreUncertainError("delete", primary)
    }
    if (readback !== null) throw newConsulStoreUncertainError("delete", primary)
    accepted = true
  }
  if (!accepted) return false
  if (row.session !== null) await destroySession(ctx, options, row.session)
  return true
}

/** Creates one immediately usable Consul Store over an immutable borrowed Fetch snapshot. */
export function createConsulStore(construction: ConsulStoreOptions): ConsulStore {
  const options = captureOptions(construction)

  return Object.freeze({
    /** Reads one exact visible Consul KV record. */
    async read(ctx: Context, rawKey: string): Promise<StoreRecord | null> {
      checkContext(ctx)
      const key = storeKey(rawKey, false)
      const row = await queryExact(ctx, options, "read", key)
      return row === null || expired(row) ? null : row.record
    },
    /** Creates or replaces one persistent or TTL-backed Consul KV record. */
    async write(
      ctx: Context,
      rawRecord: StoreRecordInput,
      ...reducers: readonly WriteOption[] /* go-like-typed-rest: preserves Go-style Store options. */
    ): Promise<StoreRecord> {
      checkContext(ctx)
      const config = writeOptions(
        ...reducers /* go-like-typed-spread: forwards exact ordered Store options. */
      )
      if (config.expiresInMs !== null && (config.ifAbsent === true || config.ifRevision !== null)) {
        throw newConsulStoreUnsupportedCombinationError("ttl-cas")
      }
      if (
        config.expiresInMs !== null &&
        (config.expiresInMs < MinimumTtlMs || config.expiresInMs > MaximumTtlMs)
      ) {
        throw new RangeError(
          `Consul Store ttl must be between ${MinimumTtlMs} and ${MaximumTtlMs} milliseconds`
        )
      }
      const record = snapshotStoreRecordInput(rawRecord)
      const key = storeKey(record.key, false)
      const marker = operationId()
      const expiresAt = config.expiresInMs === null ? null : Date.now() + config.expiresInMs
      const payload = writePayload(record, marker, expiresAt)
      const current = await queryExact(ctx, options, "write", key)
      const visibleCurrent = current === null || expired(current) ? null : current
      if (config.ifAbsent === true) {
        if (visibleCurrent !== null) {
          throw newStoreConflictError(key, null, visibleCurrent.record.revision)
        }
        if (current !== null && !(await deleteRow(ctx, options, key, current))) {
          const actual = await queryExact(ctx, options, "write", key)
          if (actual !== null) throw newStoreConflictError(key, null, actual.record.revision)
        }
        const mode: MutationMode = Object.freeze({ kind: "cas", revision: "0" })
        const written = await writeMutation(ctx, options, key, payload, mode, null)
        if (written !== null) return written.record
        const actual = await queryExact(ctx, options, "write", key)
        throw newStoreConflictError(key, null, actual?.record.revision ?? null)
      }
      if (config.ifRevision !== null) {
        const actual = visibleCurrent?.record.revision ?? null
        if (actual !== config.ifRevision) {
          throw newStoreConflictError(key, config.ifRevision, actual)
        }
        if (visibleCurrent?.session !== null && visibleCurrent?.session !== undefined) {
          throw newConsulStoreUnsupportedCombinationError("cas-existing-ttl")
        }
      }
      if (config.ifRevision !== null) {
        const mode: MutationMode = Object.freeze({
          kind: "cas",
          revision: config.ifRevision
        })
        const written = await writeMutation(ctx, options, key, payload, mode, null)
        if (written !== null) return written.record
        const actual = await queryExact(ctx, options, "write", key)
        throw newStoreConflictError(key, config.ifRevision, actual?.record.revision ?? null)
      }
      if (config.expiresInMs !== null) {
        return await writeExpiring(ctx, options, key, payload, marker, config.expiresInMs, current)
      }
      return await writePersistent(ctx, options, key, payload, current)
    },
    /** Deletes one exact visible Consul record with optional ModifyIndex CAS. */
    async delete(
      ctx: Context,
      rawKey: string,
      ...reducers: readonly DeleteOption[] /* go-like-typed-rest: preserves Go-style Store options. */
    ): Promise<boolean> {
      checkContext(ctx)
      const config = deleteOptions(
        ...reducers /* go-like-typed-spread: forwards exact ordered Store options. */
      )
      const key = storeKey(rawKey, false)
      const current = await queryExact(ctx, options, "delete", key)
      if (current === null) {
        if (config.ifRevision !== null) {
          throw newStoreConflictError(key, config.ifRevision, null)
        }
        return false
      }
      if (expired(current)) {
        await deleteRow(ctx, options, key, current)
        if (config.ifRevision !== null) {
          throw newStoreConflictError(key, config.ifRevision, null)
        }
        return false
      }
      if (config.ifRevision !== null && config.ifRevision !== current.record.revision) {
        throw newStoreConflictError(key, config.ifRevision, current.record.revision)
      }
      const deleted = await deleteRow(ctx, options, key, current)
      if (deleted) return true
      const actual = await queryExact(ctx, options, "delete", key)
      if (config.ifRevision !== null) {
        throw newStoreConflictError(key, config.ifRevision, actual?.record.revision ?? null)
      }
      return false
    },
    /** Lists one code-point-sorted stable page from a recursive Consul KV query. */
    async list(
      ctx: Context,
      ...reducers: readonly ListOption[] /* go-like-typed-rest: preserves Go-style Store options. */
    ): Promise<StorePage> {
      checkContext(ctx)
      const config = listOptions(
        ...reducers /* go-like-typed-spread: forwards exact ordered Store options. */
      )
      const selectedPrefix = storeKey(config.prefix, true)
      if (config.limit !== null && config.limit > MaximumListLimit) {
        throw new RangeError(`Consul Store list limit exceeds ${MaximumListLimit}`)
      }
      const cursorScope = `${options.root.length}:${options.root}:${selectedPrefix}`
      const position = config.cursor === null ? null : decodeCursor(config.cursor, cursorScope)
      const result = await queryIndexedRows(ctx, options, selectedPrefix)
      if (position !== null && position.index !== result.index) {
        throw new TypeError("Consul Store cursor is stale")
      }
      const lastKey = position?.lastKey ?? null
      const records: StoreRecord[] = []
      for (const row of result.rows) {
        if (
          !row.record.key.startsWith(selectedPrefix) ||
          expired(row) ||
          (lastKey !== null && compareStoreKeys(row.record.key, lastKey) <= 0)
        ) {
          continue
        }
        records.push(row.record)
      }
      const sorted = snapshotStorePage({ records, cursor: null }).records
      if (config.limit === null || sorted.length <= config.limit) {
        return snapshotStorePage({ records: sorted, cursor: null })
      }
      const pageRecords = sorted.slice(0, config.limit)
      const final = pageRecords.at(-1)
      if (final === undefined) throw newConsulStoreProtocolError("list")
      return snapshotStorePage({
        records: pageRecords,
        cursor: encodeCursor(cursorScope, final.key, result.index)
      })
    },
    /** Returns the stable Consul Store provider diagnostic name. */
    string(): string {
      return "consul"
    }
  })
}

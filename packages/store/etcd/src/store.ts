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
  deleteOptions,
  listOptions,
  newStoreConflictError,
  snapshotStorePage,
  snapshotStoreRecord,
  snapshotStoreRecordInput,
  writeOptions
} from "@go-like/store/provider"

import {
  decodeCursor,
  encodeCursor,
  encodeRecordPayload,
  matches,
  maximumKeyBytes,
  maximumValueBytes,
  storeKey,
  type EtcdRow
} from "./codec"
import {
  boundaryError,
  isCompacted,
  isMissingLease,
  isUncertainFailure,
  newEtcdStoreCleanupError,
  newEtcdStoreCompactedError,
  newEtcdStoreLeaseLostError,
  newEtcdStoreProtocolError,
  newEtcdStoreUncertainError
} from "./errors"
import { captureOptions, type CapturedOptions } from "./options"
import {
  grantLease,
  rangeExact,
  rangePrefix,
  revokeLease,
  transactDelete,
  transactPut
} from "./protocol"
import type { EtcdStore, EtcdStoreOptions } from "./types"

const MinimumTtlMs = 1_000
const MaximumTtlMs = 2_147_483_647
const MaximumListLimit = 1_000
const PersistentLease = "0"

/** Returns one exact Context cancellation cause or null while active. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Rejects a canceled operation before provider validation or I/O. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Reports whether one decoded row is no longer visible at local TTL precision. */
function expired(row: EtcdRow): boolean {
  const expiresAt = row.record.expiresAt
  return expiresAt !== null && Date.now() >= expiresAt
}

/** Generates one unique wire marker for uncertain-response ownership readback. */
function operationId(): string {
  return crypto.randomUUID()
}

/** Reports whether two rows are the same physical etcd key generation. */
function sameGeneration(left: EtcdRow | null, right: EtcdRow | null): boolean {
  if (left === null || right === null) return left === right
  return (
    left.record.key === right.record.key &&
    left.record.revision === right.record.revision &&
    left.payload === right.payload &&
    left.lease === right.lease
  )
}

/** Returns the visible CAS revision while hiding locally expired rows. */
function visibleRevision(row: EtcdRow | null): string | null {
  return row === null || expired(row) ? null : row.record.revision
}

/** Releases one provider-owned lease and accepts etcd's missing-lease acknowledgement. */
async function releaseLease(ctx: Context, options: CapturedOptions, lease: string): Promise<void> {
  if (lease === PersistentLease) return
  try {
    await revokeLease(ctx, options, lease)
  } catch (value) {
    if (!isMissingLease(value)) throw value
  }
}

/** Rejects one uncommitted operation after cleaning its newly granted lease. */
async function rejectAfterLeaseCleanup(
  ctx: Context,
  options: CapturedOptions,
  lease: string,
  value: unknown
): Promise<never> {
  const primary = boundaryError(value, "etcd Store write failed")
  try {
    await releaseLease(ctx, options, lease)
  } catch (cleanup) {
    throw Object.freeze(
      new AggregateError(
        [primary, boundaryError(cleanup, "etcd Store lease cleanup failed")],
        "etcd Store write and lease cleanup failed"
      )
    )
  }
  throw primary
}

/** Releases one obsolete lease after a proven mutation commit. */
async function cleanupCommittedLease(
  ctx: Context,
  options: CapturedOptions,
  operation: "write" | "delete",
  lease: string,
  replacementLease: string = PersistentLease
): Promise<void> {
  if (lease === PersistentLease || lease === replacementLease) return
  try {
    await releaseLease(ctx, options, lease)
  } catch (value) {
    throw newEtcdStoreCleanupError(operation, value)
  }
}

/** Converts one admitted payload and revision into a defensive Store record. */
function writtenRecord(
  input: StoreRecordInput,
  revision: string,
  expiresAt: number | null
): StoreRecord {
  return snapshotStoreRecord({
    key: input.key,
    value: input.value,
    metadata: input.metadata ?? {},
    revision,
    expiresAt
  })
}

/** Performs one put attempt, using exact readback when its response is uncertain. */
async function putAttempt(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  payload: string,
  lease: string,
  current: EtcdRow | null
): Promise<{
  readonly committed: boolean
  readonly revision: string
  readonly current: EtcdRow | null
}> {
  try {
    const result = await transactPut(ctx, options, key, payload, lease, current)
    return Object.freeze({
      committed: result.succeeded,
      revision: result.revision,
      current: result.succeeded ? current : result.current
    })
  } catch (value) {
    if (lease !== PersistentLease && isMissingLease(value)) {
      throw newEtcdStoreLeaseLostError()
    }
    if (!isUncertainFailure(value)) throw value
    let row: EtcdRow | null
    try {
      row = (await rangeExact(ctx, options, "write-readback", key)).row
    } catch {
      throw newEtcdStoreUncertainError("write", value)
    }
    if (matches(row, payload, lease)) {
      if (row === null) throw newEtcdStoreProtocolError("write-readback")
      return Object.freeze({ committed: true, revision: row.record.revision, current })
    }
    if (lease !== PersistentLease) {
      try {
        await releaseLease(ctx, options, lease)
      } catch (cleanup) {
        throw newEtcdStoreUncertainError(
          "write",
          Object.freeze(
            new AggregateError(
              [
                boundaryError(value, "etcd Store write outcome was uncertain"),
                boundaryError(cleanup, "etcd Store lease cleanup failed")
              ],
              "etcd Store write outcome and lease cleanup were uncertain"
            )
          )
        )
      }
    }
    throw newEtcdStoreUncertainError("write", value)
  }
}

/** Performs one exact delete attempt with mutation-outcome readback. */
async function deleteAttempt(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  current: EtcdRow
): Promise<EtcdRow | null> {
  try {
    const result = await transactDelete(ctx, options, key, current)
    return result.succeeded ? null : result.current
  } catch (value) {
    if (!isUncertainFailure(value)) throw value
    let row: EtcdRow | null
    try {
      row = (await rangeExact(ctx, options, "delete-readback", key)).row
    } catch {
      throw newEtcdStoreUncertainError("delete", value)
    }
    if (row === null || sameGeneration(row, current)) return row
    throw newEtcdStoreUncertainError("delete", value)
  }
}

/** Creates one immediately usable etcd Store over a borrowed standard Fetch snapshot. */
export function createEtcdStore(construction: EtcdStoreOptions): EtcdStore {
  const options = captureOptions(construction)

  return Object.freeze({
    /** Reads one exact visible etcd record. */
    async read(ctx: Context, rawKey: string): Promise<StoreRecord | null> {
      checkContext(ctx)
      const key = storeKey(rawKey, false)
      const row = (await rangeExact(ctx, options, "read", key)).row
      return row === null || expired(row) ? null : row.record
    },
    /** Atomically creates or replaces one persistent or lease-backed record. */
    async write(
      ctx: Context,
      rawRecord: StoreRecordInput,
      ...reducers: readonly WriteOption[] /* go-like-typed-rest: preserves Go-style Store options. */
    ): Promise<StoreRecord> {
      const config = writeOptions(
        ...reducers /* go-like-typed-spread: forwards exact ordered Store options. */
      )
      if (
        config.expiresInMs !== null &&
        (config.expiresInMs < MinimumTtlMs || config.expiresInMs > MaximumTtlMs)
      ) {
        throw new RangeError(
          `etcd Store ttl must be between ${MinimumTtlMs} and ${MaximumTtlMs} milliseconds`
        )
      }
      const input = snapshotStoreRecordInput(rawRecord)
      const key = storeKey(input.key, false)
      checkContext(ctx)
      let current = (await rangeExact(ctx, options, "write", key)).row
      if (config.ifAbsent === true && visibleRevision(current) !== null) {
        throw newStoreConflictError(key, null, visibleRevision(current))
      }
      if (config.ifRevision !== null && config.ifRevision !== visibleRevision(current)) {
        throw newStoreConflictError(key, config.ifRevision, visibleRevision(current))
      }
      let expiresAt: number | null = null
      if (config.expiresInMs !== null) expiresAt = Date.now() + config.expiresInMs
      const payload = encodeRecordPayload(input, operationId(), expiresAt)
      let lease = PersistentLease
      if (config.expiresInMs !== null) {
        lease = await grantLease(ctx, options, Math.ceil(config.expiresInMs / 1_000))
      }
      for (;;) {
        let attempt: {
          readonly committed: boolean
          readonly revision: string
          readonly current: EtcdRow | null
        }
        try {
          attempt = await putAttempt(ctx, options, key, payload, lease, current)
        } catch (value) {
          if (
            lease !== PersistentLease &&
            !isUncertainFailure(value) &&
            !(
              typeof value === "object" &&
              value !== null &&
              "code" in value &&
              (value.code === "GO_LIKE_ETCD_STORE_UNCERTAIN" ||
                value.code === "GO_LIKE_ETCD_STORE_LEASE_LOST")
            )
          ) {
            return await rejectAfterLeaseCleanup(ctx, options, lease, value)
          }
          throw value
        }
        if (attempt.committed) {
          await cleanupCommittedLease(
            ctx,
            options,
            "write",
            attempt.current?.lease ?? PersistentLease,
            lease
          )
          return writtenRecord(input, attempt.revision, expiresAt)
        }
        if (config.ifAbsent === true || config.ifRevision !== null) {
          const conflict = newStoreConflictError(
            key,
            config.ifAbsent === true ? null : config.ifRevision,
            visibleRevision(attempt.current)
          )
          return await rejectAfterLeaseCleanup(ctx, options, lease, conflict)
        }
        current = attempt.current
      }
    },
    /** Deletes one exact key through a MOD-revision transaction. */
    async delete(
      ctx: Context,
      rawKey: string,
      ...reducers: readonly DeleteOption[] /* go-like-typed-rest: preserves Go-style Store options. */
    ): Promise<boolean> {
      const config = deleteOptions(
        ...reducers /* go-like-typed-spread: forwards exact ordered Store options. */
      )
      const key = storeKey(rawKey, false)
      checkContext(ctx)
      let current = (await rangeExact(ctx, options, "delete", key)).row
      if (current === null) {
        if (config.ifRevision !== null) {
          throw newStoreConflictError(key, config.ifRevision, null)
        }
        return false
      }
      const initiallyVisible = !expired(current)
      if (
        config.ifRevision !== null &&
        config.ifRevision !== visibleRevision(current) &&
        initiallyVisible
      ) {
        throw newStoreConflictError(key, config.ifRevision, current.record.revision)
      }
      for (;;) {
        const previous = current
        const observed = await deleteAttempt(ctx, options, key, previous)
        if (observed === null) {
          await cleanupCommittedLease(ctx, options, "delete", previous.lease)
          if (config.ifRevision !== null && !initiallyVisible) {
            throw newStoreConflictError(key, config.ifRevision, null)
          }
          return initiallyVisible
        }
        if (sameGeneration(observed, previous)) continue
        if (config.ifRevision !== null) {
          throw newStoreConflictError(key, config.ifRevision, visibleRevision(observed))
        }
        if (!initiallyVisible) return false
        current = observed
      }
    },
    /** Lists one stable code-point-sorted prefix page at a cursor-bound revision. */
    async list(
      ctx: Context,
      ...reducers: readonly ListOption[] /* go-like-typed-rest: preserves Go-style Store options. */
    ): Promise<StorePage> {
      const config = listOptions(
        ...reducers /* go-like-typed-spread: forwards exact ordered Store options. */
      )
      const selectedPrefix = storeKey(config.prefix, true)
      if (config.limit !== null && config.limit > MaximumListLimit) {
        throw new RangeError(`etcd Store list limit exceeds ${MaximumListLimit}`)
      }
      const continuation =
        config.cursor === null ? null : decodeCursor(config.cursor, selectedPrefix)
      checkContext(ctx)
      let page
      try {
        page = await rangePrefix(
          ctx,
          options,
          selectedPrefix,
          continuation?.lastKey ?? null,
          continuation?.revision ?? null,
          config.limit
        )
      } catch (value) {
        if (continuation !== null && isCompacted(value)) {
          throw newEtcdStoreCompactedError(continuation.revision)
        }
        throw value
      }
      const revision = continuation?.revision ?? page.revision
      const records: StoreRecord[] = []
      for (const row of page.rows) {
        if (!expired(row)) records.push(row.record)
      }
      let next: string | null = null
      if (page.more) {
        const final = page.rows.at(-1)
        if (final === undefined || revision === "0") {
          throw newEtcdStoreProtocolError("list")
        }
        next = encodeCursor(selectedPrefix, final.record.key, revision)
      }
      return snapshotStorePage({ records, cursor: next })
    },
    /** Returns the stable etcd Store provider name. */
    string(): string {
      return "etcd"
    }
  })
}

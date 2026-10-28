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
  snapshotStorePage,
  snapshotStoreRecordInput,
  writeOptions
} from "@go-like/store/provider"

import { physicalKey } from "./codec"
import { newSnapshotError } from "./errors"
import { deleteVault, listVault, readVault, writeVault } from "./http"
import { captureOptions } from "./options"
import type { VaultStore, VaultStoreOptions } from "./types"

interface PageSnapshot {
  readonly records: readonly StoreRecord[]
  readonly offset: number
  readonly prefix: string
  readonly expiresAt: number
}

const MaximumSnapshots = 64
const MaximumListLimit = 1_000
/** Returns one exact terminal Context cause while preserving identity. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Rejects a canceled operation before provider validation or I/O. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Narrows one write functional option without a type assertion. */
function isWriteOption(value: unknown): value is WriteOption {
  return typeof value === "function"
}

/** Narrows one delete functional option without a type assertion. */
function isDeleteOption(value: unknown): value is DeleteOption {
  return typeof value === "function"
}

/** Narrows one list functional option without a type assertion. */
function isListOption(value: unknown): value is ListOption {
  return typeof value === "function"
}

/** Collects and validates write reducers without rest or spread syntax. */
function writeReducers(args: IArguments): WriteOption[] {
  const values: WriteOption[] = []
  for (let index = 2; index < args.length; index += 1) {
    const value: unknown = args[index]
    if (!isWriteOption(value)) throw new TypeError("Store write option must be a function")
    values.push(value)
  }
  return values
}

/** Collects and validates delete reducers without rest or spread syntax. */
function deleteReducers(args: IArguments): DeleteOption[] {
  const values: DeleteOption[] = []
  for (let index = 2; index < args.length; index += 1) {
    const value: unknown = args[index]
    if (!isDeleteOption(value)) throw new TypeError("Store delete option must be a function")
    values.push(value)
  }
  return values
}

/** Collects and validates list reducers without rest or spread syntax. */
function listReducers(args: IArguments): ListOption[] {
  const values: ListOption[] = []
  for (let index = 1; index < args.length; index += 1) {
    const value: unknown = args[index]
    if (!isListOption(value)) throw new TypeError("Store list option must be a function")
    values.push(value)
  }
  return values
}

/** Creates one immediately usable Vault KV v2 Store. */
export function createStore(construction: VaultStoreOptions): VaultStore {
  const options = captureOptions(construction)
  const snapshots = new Map<string, PageSnapshot>()

  /** Removes every expired process-local pagination snapshot. */
  function cleanExpiredSnapshots(now: number): void {
    for (const entry of snapshots) {
      if (entry[1].expiresAt <= now) snapshots.delete(entry[0])
    }
  }

  /** Stores one continuation and returns its opaque one-shot token. */
  function storeCursor(snapshot: PageSnapshot): string {
    cleanExpiredSnapshots(Date.now())
    if (snapshots.size >= MaximumSnapshots) throw newSnapshotError("capacity")
    const token = crypto.randomUUID()
    snapshots.set(token, snapshot)
    return token
  }

  /** Returns one page from an already materialized process-local snapshot without Vault I/O. */
  function continuePage(prefix: string, count: number | null, token: string): StorePage {
    const snapshot = snapshots.get(token)
    if (snapshot === undefined) throw newSnapshotError("invalid-cursor")
    snapshots.delete(token)
    if (snapshot.expiresAt <= Date.now()) throw newSnapshotError("expired-cursor")
    if (snapshot.prefix !== prefix) throw newSnapshotError("invalid-cursor")
    const end = count === null ? snapshot.records.length : snapshot.offset + count
    const records = snapshot.records.slice(snapshot.offset, end)
    const nextOffset = snapshot.offset + records.length
    const next =
      nextOffset >= snapshot.records.length
        ? null
        : storeCursor(
            Object.freeze({
              records: snapshot.records,
              offset: nextOffset,
              prefix: snapshot.prefix,
              expiresAt: snapshot.expiresAt
            })
          )
    return snapshotStorePage({ records, cursor: next })
  }

  /** Reads one exact logical record. */
  async function read(ctx: Context, key: string): Promise<StoreRecord | null> {
    checkContext(ctx)
    physicalKey(key)
    return (await readVault(ctx, options, key, "read"))?.record ?? null
  }

  /** Writes one unconditional Vault KV v2 version and returns its admitted revision. */
  async function write(ctx: Context, rawRecord: StoreRecordInput): Promise<StoreRecord> {
    checkContext(ctx)
    const config = writeOptions.apply(undefined, writeReducers(arguments))
    if (config.expiresInMs !== null) throw new TypeError("Vault Store does not support TTL")
    if (config.ifAbsent === true || config.ifRevision !== null) {
      throw new TypeError("Vault Store does not support CAS")
    }
    const record = snapshotStoreRecordInput(rawRecord)
    physicalKey(record.key)
    return (await writeVault(ctx, options, record)).record
  }

  /** Soft-deletes only the exact Vault version observed before this call. */
  async function remove(ctx: Context, key: string): Promise<boolean> {
    checkContext(ctx)
    const config = deleteOptions.apply(undefined, deleteReducers(arguments))
    if (config.ifRevision !== null) throw new TypeError("Vault Store does not support CAS")
    physicalKey(key)
    const current = await readVault(ctx, options, key, "delete")
    if (current === null) return false
    await deleteVault(ctx, options, key, Number(current.record.revision))
    return true
  }

  /** Materializes or continues one process-local immutable page snapshot. */
  async function list(ctx: Context): Promise<StorePage> {
    checkContext(ctx)
    const config = listOptions.apply(undefined, listReducers(arguments))
    if (config.prefix !== "") physicalKey(config.prefix)
    if (config.limit !== null && config.limit > MaximumListLimit) {
      throw new RangeError(`Vault Store list limit exceeds ${MaximumListLimit}`)
    }
    if (config.cursor !== null) return continuePage(config.prefix, config.limit, config.cursor)
    const keys = await listVault(ctx, options)
    const records: StoreRecord[] = []
    for (const key of keys) {
      if (!key.startsWith(config.prefix)) continue
      const row = await readVault(ctx, options, key, "list")
      if (row !== null) records.push(row.record)
    }
    const stable = snapshotStorePage({ records, cursor: null }).records
    if (config.limit === null || stable.length <= config.limit) {
      return snapshotStorePage({ records: stable, cursor: null })
    }
    const expiresAt = Date.now() + options.cursorTtlMs
    const cursor = storeCursor(
      Object.freeze({ records: stable, offset: config.limit, prefix: config.prefix, expiresAt })
    )
    return snapshotStorePage({ records: stable.slice(0, config.limit), cursor })
  }

  return Object.freeze({
    read,
    write,
    delete: remove,
    list,
    /** Returns the stable provider diagnostic name. */
    string(): string {
      return "vault"
    }
  })
}

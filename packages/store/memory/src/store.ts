import { cause, type Context } from "@likego/context"
import type { DeleteOption, ListOption, Store, StoreRecord, WriteOption } from "@likego/store"
import {
  compareStoreKeys,
  deleteOptions,
  listOptions,
  newStoreConflictError,
  snapshotStorePage,
  snapshotStoreRecord,
  snapshotStoreRecordInput,
  writeOptions
} from "@likego/store/provider"

/** Returns one millisecond timestamp for deterministic expiry decisions. */
export type MemoryStoreClock = () => number

/** Captures immutable Memory Store construction options. */
export interface MemoryStoreOptions {
  readonly clock: MemoryStoreClock
}

/** Reduces one immutable Memory Store option snapshot to its next candidate. */
export type MemoryStoreOption = (options: MemoryStoreOptions) => MemoryStoreOptions

/** Implements the provider-neutral Store SPI with isolated process-local state. */
export interface MemoryStore extends Store {
  /** Returns the stable provider diagnostic name. */
  string(): "memory"
}

interface DecodedCursor {
  readonly revision: number
  readonly prefix: string
  readonly offset: number
}

const CursorVersion = 1
const MaximumRevision = Number.MAX_SAFE_INTEGER
const MaximumTTLMilliseconds = 2_147_483_647
const EmptyValue = new Uint8Array()

/** Reads the standard runtime wall clock. */
function standardNow(): number {
  return Date.now()
}

const DefaultOptions: MemoryStoreOptions = Object.freeze({ clock: standardNow })

/** Validates one clock without invoking application code. */
function requireClock(value: MemoryStoreClock): MemoryStoreClock {
  if (typeof value !== "function") throw new TypeError("Memory Store clock must be a function")
  return value
}

/** Validates and freezes one Memory Store option candidate. */
function snapshotOptions(value: MemoryStoreOptions): MemoryStoreOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Memory Store options must be an object")
  }
  return Object.freeze({ clock: requireClock(value.clock) })
}

/** Selects one deterministic millisecond clock for this Memory Store instance. */
export function clock(value: MemoryStoreClock): MemoryStoreOption {
  const captured = requireClock(value)
  /** Applies the captured clock to one immutable option snapshot. */
  function apply(_options: MemoryStoreOptions): MemoryStoreOptions {
    return Object.freeze({ clock: captured })
  }
  return apply
}

/** Resolves ordered construction options from the standard wall clock. */
function memoryStoreOptions(options: readonly MemoryStoreOption[]): MemoryStoreOptions {
  let candidate = DefaultOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Memory Store option must be a function")
    candidate = snapshotOptions(option(candidate))
  }
  return candidate
}

/** Returns the exact cancellation carried by one terminal Context. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Rejects an operation admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Validates one exact Store key through the provider-neutral snapshot contract. */
function storeKey(value: string): string {
  return snapshotStoreRecordInput({ key: value, value: EmptyValue }).key
}

/** Reads one exact non-negative safe integer millisecond timestamp. */
function timestamp(selectedClock: MemoryStoreClock): number {
  const value = selectedClock()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Memory Store clock must return a non-negative safe integer")
  }
  return value
}

/** Resolves one optional expiry timestamp inside the declared provider bounds. */
function expiry(now: number, durationMs: number | null): number | null {
  if (durationMs === null) return null
  if (durationMs > MaximumTTLMilliseconds) {
    throw new RangeError("Memory Store ttl is outside provider bounds")
  }
  const expiresAt = now + durationMs
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError("Memory Store expiry exceeds safe timestamp bounds")
  }
  return expiresAt
}

/** Encodes one revision-bound and prefix-bound opaque cursor. */
function encodeCursor(revision: number, prefix: string, offset: number): string {
  return JSON.stringify([CursorVersion, revision, prefix, offset])
}

/** Decodes one cursor without retaining any record snapshot. */
function decodeCursor(value: string): DecodedCursor {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 4) throw new TypeError("invalid cursor")
    const version: unknown = parsed[0]
    const revision: unknown = parsed[1]
    const prefix: unknown = parsed[2]
    const offset: unknown = parsed[3]
    if (
      version !== CursorVersion ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof prefix !== "string" ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new TypeError("invalid cursor")
    }
    return Object.freeze({ revision, prefix, offset })
  } catch {
    throw new TypeError("Memory Store cursor is invalid or stale")
  }
}

/** Validates one test-seeded mutation generation. */
function initialRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MaximumRevision) {
    throw new RangeError("Memory Store initial revision is invalid")
  }
  return value
}

/** Creates one process-local Store at an internal revision used by boundary tests. */
export function newMemoryStoreAtRevision(
  seededRevision: number,
  options: readonly MemoryStoreOption[] = []
): MemoryStore {
  const selected = memoryStoreOptions(options)
  const records = new Map<string, StoreRecord>()
  let revision = initialRevision(seededRevision)

  /** Returns the next mutation generation before any state changes. */
  function nextRevision(): number {
    if (revision >= MaximumRevision) throw new RangeError("Memory Store revision is exhausted")
    return revision + 1
  }

  // ponytail: full-map lazy expiry is O(n) per call; add an expiry index only when measured.
  /** Collects all records expired at one admitted operation timestamp. */
  function expiredKeys(now: number): string[] {
    const keys: string[] = []
    for (const [key, record] of records) {
      if (record.expiresAt !== null && record.expiresAt <= now) keys.push(key)
    }
    return keys
  }

  /** Reports whether a stored key is expired in the current operation snapshot. */
  function isExpired(key: string, expired: readonly string[]): boolean {
    return expired.includes(key)
  }

  /** Commits lazy expiry as one revision after revision capacity is admitted. */
  function purgeExpired(expired: readonly string[]): void {
    if (expired.length === 0) return
    const candidateRevision = nextRevision()
    for (const key of expired) records.delete(key)
    revision = candidateRevision
  }

  const store: MemoryStore = {
    async read(ctx: Context, key: string): Promise<StoreRecord | null> {
      checkContext(ctx)
      const selectedKey = storeKey(key)
      const expired = expiredKeys(timestamp(selected.clock))
      purgeExpired(expired)
      const record = records.get(selectedKey)
      return record === undefined ? null : snapshotStoreRecord(record)
    },
    async write(
      ctx: Context,
      value,
      ...options: readonly WriteOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
    ): Promise<StoreRecord> {
      checkContext(ctx)
      const input = snapshotStoreRecordInput(value)
      const resolved = writeOptions(...options)
      const now = timestamp(selected.clock)
      const expiresAt = expiry(now, resolved.expiresInMs)
      const expired = expiredKeys(now)
      const current = isExpired(input.key, expired) ? undefined : records.get(input.key)
      if (resolved.ifAbsent === true && current !== undefined) {
        throw newStoreConflictError(input.key, null, current.revision)
      }
      if (resolved.ifRevision !== null && current?.revision !== resolved.ifRevision) {
        throw newStoreConflictError(input.key, resolved.ifRevision, current?.revision ?? null)
      }
      const candidateRevision = nextRevision()
      const record = snapshotStoreRecord({
        key: input.key,
        value: input.value,
        metadata: input.metadata ?? {},
        revision: String(candidateRevision),
        expiresAt
      })
      for (const key of expired) records.delete(key)
      records.set(input.key, record)
      revision = candidateRevision
      return snapshotStoreRecord(record)
    },
    async delete(
      ctx: Context,
      key: string,
      ...options: readonly DeleteOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
    ): Promise<boolean> {
      checkContext(ctx)
      const selectedKey = storeKey(key)
      const resolved = deleteOptions(...options)
      const expired = expiredKeys(timestamp(selected.clock))
      const current = isExpired(selectedKey, expired) ? undefined : records.get(selectedKey)
      if (resolved.ifRevision !== null && current?.revision !== resolved.ifRevision) {
        throw newStoreConflictError(selectedKey, resolved.ifRevision, current?.revision ?? null)
      }
      if (current === undefined) {
        purgeExpired(expired)
        return false
      }
      const candidateRevision = nextRevision()
      for (const expiredKey of expired) records.delete(expiredKey)
      records.delete(selectedKey)
      revision = candidateRevision
      return true
    },
    async list(
      ctx: Context,
      ...options: readonly ListOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
    ) {
      checkContext(ctx)
      const resolved = listOptions(...options)
      const decoded = resolved.cursor === null ? null : decodeCursor(resolved.cursor)
      const expired = expiredKeys(timestamp(selected.clock))
      purgeExpired(expired)
      if (
        decoded !== null &&
        (decoded.revision !== revision || decoded.prefix !== resolved.prefix)
      ) {
        throw new TypeError("Memory Store cursor is invalid or stale")
      }
      const matching = Array.from(records.values())
        .filter(function hasPrefix(record): boolean {
          return record.key.startsWith(resolved.prefix)
        })
        .sort(function compareRecords(left, right): number {
          return compareStoreKeys(left.key, right.key)
        })
      const offset = decoded?.offset ?? 0
      if (offset > matching.length) throw new TypeError("Memory Store cursor is invalid or stale")
      const count =
        resolved.limit === null
          ? matching.length - offset
          : Math.min(resolved.limit, matching.length - offset)
      const pageRecords = matching.slice(offset, offset + count)
      const nextOffset = offset + pageRecords.length
      return snapshotStorePage({
        records: pageRecords,
        cursor:
          nextOffset < matching.length ? encodeCursor(revision, resolved.prefix, nextOffset) : null
      })
    },
    string(): "memory" {
      return "memory"
    }
  }
  return Object.freeze(store)
}

/** Creates one immediately usable process-local Store without resident resources. */
export function newMemoryStore(
  ...options: readonly MemoryStoreOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): MemoryStore {
  return newMemoryStoreAtRevision(0, options)
}

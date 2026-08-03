import { cause, type Context } from "@likego/context"
import type { Store, StoreRecord } from "../src/index"

import {
  compareStoreKeys,
  deleteOptions,
  listOptions,
  newStoreConflictError,
  snapshotStorePage,
  snapshotStoreRecord,
  snapshotStoreRecordInput,
  writeOptions
} from "../src/provider"
import type { StoreConformanceLimits } from "../src/testing"

interface Backend {
  readonly records: Map<string, StoreRecord>
  revision: number
}

/** Creates one isolated mutable backend used only by Store contract tests. */
export function memoryBackend(): Backend {
  return { records: new Map(), revision: 0 }
}

/** Returns test-only limits for one in-memory conformance provider. */
export function memoryLimits(cas = true, ttl = true, sharedWriters = true): StoreConformanceLimits {
  return Object.freeze({
    ttl: ttl ? { minimumMs: 10, maximumMs: 1_000 } : null,
    cas,
    sharedWriters
  })
}

/** Creates one fully structural in-memory Store used only to execute internal conformance. */
export function memoryStore(backend = memoryBackend(), limits = memoryLimits()): Store {
  /** Rejects a canceled operation before mutating backend state. */
  function admit(ctx: Context): void {
    const contextError = ctx.err()
    if (contextError !== null) throw cause(ctx) ?? contextError
  }

  /** Removes one expired record before exposing backend state. */
  function purge(key: string): StoreRecord | null {
    const record = backend.records.get(key) ?? null
    if (record !== null && record.expiresAt !== null && record.expiresAt <= Date.now()) {
      backend.records.delete(key)
      return null
    }
    return record
  }

  const store: Store = {
    async read(ctx, key) {
      admit(ctx)
      const current = purge(key)
      return current === null ? null : snapshotStoreRecord(current)
    },
    async write(ctx, value, ...options) {
      admit(ctx)
      const input = snapshotStoreRecordInput(value)
      const selected = writeOptions(...options)
      if (selected.expiresInMs !== null) {
        if (limits.ttl === null) throw new TypeError("Memory Store does not support TTL")
        if (
          selected.expiresInMs < limits.ttl.minimumMs ||
          selected.expiresInMs > limits.ttl.maximumMs
        ) {
          throw new RangeError("Store ttl is outside provider bounds")
        }
      }
      if (selected.ifRevision !== null && !limits.cas) {
        throw new TypeError("Memory Store does not support CAS")
      }
      if (selected.ifAbsent === true && !limits.cas) {
        throw new TypeError("Memory Store does not support CAS")
      }
      const current = purge(input.key)
      if (selected.ifAbsent === true && current !== null) {
        throw newStoreConflictError(input.key, null, current.revision)
      }
      if (selected.ifRevision !== null && current?.revision !== selected.ifRevision) {
        throw newStoreConflictError(input.key, selected.ifRevision, current?.revision ?? null)
      }
      backend.revision += 1
      const record = snapshotStoreRecord({
        key: input.key,
        value: input.value,
        metadata: input.metadata ?? {},
        revision: String(backend.revision),
        expiresAt: selected.expiresInMs === null ? null : Date.now() + selected.expiresInMs
      })
      backend.records.set(record.key, record)
      return snapshotStoreRecord(record)
    },
    async delete(ctx, key, ...options) {
      admit(ctx)
      const selected = deleteOptions(...options)
      if (selected.ifRevision !== null && !limits.cas) {
        throw new TypeError("Memory Store does not support CAS")
      }
      const current = purge(key)
      if (selected.ifRevision !== null && current?.revision !== selected.ifRevision) {
        throw newStoreConflictError(key, selected.ifRevision, current?.revision ?? null)
      }
      if (current === null) return false
      backend.records.delete(key)
      return true
    },
    async list(ctx, ...options) {
      admit(ctx)
      const selected = listOptions(...options)
      if (selected.limit !== null && selected.limit > 100) {
        throw new RangeError("Memory Store list limit exceeds 100")
      }
      const records: StoreRecord[] = []
      for (const key of backend.records.keys()) {
        const record = purge(key)
        if (record !== null && record.key.startsWith(selected.prefix)) records.push(record)
      }
      records.sort((left, right) => compareStoreKeys(left.key, right.key))
      const offset = selected.cursor === null ? 0 : Number(selected.cursor)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > records.length) {
        throw new TypeError("Store cursor is invalid")
      }
      const count = selected.limit ?? 100
      const selectedRecords = records.slice(offset, offset + count)
      const next = offset + selectedRecords.length
      return snapshotStorePage({
        records: selectedRecords,
        cursor: next < records.length ? String(next) : null
      })
    },
    string() {
      return "memory"
    }
  }
  return Object.freeze(store)
}

/// <reference lib="es2024.promise" />

import { background, cause, type Context } from "@go-like/context"
import type { StoreRecord } from "@go-like/store"
import {
  compareStoreKeys,
  deleteOptions,
  listOptions,
  newStoreConflictError,
  snapshotStorePage,
  snapshotStoreRecord,
  snapshotStoreRecordInput,
  writeOptions
} from "@go-like/store/provider"
import { waitForContext } from "@go-like/core/lifecycle"

import type {
  FileStore,
  FileStoreCorruptionError,
  FileStoreCorruptionReason,
  FileStoreDirectory,
  FileStoreHost,
  FileStoreLockedError,
  FileStoreState,
  FileStoreStateError
} from "./types"

interface CapturedHost {
  readonly receiver: FileStoreHost
  readonly acquire: FileStoreHost["acquire"]
}

interface CapturedDirectory {
  readonly receiver: FileStoreDirectory
  readonly close: FileStoreDirectory["close"]
  readonly read: FileStoreDirectory["read"]
  readonly write: FileStoreDirectory["write"]
  readonly rename: FileStoreDirectory["rename"]
  readonly remove: FileStoreDirectory["remove"]
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

interface PersistedRecordCandidate {
  readonly key?: unknown
  readonly value?: unknown
  readonly metadata?: unknown
  readonly revision?: unknown
  readonly expiresAt?: unknown
}

interface PersistedSnapshotCandidate {
  readonly schemaVersion?: unknown
  readonly revision?: unknown
  readonly records?: unknown
  readonly checksum?: unknown
}

interface LoadedSnapshot {
  readonly records: Map<string, StoreRecord>
  readonly revision: number
}

interface CursorCandidate {
  readonly version?: unknown
  readonly revision?: unknown
  readonly prefix?: unknown
  readonly offset?: unknown
}

const SnapshotName = ".go-like-store.snapshot"
const TempName = ".go-like-store.tmp"
const SnapshotSchemaVersion = 1
const CursorVersion = 1
const Base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const MaximumRevision = Number.MAX_SAFE_INTEGER
const MinimumTTLMilliseconds = 1
const MaximumTTLMilliseconds = 2_147_483_647
const MaximumKeyBytes = 4_096
const MaximumValueBytes = 16_777_216
const MaximumListLimit = 1_000
const Encoder = new TextEncoder()
const Decoder = new TextDecoder("utf-8", { fatal: true })

/** Creates one externally controlled Promise pair. */
function deferred<T>(): Deferred<T> {
  return Object.freeze(Promise.withResolvers<T>())
}

/** Marks one public terminal barrier as observed without replacing its identity. */
function observe(operation: Promise<unknown>): void {
  void operation.catch(
    /** Retains terminal rejection for its owner without creating an unhandled rejection. */
    function observed(): void {}
  )
}

/** Reports whether a value is a non-array object suitable for structural inspection. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reports whether a string contains no unmatched UTF-16 surrogate code units. */
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

/** Validates one exact well-formed string without disclosing it in failures. */
function exactString(value: unknown, nonEmpty: boolean): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || !isWellFormed(value)) {
    throw new TypeError("File Store string is invalid")
  }
  return value
}

/** Throws one Context's exact admitted cancellation cause. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw cause(ctx) ?? failure
}

/** Normalizes one untrusted host rejection without stringifying it. */
function normalizeError(value: unknown, message: string): Error {
  return value instanceof Error ? value : Object.freeze(new Error(message, { cause: value }))
}

/** Returns one primary error or an immutable ordered aggregate with cleanup failures. */
function combinedFailure(
  primary: Error | null,
  cleanup: readonly Error[],
  message: string
): Error | null {
  const failures: Error[] = []
  if (primary !== null) failures.push(primary)
  for (const failure of cleanup) {
    if (!failures.includes(failure)) failures.push(failure)
  }
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  return Object.freeze(new AggregateError(Object.freeze(failures), message))
}

/** Captures a stable structural filesystem host without performing I/O. */
function captureHost(value: FileStoreHost): CapturedHost {
  if (!isRecord(value) || typeof value.acquire !== "function") {
    throw new TypeError("File Store host must implement acquire")
  }
  return Object.freeze({ receiver: value, acquire: value.acquire })
}

/** Captures one exclusively admitted directory resource. */
function captureDirectory(value: FileStoreDirectory): CapturedDirectory {
  if (
    !isRecord(value) ||
    typeof value.close !== "function" ||
    typeof value.read !== "function" ||
    typeof value.write !== "function" ||
    typeof value.rename !== "function" ||
    typeof value.remove !== "function"
  ) {
    throw new TypeError("File Store host returned an invalid directory handle")
  }
  return Object.freeze({
    receiver: value,
    close: value.close,
    read: value.read,
    write: value.write,
    rename: value.rename,
    remove: value.remove
  })
}

/** Creates one immutable secret-safe snapshot corruption error. */
export function newFileStoreCorruptionError(
  reason: FileStoreCorruptionReason
): FileStoreCorruptionError {
  if (
    reason !== "encoding" &&
    reason !== "json" &&
    reason !== "schema" &&
    reason !== "checksum" &&
    reason !== "record"
  ) {
    throw new TypeError("File Store corruption reason is invalid")
  }
  const error = new Error(`File Store snapshot failed ${reason} validation`)
  const details: Pick<FileStoreCorruptionError, "name" | "code" | "reason"> = {
    name: "FileStoreCorruptionError",
    code: "GO_LIKE_FILE_STORE_CORRUPTION",
    reason
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates one immutable secret-safe directory ownership conflict. */
export function newFileStoreLockedError(): FileStoreLockedError {
  const error = new Error("File Store directory is already owned")
  const details: Pick<FileStoreLockedError, "name" | "code"> = {
    name: "FileStoreLockedError",
    code: "GO_LIKE_FILE_STORE_LOCKED"
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates one immutable File Store lock-lifecycle admission error. */
export function newFileStoreStateError(
  operation: string,
  state: FileStoreState
): FileStoreStateError {
  const selectedOperation = exactString(operation, true)
  if (
    state !== "idle" &&
    state !== "starting" &&
    state !== "running" &&
    state !== "stopping" &&
    state !== "stopped" &&
    state !== "failed"
  ) {
    throw new TypeError("File Store state is invalid")
  }
  const error = new Error(`${selectedOperation} is invalid while File Store state is ${state}`)
  const details: Pick<FileStoreStateError, "name" | "code" | "operation" | "state"> = {
    name: "FileStoreStateError",
    code: "GO_LIKE_FILE_STORE_STATE",
    operation: selectedOperation,
    state
  }
  return Object.freeze(Object.assign(error, details))
}

/** Returns one exact base64 alphabet symbol for a validated six-bit value. */
function base64Symbol(index: number): string {
  const symbol = Base64Alphabet[index]
  if (symbol === undefined) throw new RangeError("base64 symbol is invalid")
  return symbol
}

/** Encodes bytes using canonical padded RFC 4648 base64. */
function encodeBase64(bytes: Uint8Array): string {
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

/** Decodes bounded canonical padded RFC 4648 base64 or rejects ambiguous input. */
function decodeBase64(value: unknown, maximumBytes: number = Number.MAX_SAFE_INTEGER): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new TypeError("invalid base64")
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const length = value.length === 0 ? 0 : (value.length / 4) * 3 - padding
  if (length > maximumBytes) throw new RangeError("decoded base64 exceeds provider bounds")
  const contentLength = value.length - padding
  for (let index = 0; index < contentLength; index += 1) {
    if (Base64Alphabet.indexOf(value[index] ?? "") < 0) throw new TypeError("invalid base64")
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
  if (encodeBase64(bytes) !== value) throw new TypeError("non-canonical base64")
  return bytes
}

/** Returns a lowercase SHA-256 checksum for one exact UTF-8 payload. */
async function checksum(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Encoder.encode(value)))
  let output = ""
  for (const byte of digest) output += byte.toString(16).padStart(2, "0")
  return output
}

/** Returns exact sorted enumerable keys for one ordinary JSON carrier. */
function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  if (keys.length !== expected.length) return false
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== expected[index]) return false
  }
  return true
}

/** Reports whether one JSON object contains only well-formed string metadata. */
function isMetadata(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false
  for (const key of Object.keys(value)) {
    const entry = value[key]
    if (!isWellFormed(key) || typeof entry !== "string" || !isWellFormed(entry)) {
      return false
    }
  }
  return true
}

/** Converts one untrusted persisted record after checksum admission. */
function decodeRecord(value: unknown, maximumRevision: number): StoreRecord {
  if (!isRecord(value) || !hasKeys(value, ["expiresAt", "key", "metadata", "revision", "value"])) {
    throw newFileStoreCorruptionError("record")
  }
  const candidate: PersistedRecordCandidate = value
  try {
    const key = exactString(candidate.key, true)
    const revision = exactString(candidate.revision, true)
    if (!/^(?:0|[1-9][0-9]*)$/.test(revision)) throw new TypeError("invalid revision")
    const numericRevision = Number(revision)
    if (
      !Number.isSafeInteger(numericRevision) ||
      numericRevision < 1 ||
      numericRevision > maximumRevision
    ) {
      throw new RangeError("invalid revision")
    }
    if (Encoder.encode(key).byteLength > MaximumKeyBytes) {
      throw new RangeError("invalid key")
    }
    if (!isMetadata(candidate.metadata)) throw new TypeError("invalid metadata")
    if (
      candidate.expiresAt !== null &&
      (typeof candidate.expiresAt !== "number" ||
        !Number.isSafeInteger(candidate.expiresAt) ||
        candidate.expiresAt < 0)
    ) {
      throw new RangeError("invalid expiry")
    }
    const bytes = decodeBase64(candidate.value, MaximumValueBytes)
    return snapshotStoreRecord({
      key,
      value: bytes,
      metadata: candidate.metadata,
      revision,
      expiresAt: candidate.expiresAt
    })
  } catch {
    throw newFileStoreCorruptionError("record")
  }
}

/** Encodes one complete deterministic checksummed Store snapshot. */
async function encodeSnapshot(
  records: ReadonlyMap<string, StoreRecord>,
  revision: number
): Promise<Uint8Array> {
  const sorted = Array.from(records.values()).sort((left, right) =>
    compareStoreKeys(left.key, right.key)
  )
  const persisted: unknown[] = []
  for (const record of sorted) {
    persisted.push({
      key: record.key,
      value: encodeBase64(record.value),
      metadata: record.metadata,
      revision: record.revision,
      expiresAt: record.expiresAt
    })
  }
  const payload = { schemaVersion: SnapshotSchemaVersion, revision, records: persisted }
  const payloadText = JSON.stringify(payload)
  const document = {
    schemaVersion: payload.schemaVersion,
    revision: payload.revision,
    records: payload.records,
    checksum: await checksum(payloadText)
  }
  return Encoder.encode(JSON.stringify(document))
}

/** Decodes and validates one complete checksummed Store snapshot. */
async function decodeSnapshot(bytes: Uint8Array): Promise<LoadedSnapshot> {
  let text: string
  try {
    text = Decoder.decode(new Uint8Array(bytes))
  } catch {
    throw newFileStoreCorruptionError("encoding")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw newFileStoreCorruptionError("json")
  }
  if (!isRecord(parsed) || !hasKeys(parsed, ["checksum", "records", "revision", "schemaVersion"])) {
    throw newFileStoreCorruptionError("schema")
  }
  const candidate: PersistedSnapshotCandidate = parsed
  if (typeof candidate.checksum !== "string" || !/^[0-9a-f]{64}$/.test(candidate.checksum)) {
    throw newFileStoreCorruptionError("checksum")
  }
  const payloadText = JSON.stringify({
    schemaVersion: candidate.schemaVersion,
    revision: candidate.revision,
    records: candidate.records
  })
  if ((await checksum(payloadText)) !== candidate.checksum) {
    throw newFileStoreCorruptionError("checksum")
  }
  if (
    candidate.schemaVersion !== SnapshotSchemaVersion ||
    !Number.isSafeInteger(candidate.revision) ||
    typeof candidate.revision !== "number" ||
    candidate.revision < 0 ||
    !Array.isArray(candidate.records)
  ) {
    throw newFileStoreCorruptionError("schema")
  }
  const records = new Map<string, StoreRecord>()
  for (const value of candidate.records) {
    const record = decodeRecord(value, candidate.revision)
    if (records.has(record.key)) throw newFileStoreCorruptionError("record")
    records.set(record.key, record)
  }
  return Object.freeze({ records, revision: candidate.revision })
}

/** Encodes one revision-bound, prefix-bound pagination cursor. */
function encodeCursor(revision: number, selectedPrefix: string, offset: number): string {
  return encodeBase64(
    Encoder.encode(
      JSON.stringify({ version: CursorVersion, revision, prefix: selectedPrefix, offset })
    )
  )
}

/** Decodes one cursor and rejects stale or cross-query reuse. */
function decodeCursor(value: string, revision: number, selectedPrefix: string): number {
  try {
    const parsed: unknown = JSON.parse(Decoder.decode(decodeBase64(value)))
    if (!isRecord(parsed) || !hasKeys(parsed, ["offset", "prefix", "revision", "version"])) {
      throw new TypeError("invalid cursor")
    }
    const candidate: CursorCandidate = parsed
    if (
      candidate.version !== CursorVersion ||
      candidate.revision !== revision ||
      candidate.prefix !== selectedPrefix ||
      !Number.isSafeInteger(candidate.offset) ||
      typeof candidate.offset !== "number" ||
      candidate.offset < 0
    ) {
      throw new TypeError("invalid cursor")
    }
    return candidate.offset
  } catch {
    throw new TypeError("File Store cursor is invalid or stale")
  }
}

/** Creates one portable single-owner atomic file Store without performing I/O. */
export function newFileStore(host: FileStoreHost, directory: string): FileStore {
  const capturedHost = captureHost(host)
  const capturedDirectoryName = exactString(directory, true)
  let state: FileStoreState = "idle"
  let records = new Map<string, StoreRecord>()
  let revision = 0
  let dirtyExpiry = false
  let directoryHandle: CapturedDirectory | null = null
  const terminal = deferred<void>()
  observe(terminal.promise)
  let shutdown: Promise<void> | null = null
  let operationTail = Promise.resolve()

  /** Advances the persisted mutation generation without exceeding exact integer revisions. */
  function nextRevision(): number {
    if (revision >= MaximumRevision) throw new RangeError("File Store revision is exhausted")
    return revision + 1
  }

  /** Validates one key and its UTF-8 provider limit before filesystem access. */
  function storeKey(value: string): string {
    const key = exactString(value, true)
    if (Encoder.encode(key).byteLength > MaximumKeyBytes) {
      throw new RangeError("File Store key exceeds maximumKeyBytes")
    }
    return key
  }

  /** Purges all currently expired records and advances the local pagination generation once. */
  function purgeExpired(): void {
    const now = Date.now()
    let changed = false
    for (const [key, record] of records) {
      if (record.expiresAt !== null && record.expiresAt <= now) {
        records.delete(key)
        changed = true
      }
    }
    if (changed) {
      revision = nextRevision()
      dirtyExpiry = true
    }
  }

  /** Returns the admitted directory or rejects an impossible internal state. */
  function admittedDirectory(): CapturedDirectory {
    if (directoryHandle === null) throw newFileStoreStateError("filesystem", state)
    return directoryHandle
  }

  /** Writes a complete candidate snapshot through temp-write and atomic rename. */
  async function persist(
    ctx: Context,
    candidate: ReadonlyMap<string, StoreRecord>,
    candidateRevision: number
  ): Promise<void> {
    const active = admittedDirectory()
    const bytes = await encodeSnapshot(candidate, candidateRevision)
    checkContext(ctx)
    await active.write.call(active.receiver, ctx, TempName, bytes)
    checkContext(ctx)
    await active.rename.call(active.receiver, ctx, TempName, SnapshotName)
  }

  /** Queues one admitted operation behind every earlier operation. */
  function operate<T>(ctx: Context, operation: string, run: () => T | PromiseLike<T>): Promise<T> {
    if (state !== "running") return Promise.reject(newFileStoreStateError(operation, state))
    const task = operationTail.then(async () => {
      checkContext(ctx)
      return await run()
    })
    operationTail = task.then(
      /** Releases the serial queue after successful operation settlement. */
      function operationSucceeded(): void {},
      /** Releases the serial queue after failed operation settlement. */
      function operationFailed(): void {}
    )
    return waitForContext(ctx, task)
  }

  /** Starts the one shared owner shutdown and settles the stable terminal barrier. */
  function startShutdown(): Promise<void> {
    if (shutdown !== null) return shutdown
    state = "stopping"
    const active = admittedDirectory()

    /** Drains accepted operations, releases the lock, and settles owner state exactly once. */
    async function drain(): Promise<void> {
      const cleanup: Error[] = []
      await operationTail
      try {
        await active.remove.call(active.receiver, background(), TempName)
      } catch (value) {
        cleanup.push(normalizeError(value, "File Store temp cleanup failed"))
      }
      try {
        await active.close.call(active.receiver, background())
      } catch (value) {
        cleanup.push(normalizeError(value, "File Store directory stop failed"))
      }
      directoryHandle = null
      const failure = combinedFailure(null, cleanup, "File Store lifecycle failed")
      if (failure === null) {
        state = "stopped"
        terminal.resolve(undefined)
        return
      }
      state = "failed"
      terminal.reject(failure)
      throw failure
    }

    shutdown = drain()
    observe(shutdown)
    return shutdown
  }

  const store: FileStore = {
    async start(ctx): Promise<void> {
      if (state !== "idle") throw newFileStoreStateError("start", state)
      state = "starting"
      let rawDirectory: FileStoreDirectory | null = null
      let admitted: CapturedDirectory | null = null
      try {
        checkContext(ctx)
        rawDirectory = await capturedHost.acquire.call(
          capturedHost.receiver,
          ctx,
          capturedDirectoryName
        )
        admitted = captureDirectory(rawDirectory)
        directoryHandle = admitted
        await admitted.remove.call(admitted.receiver, ctx, TempName)
        const bytes = await admitted.read.call(admitted.receiver, ctx, SnapshotName)
        if (bytes !== null) {
          const loaded = await decodeSnapshot(bytes)
          records = loaded.records
          revision = loaded.revision
          purgeExpired()
        }
        checkContext(ctx)
      } catch (value) {
        const primary = normalizeError(value, "File Store startup failed")
        const cleanup: Error[] = []
        if (admitted !== null) {
          try {
            await admitted.close.call(admitted.receiver, background())
          } catch (failure) {
            cleanup.push(normalizeError(failure, "File Store startup rollback failed"))
          }
        } else if (rawDirectory !== null) {
          try {
            await rawDirectory.close(background())
          } catch (failure) {
            cleanup.push(normalizeError(failure, "File Store startup rollback failed"))
          }
        }
        directoryHandle = null
        state = "failed"
        terminal.resolve(undefined)
        throw combinedFailure(primary, cleanup, "File Store startup and rollback failed") ?? primary
      }

      if (state === "starting") state = "running"
      else void startShutdown()
      return terminal.promise
    },
    stop(ctx): Promise<void> {
      if (state === "idle") return Promise.reject(newFileStoreStateError("stop", state))
      if (state === "starting") state = "stopping"
      if (state === "running") void startShutdown()
      return waitForContext(ctx, terminal.promise)
    },
    read(ctx, key) {
      return operate(ctx, "read", () => {
        const selectedKey = storeKey(key)
        purgeExpired()
        const record = records.get(selectedKey)
        return record === undefined ? null : snapshotStoreRecord(record)
      })
    },
    write(ctx, value, ...options) {
      return operate(ctx, "write", async () => {
        const input = snapshotStoreRecordInput(value)
        const key = storeKey(input.key)
        if (input.value.byteLength > MaximumValueBytes) {
          throw new RangeError("File Store value exceeds maximumValueBytes")
        }
        const selected = writeOptions(...options)
        if (selected.expiresInMs !== null) {
          if (
            selected.expiresInMs < MinimumTTLMilliseconds ||
            selected.expiresInMs > MaximumTTLMilliseconds
          ) {
            throw new RangeError("File Store ttl is outside provider bounds")
          }
        }
        purgeExpired()
        const current = records.get(key)
        if (selected.ifAbsent === true && current !== undefined) {
          throw newStoreConflictError(key, null, current.revision)
        }
        if (selected.ifRevision !== null && current?.revision !== selected.ifRevision) {
          throw newStoreConflictError(key, selected.ifRevision, current?.revision ?? null)
        }
        const candidateRevision = nextRevision()
        const expiresAt = selected.expiresInMs === null ? null : Date.now() + selected.expiresInMs
        if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) {
          throw new RangeError("File Store expiry exceeds safe timestamp bounds")
        }
        const candidate = new Map(records)
        const record = snapshotStoreRecord({
          key,
          value: input.value,
          metadata: input.metadata ?? {},
          revision: String(candidateRevision),
          expiresAt
        })
        candidate.set(key, record)
        await persist(ctx, candidate, candidateRevision)
        records = candidate
        revision = candidateRevision
        dirtyExpiry = false
        return snapshotStoreRecord(record)
      })
    },
    delete(ctx, key, ...options) {
      return operate(ctx, "delete", async () => {
        const selectedKey = storeKey(key)
        const selected = deleteOptions(...options)
        purgeExpired()
        const current = records.get(selectedKey)
        if (selected.ifRevision !== null && current?.revision !== selected.ifRevision) {
          throw newStoreConflictError(selectedKey, selected.ifRevision, current?.revision ?? null)
        }
        if (current === undefined) {
          if (dirtyExpiry) {
            await persist(ctx, records, revision)
            dirtyExpiry = false
          }
          return false
        }
        const candidate = new Map(records)
        candidate.delete(selectedKey)
        const candidateRevision = nextRevision()
        await persist(ctx, candidate, candidateRevision)
        records = candidate
        revision = candidateRevision
        dirtyExpiry = false
        return true
      })
    },
    list(ctx, ...options) {
      return operate(ctx, "list", () => {
        const selected = listOptions(...options)
        if (selected.limit !== null && selected.limit > MaximumListLimit) {
          throw new RangeError(`File Store list limit exceeds ${MaximumListLimit}`)
        }
        purgeExpired()
        const selectedPrefix = exactString(selected.prefix, false)
        const offset =
          selected.cursor === null ? 0 : decodeCursor(selected.cursor, revision, selectedPrefix)
        const matching = Array.from(records.values())
          .filter((record) => record.key.startsWith(selectedPrefix))
          .sort((left, right) => compareStoreKeys(left.key, right.key))
        if (offset > matching.length) throw new TypeError("File Store cursor is invalid or stale")
        const pageLimit = selected.limit ?? MaximumListLimit
        const pageRecords = matching.slice(offset, offset + pageLimit)
        const nextOffset = offset + pageRecords.length
        return snapshotStorePage({
          records: pageRecords,
          cursor:
            nextOffset < matching.length ? encodeCursor(revision, selectedPrefix, nextOffset) : null
        })
      })
    },
    string(): string {
      return "file"
    }
  }
  return Object.freeze(store)
}

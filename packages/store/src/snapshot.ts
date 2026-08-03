import type { StorePage, StoreRecord, StoreRecordInput } from "./types"

interface StoreRecordCandidate {
  readonly key?: unknown
  readonly value?: unknown
  readonly metadata?: unknown
  readonly revision?: unknown
  readonly expiresAt?: unknown
}

interface StorePageCandidate {
  readonly records?: unknown
  readonly cursor?: unknown
}

const MaximumSafeInteger = Number.MAX_SAFE_INTEGER

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

/** Validates one exact Store string without normalizing provider-owned text. */
function exactString(value: unknown, name: string, nonEmpty: boolean): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || !isWellFormed(value)) {
    throw new TypeError(`${name} must be a well-formed string`)
  }
  return value
}

/** Validates one finite safe integer against inclusive bounds. */
function safeInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${name} must be a safe integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Compares two Store keys lexicographically by Unicode code point. */
export function compareStoreKeys(left: string, right: string): number {
  const validLeft = exactString(left, "left Store key", false)
  const validRight = exactString(right, "right Store key", false)
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < validLeft.length && rightIndex < validRight.length) {
    const leftPoint = Number(validLeft.codePointAt(leftIndex))
    const rightPoint = Number(validRight.codePointAt(rightIndex))
    if (leftPoint < rightPoint) return -1
    if (leftPoint > rightPoint) return 1
    leftIndex += leftPoint > 0xffff ? 2 : 1
    rightIndex += rightPoint > 0xffff ? 2 : 1
  }
  if (leftIndex < validLeft.length) return 1
  if (rightIndex < validRight.length) return -1
  return 0
}

/** Copies, code-point sorts, and freezes one string-only Store metadata record. */
function snapshotMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new TypeError("Store metadata must be a string record")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Store metadata must be a plain string record")
  }
  const copied: [string, string][] = []
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Store metadata must contain only data properties")
    }
    copied.push([
      exactString(key, "Store metadata key", false),
      exactString(descriptor.value, "Store metadata value", false)
    ])
  }
  /** Sorts one metadata pair by its exact Unicode code-point key. */
  function compareEntry(left: readonly [string, string], right: readonly [string, string]): number {
    return compareStoreKeys(left[0], right[0])
  }
  copied.sort(compareEntry)
  return Object.freeze(Object.fromEntries(copied))
}

/** Copies one byte view and returns a reader that exposes only detached bytes. */
function retainedBytes(value: unknown, name: string): () => Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`)
  const retained = new Uint8Array(value)
  /** Returns one detached copy of the retained Store bytes. */
  function read(): Uint8Array {
    return new Uint8Array(retained)
  }
  return read
}

/** Produces an immutable defensive snapshot from one Store write input. */
export function snapshotStoreRecordInput(value: StoreRecordInput): StoreRecordInput {
  const candidate: unknown = value
  if (!isRecord(candidate)) throw new TypeError("Store record input must be an object")
  const record: StoreRecordCandidate = candidate
  const bytes = retainedBytes(record.value, "Store record input value")
  const metadata = snapshotMetadata(record.metadata ?? {})
  const snapshot: StoreRecordInput = {
    key: exactString(record.key, "Store record input key", true),
    /** Returns detached bytes for every provider read. */
    get value(): Uint8Array {
      return bytes()
    },
    metadata
  }
  return Object.freeze(snapshot)
}

/** Produces an immutable defensive snapshot from one provider Store record. */
export function snapshotStoreRecord(value: StoreRecord): StoreRecord {
  const candidate: unknown = value
  if (!isRecord(candidate)) throw new TypeError("Store record must be an object")
  const record: StoreRecordCandidate = candidate
  const bytes = retainedBytes(record.value, "Store record value")
  const expiresAt =
    record.expiresAt === null
      ? null
      : safeInteger(record.expiresAt, 0, MaximumSafeInteger, "Store record expiresAt")
  const snapshot: StoreRecord = {
    key: exactString(record.key, "Store record key", true),
    /** Returns detached bytes for every caller read. */
    get value(): Uint8Array {
      return bytes()
    },
    metadata: snapshotMetadata(record.metadata),
    revision: exactString(record.revision, "Store record revision", true),
    expiresAt
  }
  return Object.freeze(snapshot)
}

/** Produces a sorted immutable defensive snapshot from one provider Store page. */
export function snapshotStorePage(value: StorePage): StorePage {
  const candidate: unknown = value
  if (!isRecord(candidate)) throw new TypeError("Store page must be an object")
  const page: StorePageCandidate = candidate
  if (!Array.isArray(page.records)) throw new TypeError("Store page records must be an array")
  const records: StoreRecord[] = []
  const keys = new Set<string>()
  for (const record of page.records) {
    const snapshot = snapshotStoreRecord(record)
    if (keys.has(snapshot.key)) throw new TypeError("Store page record keys must be unique")
    keys.add(snapshot.key)
    records.push(snapshot)
  }
  /** Sorts one record pair by exact Unicode code-point key order. */
  function compareRecord(left: StoreRecord, right: StoreRecord): number {
    return compareStoreKeys(left.key, right.key)
  }
  records.sort(compareRecord)
  const pageCursor =
    page.cursor === null ? null : exactString(page.cursor, "Store page cursor", true)
  return Object.freeze({ records: Object.freeze(records), cursor: pageCursor })
}

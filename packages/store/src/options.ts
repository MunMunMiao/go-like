import type {
  DeleteOption,
  DeleteOptions,
  ListOption,
  ListOptions,
  WriteOption,
  WriteOptions
} from "./types"

const MaximumSafeInteger = Number.MAX_SAFE_INTEGER
const DefaultWriteOptions: WriteOptions = Object.freeze({
  expiresInMs: null,
  ifAbsent: false,
  ifRevision: null
})
const DefaultDeleteOptions: DeleteOptions = Object.freeze({ ifRevision: null })
const DefaultListOptions: ListOptions = Object.freeze({ prefix: "", limit: null, cursor: null })

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

/** Validates one exact Store option string without normalizing provider-owned text. */
function exactString(value: string, name: string, nonEmpty: boolean): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || !isWellFormed(value)) {
    throw new TypeError(`${name} must be a well-formed string`)
  }
  return value
}

/** Validates one positive safe integer option. */
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MaximumSafeInteger) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

/** Validates and freezes one write option candidate. */
function snapshotWriteOptions(value: WriteOptions): WriteOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Store write options must be an object")
  }
  const absent = value.ifAbsent ?? false
  if (typeof absent !== "boolean") {
    throw new TypeError("Store ifAbsent must be a boolean")
  }
  const revision =
    value.ifRevision === null ? null : exactString(value.ifRevision, "Store ifRevision", true)
  if (absent && revision !== null) {
    throw new TypeError("Store ifAbsent and ifRevision are mutually exclusive")
  }
  return Object.freeze({
    expiresInMs:
      value.expiresInMs === null ? null : positiveInteger(value.expiresInMs, "Store expiresInMs"),
    ifAbsent: absent,
    ifRevision: revision
  })
}

/** Validates and freezes one delete option candidate. */
function snapshotDeleteOptions(value: DeleteOptions): DeleteOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Store delete options must be an object")
  }
  return Object.freeze({
    ifRevision:
      value.ifRevision === null ? null : exactString(value.ifRevision, "Store ifRevision", true)
  })
}

/** Validates and freezes one list option candidate. */
function snapshotListOptions(value: ListOptions): ListOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Store list options must be an object")
  }
  return Object.freeze({
    prefix: exactString(value.prefix, "Store list prefix", false),
    limit: value.limit === null ? null : positiveInteger(value.limit, "Store list limit"),
    cursor: value.cursor === null ? null : exactString(value.cursor, "Store list cursor", true)
  })
}

/** Sets one record lifetime in positive integer milliseconds. */
export function expiresIn(valueMs: number): WriteOption {
  const captured = positiveInteger(valueMs, "Store expiresInMs")
  /** Applies the captured lifetime to one write option snapshot. */
  function apply(options: WriteOptions): WriteOptions {
    return Object.freeze({
      expiresInMs: captured,
      ifAbsent: options.ifAbsent === true,
      ifRevision: options.ifRevision
    })
  }
  return apply
}

/** Admits a write only while no provider-visible record exists at its key. */
export function ifAbsent(): WriteOption {
  /** Selects absence as the write condition and clears any earlier revision condition. */
  function apply(options: WriteOptions): WriteOptions {
    return Object.freeze({ expiresInMs: options.expiresInMs, ifAbsent: true, ifRevision: null })
  }
  return apply
}

/** Sets one provider-opaque compare-and-swap token for write or delete. */
export function ifRevision(revision: string): WriteOption & DeleteOption {
  const captured = exactString(revision, "Store ifRevision", true)
  /** Applies the token while retaining write-only state. */
  function apply(options: WriteOptions): WriteOptions
  /** Applies the token to one delete option snapshot. */
  function apply(options: DeleteOptions): DeleteOptions
  function apply(options: WriteOptions | DeleteOptions): WriteOptions | DeleteOptions {
    if ("expiresInMs" in options) {
      return Object.freeze({
        expiresInMs: options.expiresInMs,
        ifAbsent: false,
        ifRevision: captured
      })
    }
    return Object.freeze({ ifRevision: captured })
  }
  return apply
}

/** Restricts one list operation to exact keys beginning with the captured prefix. */
export function prefix(value: string): ListOption {
  const captured = exactString(value, "Store list prefix", false)
  /** Applies the captured prefix to one list option snapshot. */
  function apply(options: ListOptions): ListOptions {
    return Object.freeze({ prefix: captured, limit: options.limit, cursor: options.cursor })
  }
  return apply
}

/** Restricts one list page to at most the captured positive count. */
export function limit(count: number): ListOption {
  const captured = positiveInteger(count, "Store list limit")
  /** Applies the captured limit to one list option snapshot. */
  function apply(options: ListOptions): ListOptions {
    return Object.freeze({ prefix: options.prefix, limit: captured, cursor: options.cursor })
  }
  return apply
}

/** Resumes one list operation from a provider-opaque non-empty cursor. */
export function cursor(value: string): ListOption {
  const captured = exactString(value, "Store list cursor", true)
  /** Applies the captured cursor to one list option snapshot. */
  function apply(options: ListOptions): ListOptions {
    return Object.freeze({ prefix: options.prefix, limit: options.limit, cursor: captured })
  }
  return apply
}

/** Resolves write options from normative defaults and ordered reducers. */
export function writeOptions(
  ...options: readonly WriteOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): WriteOptions {
  let candidate = DefaultWriteOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Store write option must be a function")
    candidate = snapshotWriteOptions(option(candidate))
  }
  return candidate
}

/** Resolves delete options from normative defaults and ordered reducers. */
export function deleteOptions(
  ...options: readonly DeleteOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): DeleteOptions {
  let candidate = DefaultDeleteOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Store delete option must be a function")
    candidate = snapshotDeleteOptions(option(candidate))
  }
  return candidate
}

/** Resolves list options from normative defaults and ordered reducers. */
export function listOptions(
  ...options: readonly ListOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): ListOptions {
  let candidate = DefaultListOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Store list option must be a function")
    candidate = snapshotListOptions(option(candidate))
  }
  return candidate
}

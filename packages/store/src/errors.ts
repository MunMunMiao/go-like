import type { StoreConflictError } from "./types"

const StoreConflictErrorName: StoreConflictError["name"] = "StoreConflictError"
const StoreConflictErrorCode: StoreConflictError["code"] = "GO_LIKE_STORE_CONFLICT"

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

/** Validates one non-empty well-formed public error detail. */
function detail(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError(`${name} must be a non-empty well-formed string`)
  }
  return value
}

/** Creates one immutable conditional-write conflict with provider-opaque revisions. */
export function newStoreConflictError(
  key: string,
  expectedRevision: string | null,
  actualRevision: string | null
): StoreConflictError {
  const validKey = detail(key, "Store conflict key")
  const validExpected =
    expectedRevision === null ? null : detail(expectedRevision, "Store expected revision")
  const validActual =
    actualRevision === null ? null : detail(actualRevision, "Store actual revision")
  const message =
    validExpected === null
      ? `Store conditional write conflict for key ${validKey}`
      : `Store compare-and-swap conflict for key ${validKey}`
  return Object.freeze(
    Object.assign(new Error(message), {
      name: StoreConflictErrorName,
      code: StoreConflictErrorCode,
      key: validKey,
      expectedRevision: validExpected,
      actualRevision: validActual
    })
  )
}

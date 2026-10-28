import type { StoreConflictError } from "./types"

const StoreConflictErrorName: StoreConflictError["name"] = "StoreConflictError"
const StoreConflictErrorCode: StoreConflictError["code"] = "GO_LIKE_STORE_CONFLICT"

/** Validates one non-empty well-formed public error detail. */
function detail(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
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

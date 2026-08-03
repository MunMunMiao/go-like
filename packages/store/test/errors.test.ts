import { expect, test } from "bun:test"

import { newStoreConflictError } from "../src/provider"

test("Store errors expose stable immutable machine-readable fields", () => {
  const conflict = newStoreConflictError("key", "one", "two")
  const missingConflict = newStoreConflictError("key", "one", null)
  const existsConflict = newStoreConflictError("key", null, "two")
  const supplementaryConflict = newStoreConflictError("😀", "one", null)

  expect(conflict).toMatchObject({
    name: "StoreConflictError",
    code: "LIKEGO_STORE_CONFLICT",
    key: "key",
    expectedRevision: "one",
    actualRevision: "two"
  })
  expect(conflict.message).toBe("Store compare-and-swap conflict for key key")
  expect(missingConflict.message).toBe("Store compare-and-swap conflict for key key")
  expect(missingConflict.actualRevision).toBeNull()
  expect(existsConflict).toMatchObject({ expectedRevision: null, actualRevision: "two" })
  expect(existsConflict.message).toBe("Store conditional write conflict for key key")
  expect(supplementaryConflict.key).toBe("😀")
  for (const error of [conflict, missingConflict, existsConflict, supplementaryConflict]) {
    expect(error).toBeInstanceOf(Error)
    expect(Object.isFrozen(error)).toBe(true)
  }
})

test("Store error factories reject malformed public diagnostics", () => {
  expect(() => newStoreConflictError("", "one", null)).toThrow(TypeError)
  expect(() => newStoreConflictError("\ud800", "one", null)).toThrow(TypeError)
  expect(() => newStoreConflictError("key", "", null)).toThrow(TypeError)
  expect(() => newStoreConflictError("key", "one", "")).toThrow(TypeError)
})

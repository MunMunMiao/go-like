import { expect, test } from "bun:test"

import * as Store from "../../src/store/index"
import * as StoreProvider from "../../src/store/provider"
import * as StoreTesting from "../../src/store/testing"

test("root exports only caller-facing Store options", () => {
  expect(Object.keys(Store).sort()).toEqual([
    "cursor",
    "expiresIn",
    "ifAbsent",
    "ifRevision",
    "limit",
    "prefix"
  ])
})

test("provider module exports implementation helpers", () => {
  expect(Object.keys(StoreProvider).sort()).toEqual([
    "compareStoreKeys",
    "deleteOptions",
    "listOptions",
    "newStoreConflictError",
    "snapshotStorePage",
    "snapshotStoreRecord",
    "snapshotStoreRecordInput",
    "writeOptions"
  ])
})

test("internal testing module exports only provider-neutral conformance", () => {
  expect(Object.keys(StoreTesting)).toEqual(["storeConformance"])
})

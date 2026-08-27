import { expect, test } from "bun:test"

import * as FileStore from "../src/index"
import * as FileStoreNode from "../src/node"

test("portable root exports only File Store construction and stable errors", () => {
  expect(Object.keys(FileStore).sort()).toEqual([
    "newFileStore",
    "newFileStoreCorruptionError",
    "newFileStoreLockedError",
    "newFileStoreStateError"
  ])
})

test("Node subpath exports only its explicit filesystem capability", () => {
  expect(Object.keys(FileStoreNode)).toEqual(["newNodeFileStoreHost"])
})

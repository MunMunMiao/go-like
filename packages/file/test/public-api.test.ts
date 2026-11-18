import { expect, test } from "bun:test"

import * as FileStore from "../src/store/index"
import * as FileStoreNode from "../src/store/node"

test("portable root runtime export is newFileStore", () => {
  expect(Object.keys(FileStore).sort()).toEqual(["newFileStore"])
})

test("Node subpath exports only its explicit filesystem capability", () => {
  expect(Object.keys(FileStoreNode)).toEqual(["newNodeFileStoreHost"])
})

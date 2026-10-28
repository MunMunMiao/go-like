import { expect, test } from "bun:test"

import * as MemoryStore from "../src/index"

test("exports only the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(MemoryStore).sort()).toEqual(["clock", "newMemoryStore"])
  expect("NewMemoryStore" in MemoryStore).toBe(false)
  expect("MemoryStore" in MemoryStore).toBe(false)
  expect("newMemoryStoreAtRevision" in MemoryStore).toBe(false)
})

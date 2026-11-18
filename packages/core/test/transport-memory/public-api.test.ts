import { expect, test } from "bun:test"

import * as MemoryPackage from "../../src/transport/memory/index"

test("exports only the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(MemoryPackage)).toEqual(["newMemoryTransport"])
  expect(MemoryPackage).not.toHaveProperty("NewMemoryTransport")
  expect(MemoryPackage).not.toHaveProperty("MemoryTransport")
})

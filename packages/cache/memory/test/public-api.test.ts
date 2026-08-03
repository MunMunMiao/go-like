import { expect, test } from "bun:test"

import * as MemoryCache from "../src/index"

test("exports only the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(MemoryCache).sort()).toEqual(["clock", "newMemoryCache"])
  expect("NewMemoryCache" in MemoryCache).toBe(false)
  expect("MemoryCache" in MemoryCache).toBe(false)
})

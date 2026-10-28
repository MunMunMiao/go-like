import { expect, test } from "bun:test"

import * as MemoryBroker from "../src/index"

test("exports only the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(MemoryBroker)).toEqual(["newMemoryBroker"])
  expect("NewMemoryBroker" in MemoryBroker).toBe(false)
  expect("MemoryBroker" in MemoryBroker).toBe(false)
})

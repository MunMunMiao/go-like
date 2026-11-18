import { expect, test } from "bun:test"

import * as Cache from "../../src/cache/index"
import * as CacheTesting from "../../src/cache/testing"

test("root exports only the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(Cache).sort()).toEqual(["expiresIn", "putOptions"])
  expect(Cache).not.toHaveProperty("NewCache")
  expect(Cache).not.toHaveProperty("Cache")
})

test("internal testing module exports only provider-neutral conformance", () => {
  expect(Object.keys(CacheTesting)).toEqual(["cacheConformance"])
})

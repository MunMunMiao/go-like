import { expect, test } from "bun:test"

import * as Cache from "../src/index"
import * as CacheProvider from "../src/provider"
import * as CacheTesting from "../src/testing"

test("root exports only the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(Cache)).toEqual(["expiresIn"])
  expect(Cache).not.toHaveProperty("NewCache")
  expect(Cache).not.toHaveProperty("Cache")
})

test("provider module exports only the option resolver", () => {
  expect(Object.keys(CacheProvider)).toEqual(["putOptions"])
})

test("internal testing module exports only provider-neutral conformance", () => {
  expect(Object.keys(CacheTesting)).toEqual(["cacheConformanceCases"])
})

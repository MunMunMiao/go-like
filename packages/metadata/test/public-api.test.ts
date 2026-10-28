import { expect, test } from "bun:test"

import * as MetadataPackage from "../src/index"

const RuntimeExports = [
  "append",
  "appendToClientContext",
  "clone",
  "fromClientContext",
  "fromServerContext",
  "get",
  "keys",
  "merge",
  "mergeToClientContext",
  "newClientContext",
  "newMetadata",
  "newServerContext",
  "propagateToClientContext",
  "remove",
  "set",
  "values"
]

test("exports exactly the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(MetadataPackage).sort()).toEqual(RuntimeExports.sort())
  expect(MetadataPackage).not.toHaveProperty("Metadata")
  expect(MetadataPackage).not.toHaveProperty("NewMetadata")
  expect(MetadataPackage).not.toHaveProperty("appendClientMetadata")
})

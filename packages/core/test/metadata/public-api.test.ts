import { expect, test } from "bun:test"

import * as MetadataPackage from "../../src/metadata/index"

test("exports exactly the reviewed lower-camel runtime surface", () => {
  expect(MetadataPackage).not.toHaveProperty("Metadata")
  expect(MetadataPackage).not.toHaveProperty("NewMetadata")
  expect(MetadataPackage).not.toHaveProperty("appendClientMetadata")
})

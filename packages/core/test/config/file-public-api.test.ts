import { expect, test } from "bun:test"

import * as FileConfig from "../../src/config/file"
import * as JsonConfig from "../../src/config/json"

test("public API exposes only lower-camel runtime functions", () => {
  expect(Object.keys(FileConfig).sort()).toEqual(["fileSource"])
  expect(Object.keys(JsonConfig).sort()).toEqual(["jsonDecoder"])
})

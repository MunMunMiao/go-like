import { expect, test } from "bun:test"

import * as FileConfig from "../src/file"

test("public API exposes only lower-camel runtime functions", () => {
  expect(Object.keys(FileConfig).sort()).toEqual(["fileSource", "jsonFileDecoder"])
})

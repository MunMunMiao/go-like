import { expect, test } from "bun:test"

import * as ConsulConfig from "../src/index"

test("public API exposes only lower-camel runtime functions", () => {
  expect(Object.keys(ConsulConfig).sort()).toEqual(["consulSource", "jsonConsulDecoder"])
})

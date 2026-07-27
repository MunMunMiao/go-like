import { expect, test } from "bun:test"

import * as Create from "../src/index"

test("exports only the minimal programmatic scaffold operation", () => {
  expect(Object.keys(Create)).toEqual(["createProject"])
})

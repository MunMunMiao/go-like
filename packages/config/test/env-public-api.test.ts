import { expect, test } from "bun:test"

import * as EnvironmentConfig from "../src/env"

test("public API exports only the lower-camel environment source factory", () => {
  expect(Object.keys(EnvironmentConfig)).toEqual(["envSource"])
  expect(typeof EnvironmentConfig.envSource).toBe("function")
})

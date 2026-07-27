import { expect, test } from "bun:test"

import * as CronerPackage from "../src/index"

test("cron package exposes only the lower-camel native lifecycle factory", () => {
  expect(Object.keys(CronerPackage)).toEqual(["newCronerServer"])
  expect(typeof CronerPackage.newCronerServer).toBe("function")
})

import { expect, test } from "bun:test"
import * as plugin from "../src/index"

test("exports only the protoc plugin", () => {
  expect(Object.keys(plugin)).toEqual(["protocGenLike"])
})

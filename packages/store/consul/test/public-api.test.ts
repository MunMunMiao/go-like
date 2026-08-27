import { expect, test } from "bun:test"

import * as api from "../src/index"

test("root runtime export surface contains only the Consul Store constructor", () => {
  expect(Object.keys(api).sort()).toEqual(["newConsulStore"])
  expect(typeof api.newConsulStore).toBe("function")
})

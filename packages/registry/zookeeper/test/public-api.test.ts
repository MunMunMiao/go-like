import { expect, test } from "bun:test"

import * as api from "../src/index"

test("root runtime export surface contains only the unified constructor", () => {
  expect(Object.keys(api).sort()).toEqual(["newZookeeperRegistry"])
  expect(typeof api.newZookeeperRegistry).toBe("function")
})

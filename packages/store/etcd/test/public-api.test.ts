import { expect, test } from "bun:test"

import * as api from "../src/index"

test("root runtime export surface contains only the etcd Store constructor", () => {
  expect(Object.keys(api)).toEqual(["newEtcdStore"])
  expect(typeof api.newEtcdStore).toBe("function")
})

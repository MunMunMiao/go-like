import { expect, test } from "bun:test"

import * as vault from "../src/index"

test("public runtime API exposes only the lower-camel Vault Store constructor", () => {
  expect(Object.keys(vault).sort()).toEqual(["newVaultStore"])
})

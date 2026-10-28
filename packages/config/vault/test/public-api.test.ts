import { expect, test } from "bun:test"

import * as VaultConfig from "../src/index"

test("public API exposes only the lower-camel Vault source factory", () => {
  expect(Object.keys(VaultConfig).sort()).toEqual(["vaultSource"])
})

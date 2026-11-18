import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { coreVersion } from "../../src/internal/version"

test("coreVersion matches packages/core/package.json", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "../../package.json"), "utf8")
  ) as {
    version: string
  }
  expect(coreVersion).toBe(manifest.version)
})

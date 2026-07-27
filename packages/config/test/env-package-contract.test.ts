import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package JSON artifact without executing it. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("package and manifests publish the portable non-resident environment adapter contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/config",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    scripts: { build: "bun x --bun tsdown --config-loader native" },
    exports: { "./env": "./src/env.ts" },
    dependencies: {
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String),
      "@standard-schema/spec": "1.1.0"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/config",
    packageKind: "hybrid",
    exports: {
      "./env": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["config", "config-env"]
      }
    }
  })
  expect(await json("owner.json")).toMatchObject({ schemaVersion: 1, package: "@likego/config" })
})

test("environment provider has one explicit final source target", async () => {
  expect(await Bun.file(join(Root, "src/env.ts")).exists()).toBe(true)
})

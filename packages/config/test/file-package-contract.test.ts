import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package JSON artifact without executing it. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("package and manifests publish the hybrid capability-injected file contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/config",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    scripts: { build: "bun x --bun tsdown --config-loader native" },
    exports: { "./file": "./src/file.ts" },
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
      "./file": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["watch-subscription"],
        capabilities: ["config", "config-file"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/config",
    resources: [
      {
        id: "source-watcher",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      },
      {
        id: "watch-subscription",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      },
      {
        id: "node-file-watcher",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
  expect(await json("tsconfig.test.json")).toMatchObject({ exclude: ["test/runtime/**"] })
})

test("file provider has explicit final source and runtime-fixture targets", async () => {
  expect(await Bun.file(join(Root, "src/file.ts")).exists()).toBe(true)
  expect((await readdir(join(Root, "test", "runtime"))).sort()).toEqual([
    "deno-runtime.ts",
    "file-published-runtime.fixture.ts",
    "node-file-runtime.ts",
    "node-runtime.ts",
    "published-runtime.fixture"
  ])
})

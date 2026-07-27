import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package JSON artifact without executing it. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("package and manifests publish the Web Fetch Consul blocking-query contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/config-consul",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      "test:docker": "bun test/integration/consul-docker.ts",
      "test:runtime": "bun test/integration/runtime-matrix.ts"
    },
    dependencies: {
      "@likego/config": expect.any(String),
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String)
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/config-consul",
    packageKind: "portable",
    exports: {
      ".": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["blocking-query"],
        capabilities: ["config", "config-consul"]
      }
    }
  })
  expect(await json("owner.json")).toMatchObject({
    package: "@likego/config-consul",
    resources: [{ id: "blocking-query", owner: "likego-owned" }]
  })
})

test("package source inventory is explicit", async () => {
  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: Root, onlyFiles: true }))
    sources.push(file)
  expect(sources.sort()).toEqual(["src/index.ts"])
})

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package JSON artifact without executing it. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("package and manifests publish one portable resident Kubernetes source", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/config-kubernetes",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@likego/config": "0.0.1",
      "@likego/context": "0.0.1",
      "@likego/core": "0.0.1"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/config-kubernetes",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["watch-stream"],
        capabilities: ["config", "config-kubernetes"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/config-kubernetes",
    resources: [
      {
        id: "watch-stream",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})

test("package shell, source, tests, runtime, and integration evidence match inventory", async () => {
  const shell = (await readdir(Root))
    .filter((entry) => !entry.startsWith(".") && entry !== "dist" && entry !== "node_modules")
    .sort()
  const source = (await readdir(join(Root, "src"))).sort()
  const tests = (await readdir(join(Root, "test"))).sort()
  const runtime = (await readdir(join(Root, "test", "runtime"))).sort()
  const integration = (await readdir(join(Root, "test", "integration"))).sort()

  expect(shell).toEqual([
    "LICENSE",
    "README.md",
    "bunfig.toml",
    "capability.json",
    "owner.json",
    "package.json",
    "src",
    "test",
    "tsconfig.json",
    "tsconfig.test.json"
  ])
  expect(source).toEqual(["index.ts"])
  expect(tests).toEqual([
    "boundary.test.ts",
    "coverage-contract.ts",
    "helpers.ts",
    "integration",
    "kubernetes.test.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "runtime"
  ])
  expect(runtime).toEqual(["published-runtime.fixture"])
  expect(integration).toEqual(["k3s-1.36.2-report.md", "k3s-docker.ts"])
})

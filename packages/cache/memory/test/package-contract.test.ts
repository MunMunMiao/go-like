import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

test("publishes one portable non-resident Memory Cache package", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()
  const owner = await Bun.file(`${root}/owner.json`).json()
  const tsconfig = await Bun.file(`${root}/tsconfig.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/cache-memory",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@likego/cache": "0.0.1",
      "@likego/context": "0.0.1"
    }
  })
  expect(tsconfig.references).toEqual([{ path: "../../context" }, { path: ".." }])
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/cache-memory",
    resources: []
  })
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/cache-memory",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["cache", "cache-memory"]
      }
    }
  })
})

test("package shell source and test inventories are exact", async () => {
  const root = `${import.meta.dir}/..`
  const shell = (await readdir(root))
    .filter((entry) => !entry.startsWith(".") && entry !== "dist" && entry !== "node_modules")
    .sort()
  const sources = (await readdir(join(root, "src"))).sort()
  const tests = (await readdir(join(root, "test"))).sort()

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
  expect(sources).toEqual(["cache.ts", "index.ts", "options.ts", "types.ts"])
  expect(tests).toEqual([
    "cache.test.ts",
    "conformance.test.ts",
    "coverage-contract.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "source-policy.test.ts"
  ])
})

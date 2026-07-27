import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

test("package publishes the portable Cache and provider entries", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()
  const owner = await Bun.file(`${root}/owner.json`).json()
  const tsconfig = await Bun.file(`${root}/tsconfig.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/cache",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      ".": "./src/index.ts",
      "./provider": "./src/provider.ts"
    },
    dependencies: { "@likego/context": "0.0.1" },
    devDependencies: { "@likego/core": "workspace:*" }
  })
  expect(tsconfig.references).toEqual([{ path: "../context" }, { path: "../core" }])
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/cache",
    resources: []
  })
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/cache",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["cache"]
      },
      "./provider": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["cache"]
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
    "memory",
    "owner.json",
    "package.json",
    "redis",
    "src",
    "test",
    "tsconfig.json",
    "tsconfig.test.json"
  ])
  expect(sources).toEqual(["index.ts", "options.ts", "provider.ts", "testing.ts", "types.ts"])
  expect(tests).toEqual([
    "conformance.test.ts",
    "coverage-contract.ts",
    "helpers.ts",
    "options-errors.test.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "source-policy.test.ts"
  ])
})

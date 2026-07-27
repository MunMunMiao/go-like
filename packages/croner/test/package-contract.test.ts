import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

test("package manifest exposes one independently built native lifecycle root", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  expect(manifest).toMatchObject({
    name: "@likego/croner",
    version: expect.any(String),
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" }
  })
  expect(Object.keys(manifest.exports)).toEqual(["."])
  expect(manifest.dependencies).toEqual({
    "@likego/context": expect.any(String),
    "@likego/core": expect.any(String),
    croner: "10.0.1"
  })
  expect(manifest.scripts.build).toBe("bun x --bun tsdown --config-loader native")
})

test("package shell, source, and test inventory remain explicit", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const shell = (await readdir(packageRoot))
    .filter((entry) => !entry.startsWith(".") && entry !== "dist" && entry !== "node_modules")
    .sort()
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
  expect((await readdir(join(packageRoot, "src"))).sort()).toEqual([
    "errors.ts",
    "index.ts",
    "server.ts",
    "types.ts"
  ])
  expect((await readdir(join(packageRoot, "test"))).sort()).toEqual([
    "construction.test.ts",
    "coverage-contract.ts",
    "e2e",
    "helpers.ts",
    "lifecycle.test.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "runtime",
    "smoke",
    "source-policy.test.ts"
  ])
  expect((await readdir(join(packageRoot, "test", "runtime"))).sort()).toEqual([
    "deno-runtime.ts",
    "published-runtime.fixture.ts"
  ])
})

test("capability and ownership manifests truthfully declare unobservable managed timers", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const capability = JSON.parse(await readFile(join(packageRoot, "capability.json"), "utf8"))
  const owner = JSON.parse(await readFile(join(packageRoot, "owner.json"), "utf8"))
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/croner",
    packageKind: "integration",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["scheduler"],
        capabilities: ["cron", "server"]
      }
    }
  })
  expect(
    capability.exports["."].runtimes.map(
      (runtime: { runtime: string; testedVersions: string[] }) => [
        runtime.runtime,
        runtime.testedVersions
      ]
    )
  ).toEqual([
    ["bun", ["1.3.14"]],
    ["node", ["24.18.0"]],
    ["node", ["26.5.0"]],
    ["deno", ["2.9.4"]]
  ])
  expect(
    capability.exports["."].runtimes.every((runtime: { terminalObservability: string }) => {
      return runtime.terminalObservability === "unobservable"
    })
  ).toBe(true)
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/croner",
    resources: [
      {
        id: "scheduler",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})

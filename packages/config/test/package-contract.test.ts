import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

test("manifest exposes the independently built config root and provider subpaths", async () => {
  const manifest = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"))
  expect(manifest).toMatchObject({
    name: "@likego/config",
    version: expect.any(String),
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"]
  })
  expect(manifest.exports).toEqual({
    ".": "./src/index.ts",
    "./env": "./src/env.ts",
    "./file": "./src/file.ts",
    "./node": "./src/node.ts",
    "./yaml": "./src/yaml.ts"
  })
  expect(manifest.dependencies).toEqual({
    "@likego/context": expect.any(String),
    "@likego/core": expect.any(String),
    "@standard-schema/spec": "1.1.0",
    "js-yaml": "5.2.2"
  })
})

test("package shell and production source match the exact reviewed inventory", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const shell = (await readdir(packageRoot))
    .filter((entry) => !entry.startsWith(".") && entry !== "dist" && entry !== "node_modules")
    .sort()
  const sources = (await readdir(join(packageRoot, "src"))).sort()
  const tests = (await readdir(join(packageRoot, "test"))).sort()
  expect(shell).toEqual([
    "LICENSE",
    "README.md",
    "bunfig.toml",
    "capability.json",
    "consul",
    "etcd",
    "kubernetes",
    "owner.json",
    "package.json",
    "src",
    "test",
    "tsconfig.json",
    "tsconfig.test.json",
    "vault"
  ])
  expect(sources).toEqual([
    "config.ts",
    "env.ts",
    "errors.ts",
    "file.ts",
    "index.ts",
    "merge.ts",
    "node-host.ts",
    "node.ts",
    "source.ts",
    "validation.ts",
    "value.ts",
    "yaml.ts"
  ])
  expect(tests).toEqual([
    "construction.test.ts",
    "coverage-contract.ts",
    "env-package-contract.test.ts",
    "env-public-api.test.ts",
    "env-public-types.ts",
    "env-source-policy.test.ts",
    "env.test.ts",
    "file-helpers.ts",
    "file-package-contract.test.ts",
    "file-public-api.test.ts",
    "file-public-types.ts",
    "file-source-policy.test.ts",
    "file.test.ts",
    "helpers.ts",
    "lifecycle.test.ts",
    "load.test.ts",
    "merge.test.ts",
    "node-file.test.ts",
    "node-public-api.test.ts",
    "node-public-types.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "reload.test.ts",
    "resolver.test.ts",
    "runtime",
    "smoke",
    "source-policy.test.ts",
    "subscription.test.ts",
    "validation.test.ts",
    "value.test.ts",
    "yaml.test.ts"
  ])
})

test("capability and owner records pin the hybrid resident runtime contract", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const capability = JSON.parse(await readFile(join(packageRoot, "capability.json"), "utf8"))
  const owner = JSON.parse(await readFile(join(packageRoot, "owner.json"), "utf8"))
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/config",
    packageKind: "hybrid",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["source-watcher"],
        capabilities: ["config"]
      },
      "./env": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["config", "config-env"]
      },
      "./file": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["watch-subscription"],
        capabilities: ["config", "config-file"]
      },
      "./node": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["node-file-watcher"],
        capabilities: ["config-file", "node-filesystem"]
      },
      "./yaml": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["config", "config-yaml"]
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
    capability.exports["."].runtimes.every(
      (runtime: { terminalObservability: string }) => runtime.terminalObservability === "observable"
    )
  ).toBe(true)
  expect(owner).toEqual({
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
})

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package-owned JSON contract. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("publishes an independently built side-effect-free portable package", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/registry",
    version: expect.any(String),
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      ".": "./src/index.ts",
      "./provider": "./src/provider.ts"
    },
    dependencies: {
      "@likego/context": "0.0.1",
      "@likego/metadata": "0.0.1"
    },
    scripts: {
      build: "bun x --bun tsdown --config-loader native && bun run typecheck:published",
      test: "bun test --isolate --no-orphans --path-ignore-patterns=consul --path-ignore-patterns=etcd --path-ignore-patterns=kubernetes --path-ignore-patterns=mdns --path-ignore-patterns=zookeeper test/conformance.test.ts test/errors.test.ts test/options.test.ts test/package-contract.test.ts test/public-api.test.ts test/selector.test.ts test/snapshot.test.ts",
      "test:coverage":
        "bun test --isolate --no-orphans --path-ignore-patterns=consul --path-ignore-patterns=etcd --path-ignore-patterns=kubernetes --path-ignore-patterns=mdns --path-ignore-patterns=zookeeper test/conformance.test.ts test/errors.test.ts test/options.test.ts test/package-contract.test.ts test/public-api.test.ts test/selector.test.ts test/snapshot.test.ts --coverage --coverage-reporter=lcov --coverage-dir .artifacts/coverage && bun test/coverage-contract.ts",
      typecheck: "tsc -p tsconfig.test.json --pretty false",
      "typecheck:published": "tsc -p tsconfig.published.json --pretty false"
    }
  })
})

test("publishes only the non-resident Registry contract", async () => {
  const capability = await json("capability.json")
  const owner = await json("owner.json")
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/registry",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["registry", "discovery", "selector"]
      },
      "./provider": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["registry"]
      }
    }
  })
  if (
    capability === null ||
    typeof capability !== "object" ||
    !("exports" in capability) ||
    capability.exports === null ||
    typeof capability.exports !== "object" ||
    !("." in capability.exports) ||
    capability.exports["."] === null ||
    typeof capability.exports["."] !== "object" ||
    !("runtimes" in capability.exports["."]) ||
    !Array.isArray(capability.exports["."].runtimes)
  ) {
    throw new Error("capability runtimes are missing")
  }
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
      (runtime: { terminalObservability: string }) =>
        runtime.terminalObservability === "not-applicable"
    )
  ).toBe(true)
  expect(owner).toEqual({ schemaVersion: 1, package: "@likego/registry", resources: [] })
})

test("documents provider workspaces and keeps conformance internal", async () => {
  const readme = await readFile(join(Root, "README.md"), "utf8")
  expect(readme).toContain("具体 provider 位于五个独立子 workspace：")
  expect(readme).toContain("这些测试资产不属于")
  expect(readme).not.toContain("@likego/registry/testing")
  expect(readme).toContain("`newEWMASelector`")
  expect(readme).toContain("P2C + EWMA")
})

test("package shell, source, and tests match the reviewed inventory", async () => {
  const shell = (await readdir(Root))
    .filter((entry) => !entry.startsWith(".") && entry !== "dist" && entry !== "node_modules")
    .sort()
  const sources = (await readdir(join(Root, "src"))).sort()
  const tests = (await readdir(join(Root, "test"))).sort()
  expect(shell).toEqual([
    "LICENSE",
    "README.md",
    "bunfig.toml",
    "capability.json",
    "consul",
    "etcd",
    "kubernetes",
    "mdns",
    "owner.json",
    "package.json",
    "src",
    "test",
    "tsconfig.json",
    "tsconfig.published.json",
    "tsconfig.runtime.json",
    "tsconfig.test.json",
    "zookeeper"
  ])
  expect(sources).toEqual([
    "errors.ts",
    "index.ts",
    "options.ts",
    "provider.ts",
    "selector.ts",
    "snapshot.ts",
    "testing.ts",
    "types.ts"
  ])
  expect(tests).toEqual([
    "conformance.test.ts",
    "coverage-contract.ts",
    "errors.test.ts",
    "helpers.ts",
    "options.test.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "published-types.ts",
    "selector.test.ts",
    "snapshot.test.ts"
  ])
})

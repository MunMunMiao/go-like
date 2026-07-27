import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package-owned JSON contract. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("publishes the portable non-resident transport contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/transport",
    version: expect.any(String),
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      ".": "./src/index.ts",
      "./headers": "./src/headers.ts",
      "./json": "./src/json.ts",
      "./provider": "./src/provider.ts"
    },
    dependencies: {
      "@likego/context": expect.any(String),
      "@likego/metadata": expect.any(String),
      "@standard-schema/spec": "1.1.0"
    },
    scripts: {
      test: "bun test --isolate --no-orphans --path-ignore-patterns=http --path-ignore-patterns=memory test/*.test.ts",
      "test:coverage":
        "bun test --isolate --no-orphans --path-ignore-patterns=http --path-ignore-patterns=memory test/*.test.ts --coverage --coverage-reporter=lcov --coverage-dir .artifacts/coverage && bun test/coverage-contract.ts"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/transport",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["transport"]
      },
      "./headers": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["headers", "transport"]
      },
      "./json": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["transport"]
      },
      "./provider": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["transport"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/transport",
    resources: []
  })
})

test("package shell, source, and tests match the reviewed inventory", async () => {
  const shell = (await readdir(Root))
    .filter((entry) => !entry.startsWith(".") && entry !== "dist" && entry !== "node_modules")
    .sort()
  const sources = (await readdir(join(Root, "src")).catch(() => [] as string[])).sort()
  const tests = (await readdir(join(Root, "test"))).sort()

  expect(shell).toEqual([
    "LICENSE",
    "README.md",
    "bunfig.toml",
    "capability.json",
    "http",
    "memory",
    "owner.json",
    "package.json",
    "src",
    "test",
    "tsconfig.json",
    "tsconfig.test.json"
  ])
  expect(sources).toEqual([
    "endpoint.ts",
    "errors.ts",
    "headers.ts",
    "index.ts",
    "json.ts",
    "message.ts",
    "metadata.ts",
    "middleware.ts",
    "options.ts",
    "provider.ts",
    "testing.ts",
    "transport-info.ts",
    "types.ts"
  ])
  expect(tests).toEqual([
    "conformance.test.ts",
    "coverage-contract.ts",
    "endpoint.test.ts",
    "errors.test.ts",
    "message.test.ts",
    "metadata-wire.test.ts",
    "middleware.test.ts",
    "negative-types.ts",
    "options.test.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "runtime",
    "smoke",
    "source-policy.test.ts",
    "transport-info.test.ts"
  ])
})

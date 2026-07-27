import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package-owned JSON contract. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("publishes the scoped create package and exact create-likego binary", async () => {
  expect(await json("package.json")).toEqual({
    $schema: "https://json.schemastore.org/package.json",
    name: "@likego/create",
    version: "0.0.1",
    description: "Minimal Node CLI for creating a runnable LikeGo internal unary service.",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    publishConfig: { directory: "dist", access: "public" },
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    bin: { "create-likego": "./dist/cli.js" },
    engines: { node: ">=24.18.0" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      test: "bun test --isolate --no-orphans test/*.test.ts",
      "test:coverage":
        "bun test --isolate --no-orphans test/*.test.ts --coverage --coverage-reporter=lcov --coverage-dir .artifacts/coverage && bun test/coverage-contract.ts",
      typecheck: "tsc -p tsconfig.test.json --pretty false"
    },
    dependencies: {
      "@likego/core": "0.0.1",
      "@likego/server": "0.0.1",
      "@likego/transport": "0.0.1",
      "@likego/transport-http": "0.0.1"
    },
    devDependencies: { "@types/node": "26.1.1" },
    license: "MIT"
  })
})

test("declares one finite Node scaffold capability without resident resources", async () => {
  expect(await json("capability.json")).toEqual({
    schemaVersion: 2,
    package: "@likego/create",
    packageKind: "integration",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "integration",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["node-filesystem", "scaffold"],
        runtimes: [
          {
            runtime: "node",
            lane: "lts",
            minimumVersion: "24.18.0",
            testedVersions: ["24.18.0"],
            terminalObservability: "not-applicable"
          },
          {
            runtime: "node",
            lane: "current",
            minimumVersion: "26.5.0",
            testedVersions: ["26.5.0"],
            terminalObservability: "not-applicable"
          }
        ]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/create",
    resources: []
  })
})

test("documents the internal unary boundary and intentionally omitted scope", async () => {
  const readme = await readFile(join(Root, "README.md"), "utf8")
  expect(readme).toContain("内部 unary 微服务")
  expect(readme).toContain("LIKEGO_READY=")
  expect(readme).toContain("CURL=")
  expect(readme).toContain("不是 `@likego/web` 页面")
  expect(readme).toContain("不包含交互 prompt")
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
    "owner.json",
    "package.json",
    "src",
    "test",
    "tsconfig.json",
    "tsconfig.test.json"
  ])
  expect(sources).toEqual(["cli-run.ts", "cli.ts", "index.ts", "project.ts", "templates.ts"])
  expect(tests).toEqual([
    "cli.test.ts",
    "coverage-contract.ts",
    "create.test.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "source-policy.test.ts"
  ])
})

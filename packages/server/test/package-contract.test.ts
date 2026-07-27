import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package-owned JSON contract. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("publishes one side-effect-free portable server package root", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/server",
    version: expect.any(String),
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String),
      "@likego/metadata": expect.any(String),
      "@likego/resilience": expect.any(String),
      "@likego/transport": expect.any(String)
    },
    devDependencies: {
      "@likego/transport-memory": "workspace:*"
    },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      test: "bun test --isolate --no-orphans test/*.test.ts",
      "test:coverage":
        "bun test --isolate --no-orphans test/*.test.ts --coverage --coverage-reporter=lcov --coverage-dir .artifacts/coverage && bun test/coverage-contract.ts",
      typecheck: "tsc -p tsconfig.test.json --pretty false"
    }
  })
  expect(await json("tsconfig.json")).toMatchObject({
    references: [
      { path: "../context" },
      { path: "../core" },
      { path: "../metadata" },
      { path: "../resilience" },
      { path: "../transport" }
    ]
  })
})

test("declares the resident transport listener owned by Server", async () => {
  const capability = await json("capability.json")
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/server",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["transport-listener"],
        capabilities: ["server"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/server",
    resources: [
      {
        id: "transport-listener",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})

test("documents operation middleware and its shared rate limiter boundary", async () => {
  const readme = await readFile(join(Root, "README.md"), "utf8")
  expect(readme).toContain('use("catalog/*"')
  expect(readme).toContain("精确 selector")
  expect(readme).toContain("最长前缀")
  expect(readme).toContain("rateLimitMiddleware")
  expect(readme).toContain("共享一个 limiter")
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
  expect(sources).toEqual(["index.ts"])
  expect(tests).toEqual([
    "coverage-contract.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "server.test.ts",
    "source-policy.test.ts"
  ])
})

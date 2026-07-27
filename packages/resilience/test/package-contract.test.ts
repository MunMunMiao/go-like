import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

test("manifest publishes only the built side-effect-free package root", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))

  expect(manifest).toMatchObject({
    name: "@likego/resilience",
    version: expect.any(String),
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    dependencies: { "@likego/context": expect.any(String) }
  })
  expect(Object.keys(manifest.exports)).toEqual(["."])
  expect(manifest.exports["."]).toBe("./src/index.ts")
})

test("package shell, production source, and tests match the reviewed inventory", async () => {
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
    "owner.json",
    "package.json",
    "src",
    "test",
    "tsconfig.json",
    "tsconfig.test.json"
  ])
  expect(sources).toEqual([
    "circuit.ts",
    "errors.ts",
    "index.ts",
    "internal.ts",
    "limiter.ts",
    "retry.ts",
    "types.ts"
  ])
  expect(tests).toEqual([
    "backoff.test.ts",
    "circuit.test.ts",
    "coverage-contract.ts",
    "errors.test.ts",
    "helpers.ts",
    "internal.test.ts",
    "limiter.test.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "retry.test.ts",
    "smoke",
    "source-policy.test.ts"
  ])
})

test("capability and owner records describe a portable non-resident primitive package", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const capability = JSON.parse(await readFile(join(packageRoot, "capability.json"), "utf8"))
  const owner = JSON.parse(await readFile(join(packageRoot, "owner.json"), "utf8"))

  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/resilience",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["resilience"]
      }
    }
  })
  expect(
    capability.exports["."].runtimes.map(
      (runtime: { runtime: string; testedVersions: string[] }) => {
        return [runtime.runtime, runtime.testedVersions]
      }
    )
  ).toEqual([
    ["bun", ["1.3.14"]],
    ["node", ["24.18.0"]],
    ["node", ["26.5.0"]],
    ["deno", ["2.9.4"]]
  ])
  expect(
    capability.exports["."].runtimes.every((runtime: { terminalObservability: string }) => {
      return runtime.terminalObservability === "not-applicable"
    })
  ).toBe(true)
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/resilience",
    resources: []
  })
})

test("package smoke imports only the package-name export", async () => {
  const smoke = await readFile(join(import.meta.dir, "smoke", "package-smoke.ts"), "utf8")

  expect(smoke).toContain('from "@likego/resilience"')
  expect(smoke).not.toContain("/dist/")
  expect(smoke).not.toContain("../src/")
})

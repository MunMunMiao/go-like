import { expect, test } from "bun:test"

const PackageRoot = `${import.meta.dir}/..`

/** Reads one package-local JSON contract as untrusted data. */
async function json(path: string): Promise<unknown> {
  return await Bun.file(`${PackageRoot}/${path}`).json()
}

test("declares the exact Winston adapter package contract", async () => {
  expect(await json("package.json")).toEqual({
    $schema: "https://json.schemastore.org/package.json",
    name: "@likego/winston",
    version: expect.any(String),
    description: "Native Winston lifecycle and request logging adapters for LikeGo.",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    publishConfig: { directory: "dist", access: "public" },
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      test: "bun test --isolate --no-orphans test/*.test.ts",
      "test:coverage":
        "bun test --isolate --no-orphans test/*.test.ts --coverage --coverage-reporter=lcov --coverage-dir .artifacts/coverage && bun test/coverage-contract.ts",
      typecheck: "tsc -p tsconfig.test.json --pretty false",
      "smoke:bun": "bun test/smoke/runtime-smoke.ts",
      "smoke:node": "tsx test/smoke/runtime-smoke.ts"
    },
    dependencies: {
      "@likego/broker": expect.any(String),
      "@likego/client": expect.any(String),
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String),
      "@likego/server": expect.any(String),
      "@likego/transport": expect.any(String),
      "@likego/web": expect.any(String),
      "@types/node": "26.1.1",
      winston: "3.19.0"
    },
    license: "MIT"
  })
})

test("declares the split native logger data-plane and lifecycle ownership", async () => {
  expect(await json("capability.json")).toEqual({
    schemaVersion: 2,
    package: "@likego/winston",
    packageKind: "integration",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["logger"],
        capabilities: ["broker", "client", "logging", "server", "web"],
        runtimes: [
          {
            runtime: "bun",
            lane: "exact",
            minimumVersion: "1.3.14",
            testedVersions: ["1.3.14"],
            terminalObservability: "observable"
          },
          {
            runtime: "node",
            lane: "lts",
            minimumVersion: "24.18.0",
            testedVersions: ["24.18.0"],
            terminalObservability: "observable"
          },
          {
            runtime: "node",
            lane: "current",
            minimumVersion: "26.5.0",
            testedVersions: ["26.5.0"],
            terminalObservability: "observable"
          }
        ]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/winston",
    resources: [
      {
        id: "logger",
        owner: "application-owned",
        exposure: "native-borrowed",
        stopContract: "likego-owned"
      }
    ]
  })
})

test("contains only the intended production source inventory", async () => {
  const sourceFiles: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({
    cwd: PackageRoot,
    onlyFiles: true
  })) {
    sourceFiles.push(file)
  }
  sourceFiles.sort()
  expect(sourceFiles).toEqual([
    "src/errors.ts",
    "src/index.ts",
    "src/logging.ts",
    "src/server.ts",
    "src/types.ts"
  ])
})

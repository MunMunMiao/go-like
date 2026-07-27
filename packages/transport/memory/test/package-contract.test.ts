import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

const PortableRuntimeRows = [
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
  },
  {
    runtime: "deno",
    lane: "exact",
    minimumVersion: "2.9.4",
    testedVersions: ["2.9.4"],
    terminalObservability: "observable"
  }
]

test("publishes one portable resident memory transport package", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()
  const owner = await Bun.file(`${root}/owner.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/transport-memory",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@likego/context": "0.0.1",
      "@likego/metadata": "0.0.1",
      "@likego/transport": "0.0.1"
    }
  })
  expect(capability).toEqual({
    schemaVersion: 2,
    package: "@likego/transport-memory",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["memory-client", "memory-listener"],
        capabilities: ["transport"],
        runtimes: PortableRuntimeRows
      }
    }
  })
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/transport-memory",
    resources: [
      {
        id: "memory-client",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      },
      {
        id: "memory-listener",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})

test("package shell, source, and test inventories are exact", async () => {
  const root = `${import.meta.dir}/..`
  const shell = (await readdir(root))
    .filter((entry) => !entry.startsWith(".") && entry !== "dist" && entry !== "node_modules")
    .sort()
  const sources = (await readdir(join(root, "src"))).sort()
  const tests = Array.from(
    new Bun.Glob("**/*").scanSync({ cwd: join(root, "test"), onlyFiles: true })
  ).sort()

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
    "index.ts",
    "options.ts",
    "testing.ts",
    "transport-info.ts",
    "transport.ts",
    "types.ts"
  ])
  expect(tests).toEqual([
    "conformance.test.ts",
    "coverage-contract.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "runtime/portable-runtime.ts",
    "smoke/package-smoke.ts",
    "transport.test.ts"
  ])
})

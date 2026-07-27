import { expect, test } from "bun:test"

const PortableRuntimeRows = [
  {
    runtime: "bun",
    lane: "exact",
    minimumVersion: "1.3.14",
    testedVersions: ["1.3.14"],
    terminalObservability: "not-applicable"
  },
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
  },
  {
    runtime: "deno",
    lane: "exact",
    minimumVersion: "2.9.4",
    testedVersions: ["2.9.4"],
    terminalObservability: "not-applicable"
  }
]

test("package shell and manifests pin the portable Context contract", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${packageRoot}/package.json`).json()
  const capability = await Bun.file(`${packageRoot}/capability.json`).json()
  const owner = await Bun.file(`${packageRoot}/owner.json`).json()
  const sources: string[] = []
  for await (const path of new Bun.Glob("*.ts").scan({
    cwd: `${packageRoot}/src`,
    onlyFiles: true
  })) {
    sources.push(`src/${path}`)
  }

  expect({
    name: packageJson.name,
    type: packageJson.type,
    module: packageJson.module,
    typings: packageJson.typings,
    sideEffects: packageJson.sideEffects,
    files: packageJson.files,
    exports: packageJson.exports,
    dependencies: packageJson.dependencies
  }).toEqual({
    name: "@likego/context",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    dependencies: undefined
  })
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/context",
    resources: []
  })
  expect(capability).toEqual({
    schemaVersion: 2,
    package: "@likego/context",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["context"],
        runtimes: PortableRuntimeRows
      }
    }
  })
  expect(sources.sort()).toEqual([
    "src/after-func.ts",
    "src/cancel.ts",
    "src/deadline.ts",
    "src/empty.ts",
    "src/errors.ts",
    "src/index.ts",
    "src/internal.ts",
    "src/value.ts"
  ])
})

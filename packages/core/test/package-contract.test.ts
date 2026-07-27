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

const RuntimeHostRows = [
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

test("package shell and manifests pin portable lifecycle and the Node signal option", async () => {
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
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies
  }).toEqual({
    name: "@likego/core",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      ".": "./src/index.ts",
      "./lifecycle": "./src/lifecycle.ts",
      "./node": "./src/node.ts"
    },
    dependencies: {
      "@likego/context": expect.any(String),
      "@likego/registry": expect.any(String),
      "@types/node": "26.1.1"
    },
    devDependencies: {}
  })
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/core",
    resources: [
      {
        id: "runtime-signal-listener",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
  expect(capability).toEqual({
    schemaVersion: 2,
    package: "@likego/core",
    packageKind: "hybrid",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["lifecycle"],
        runtimes: PortableRuntimeRows
      },
      "./lifecycle": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["lifecycle"],
        runtimes: PortableRuntimeRows
      },
      "./node": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["runtime-signal-listener"],
        capabilities: ["lifecycle"],
        runtimes: RuntimeHostRows
      }
    }
  })
  expect(sources.sort()).toEqual(["src/app.ts", "src/index.ts", "src/lifecycle.ts", "src/node.ts"])
})

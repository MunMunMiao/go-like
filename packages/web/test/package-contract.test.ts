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

test("package shell and manifests pin the hybrid standard Web bridge", async () => {
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
    name: "@likego/web",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      ".": "./src/index.ts",
      "./health": "./src/health.ts",
      "./node": "./src/node.ts"
    },
    dependencies: {
      "@hono/node-server": "2.0.11",
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String),
      "@likego/health": expect.any(String),
      "@types/node": "26.1.1"
    }
  })
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/web",
    resources: [
      {
        id: "node-server",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/web",
    packageKind: "hybrid",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["web"],
        runtimes: PortableRuntimeRows
      },
      "./health": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["health", "web"],
        runtimes: PortableRuntimeRows
      },
      "./node": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["node-server"],
        capabilities: ["server", "web"]
      }
    }
  })
  expect(sources.sort()).toEqual([
    "src/context.ts",
    "src/health.ts",
    "src/index.ts",
    "src/node-errors.ts",
    "src/node-server.ts",
    "src/node.ts"
  ])
})

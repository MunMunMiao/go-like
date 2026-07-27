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

test("publishes one portable non-resident metadata package", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()
  const owner = await Bun.file(`${root}/owner.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/metadata",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    dependencies: { "@likego/context": "0.0.1" }
  })
  expect(capability).toEqual({
    schemaVersion: 2,
    package: "@likego/metadata",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["metadata"],
        runtimes: PortableRuntimeRows
      }
    }
  })
  expect(owner).toEqual({ schemaVersion: 1, package: "@likego/metadata", resources: [] })
})

test("package shell and source inventory are exact", async () => {
  const root = `${import.meta.dir}/..`
  const shell: string[] = []
  const sources: string[] = []
  for await (const path of new Bun.Glob("*").scan({ cwd: root, onlyFiles: true })) shell.push(path)
  for await (const path of new Bun.Glob("*.ts").scan({ cwd: `${root}/src`, onlyFiles: true })) {
    sources.push(path)
  }

  expect(shell.sort()).toEqual([
    "LICENSE",
    "README.md",
    "bunfig.toml",
    "capability.json",
    "owner.json",
    "package.json",
    "tsconfig.json",
    "tsconfig.test.json"
  ])
  expect(sources).toEqual(["index.ts"])
})

test("README documents explicit and conflict-safe downstream propagation", async () => {
  const readme = await Bun.file(`${import.meta.dir}/../README.md`).text()

  expect(readme).toContain("`propagateToClientContext(ctx, options?)`")
  expect(readme).toContain("只从当前 server metadata")
  expect(readme).toContain("已有 client metadata 在同名冲突时")
  expect(readme).toContain("默认不传播任何 key")
  expect(readme).toContain("空 prefix 和其他非法规则会立即被拒绝")
})

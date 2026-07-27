import { expect, test } from "bun:test"

test("package publishes portable Store and provider entries with exact dependencies", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const tsconfig = await Bun.file(`${root}/tsconfig.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/store",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      ".": "./src/index.ts",
      "./provider": "./src/provider.ts"
    },
    dependencies: { "@likego/context": "0.0.1" }
  })
  expect(tsconfig.references).toEqual([{ path: "../context" }])
})

test("package shell and manifests declare non-resident Store entries", async () => {
  const root = `${import.meta.dir}/..`
  const owner = await Bun.file(`${root}/owner.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()

  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/store",
    resources: []
  })
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/store",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["store"]
      },
      "./provider": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["store"]
      }
    }
  })
  expect(capability.exports["."].runtimes).toHaveLength(4)
  expect(
    capability.exports["."].runtimes.every(
      ({ terminalObservability }: { terminalObservability: string }) =>
        terminalObservability === "not-applicable"
    )
  ).toBe(true)
})

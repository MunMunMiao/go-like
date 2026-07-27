import { expect, test } from "bun:test"

test("package publishes one portable Broker root with exact dependencies", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const tsconfig = await Bun.file(`${root}/tsconfig.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/broker",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts", "./provider": "./src/provider.ts" },
    dependencies: { "@likego/context": "0.0.1", "@likego/core": "0.0.1" }
  })
  expect(tsconfig.references).toEqual([{ path: "../context" }, { path: "../core" }])
})

test("manifests declare exactly one resident subscription owner", async () => {
  const root = `${import.meta.dir}/..`
  const owner = await Bun.file(`${root}/owner.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()

  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/broker",
    resources: [
      {
        id: "broker-subscription",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/broker",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["broker-subscription"],
        capabilities: ["broker", "server"]
      }
    }
  })
  expect(capability.exports["./provider"]).toMatchObject({
    kind: "portable",
    residency: "non-resident",
    ownerResources: [],
    capabilities: ["broker"]
  })
  expect(
    capability.exports["./provider"].runtimes.every(
      ({ terminalObservability }: { readonly terminalObservability: string }) =>
        terminalObservability === "not-applicable"
    )
  ).toBe(true)
  expect(capability.exports["."].runtimes).toHaveLength(4)
  expect(
    capability.exports["."].runtimes.every(
      ({ terminalObservability }: { readonly terminalObservability: string }) =>
        terminalObservability === "observable"
    )
  ).toBe(true)
})

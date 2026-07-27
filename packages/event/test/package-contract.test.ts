import { expect, test } from "bun:test"

test("package publishes one portable typed Event root with exact dependencies", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const tsconfig = await Bun.file(`${root}/tsconfig.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/event",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@likego/broker": "0.0.1",
      "@likego/context": "0.0.1"
    }
  })
  expect(tsconfig.references).toEqual([{ path: "../broker" }, { path: "../context" }])
})

test("manifests declare one non-resident typed event projection", async () => {
  const root = `${import.meta.dir}/..`
  const owner = await Bun.file(`${root}/owner.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()

  expect(owner).toEqual({ schemaVersion: 1, package: "@likego/event", resources: [] })
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/event",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["broker", "event"]
      }
    }
  })
  expect(capability.exports["."].runtimes).toHaveLength(4)
  expect(
    capability.exports["."].runtimes.every(
      ({ terminalObservability }: { readonly terminalObservability: string }) =>
        terminalObservability === "not-applicable"
    )
  ).toBe(true)
})

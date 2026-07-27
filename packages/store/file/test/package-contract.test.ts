import { expect, test } from "bun:test"

test("package publishes portable root and explicit Node host with exact dependencies", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const tsconfig = await Bun.file(`${root}/tsconfig.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/store-file",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      ".": "./src/index.ts",
      "./node": "./src/node.ts"
    },
    dependencies: {
      "@likego/context": "0.0.1",
      "@likego/core": "0.0.1",
      "@likego/store": "0.0.1"
    },
    devDependencies: { "@types/node": "26.1.1" }
  })
  expect(tsconfig.references).toEqual([
    { path: "../../context" },
    { path: "../../core" },
    { path: ".." }
  ])
})

test("manifests declare separate portable directory and Node lock owners", async () => {
  const root = `${import.meta.dir}/..`
  const owner = await Bun.file(`${root}/owner.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()

  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/store-file",
    resources: [
      {
        id: "file-store-directory",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      },
      {
        id: "node-file-lock",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/store-file",
    packageKind: "hybrid",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["file-store-directory"],
        capabilities: ["store", "store-file"]
      },
      "./node": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["node-file-lock"],
        capabilities: ["store-file", "node-filesystem"]
      }
    }
  })
  expect(
    capability.exports["."].runtimes.map(({ runtime }: { runtime: string }) => runtime)
  ).toEqual(["bun", "node", "node", "deno"])
  expect(
    capability.exports["./node"].runtimes.map(({ runtime }: { runtime: string }) => runtime)
  ).toEqual(["node", "node"])
})

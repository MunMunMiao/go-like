import { expect, test } from "bun:test"

test("package publishes an existing Hono bridge source and build target", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${packageRoot}/package.json`).json()
  const capability = await Bun.file(`${packageRoot}/capability.json`).json()
  const owner = await Bun.file(`${packageRoot}/owner.json`).json()

  expect(packageJson.name).toBe("@likego/hono")
  expect(packageJson.dependencies).toEqual({ "@likego/web": expect.any(String) })
  expect(packageJson.peerDependencies).toEqual({ hono: "4.12.32" })
  expect(packageJson.module).toBe("src/index.ts")
  expect(packageJson.typings).toBe("src/index.ts")
  expect(packageJson.exports["."]).toBe("./src/index.ts")
  expect(await Bun.file(`${packageRoot}/src/index.ts`).exists()).toBe(true)
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/hono",
    packageKind: "integration",
    releaseBlocking: true,
    exports: { ".": { capabilities: ["web"], residency: "non-resident", ownerResources: [] } }
  })
  expect(owner).toEqual({ schemaVersion: 1, package: "@likego/hono", resources: [] })
})

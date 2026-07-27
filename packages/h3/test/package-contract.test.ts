import { expect, test } from "bun:test"

test("package publishes an existing H3 bridge source and build target", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${packageRoot}/package.json`).json()
  const capability = await Bun.file(`${packageRoot}/capability.json`).json()
  const owner = await Bun.file(`${packageRoot}/owner.json`).json()
  const buildConfig = await Bun.file(`${packageRoot}/tsconfig.json`).json()
  const testConfig = await Bun.file(`${packageRoot}/tsconfig.test.json`).json()

  expect(packageJson.name).toBe("@likego/h3")
  expect(packageJson.dependencies).toEqual({ "@likego/web": expect.any(String) })
  expect(packageJson.peerDependencies).toEqual({ h3: "1.15.11" })
  expect(packageJson.module).toBe("src/index.ts")
  expect(packageJson.typings).toBe("src/index.ts")
  expect(packageJson.exports["."]).toBe("./src/index.ts")
  const source = await Bun.file(`${packageRoot}/src/index.ts`).text()
  expect(source).toContain("export type H3Application = App")
  expect(source).toContain('from "h3"')
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/h3",
    packageKind: "integration",
    releaseBlocking: true,
    exports: { ".": { capabilities: ["web"], residency: "non-resident", ownerResources: [] } }
  })
  expect(owner).toEqual({ schemaVersion: 1, package: "@likego/h3", resources: [] })
  expect(buildConfig.compilerOptions.skipLibCheck).toBe(true)
  expect(testConfig.compilerOptions.skipLibCheck).toBe(true)
})

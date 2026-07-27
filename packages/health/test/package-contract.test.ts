import { expect, test } from "bun:test"

test("package publishes only the built root ESM and declarations with exact workspace dependencies", async () => {
  const packageJson = await Bun.file(`${import.meta.dir}/../package.json`).json()
  const tsconfig = await Bun.file(`${import.meta.dir}/../tsconfig.json`).json()

  expect(packageJson.name).toBe("@likego/health")
  expect(packageJson.version).toEqual(expect.any(String))
  expect(packageJson.module).toBe("src/index.ts")
  expect(packageJson.typings).toBe("src/index.ts")
  expect(packageJson.sideEffects).toBe(false)
  expect(packageJson.files).toEqual(["dist"])
  expect(Object.keys(packageJson.exports)).toEqual(["."])
  expect(packageJson.exports["."]).toBe("./src/index.ts")
  expect(packageJson.dependencies).toEqual({
    "@likego/context": expect.any(String)
  })
  expect(tsconfig.references).toEqual([{ path: "../context" }])
})

test("package shell, production source, and manifests match the Health contract", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const rootFiles: string[] = []
  const sourceFiles: string[] = []
  for await (const file of new Bun.Glob("*").scan({ cwd: packageRoot, onlyFiles: true })) {
    rootFiles.push(file)
  }
  for await (const file of new Bun.Glob("*.ts").scan({
    cwd: `${packageRoot}/src`,
    onlyFiles: true
  })) {
    sourceFiles.push(file)
  }
  rootFiles.sort()
  sourceFiles.sort()

  expect(rootFiles).toEqual([
    "LICENSE",
    "README.md",
    "bunfig.toml",
    "capability.json",
    "owner.json",
    "package.json",
    "tsconfig.json",
    "tsconfig.test.json"
  ])
  expect(sourceFiles).toEqual(["index.ts", "registry.ts"])

  const owner = await Bun.file(`${packageRoot}/owner.json`).json()
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/health",
    resources: []
  })

  const capability = await Bun.file(`${packageRoot}/capability.json`).json()
  expect(capability.schemaVersion).toBe(2)
  expect(capability.packageKind).toBe("portable")
  expect(capability.stability).toBe("provisional")
  expect(capability.releaseBlocking).toBe(true)
  expect(capability.exports["."].kind).toBe("portable")
  expect(capability.exports["."].residency).toBe("non-resident")
  expect(capability.exports["."].ownerResources).toEqual([])
  expect(capability.exports["."].capabilities).toEqual(["health"])
  expect(capability.exports["."].runtimes).toHaveLength(4)
  expect(
    capability.exports["."].runtimes.every((row: { terminalObservability: string }) => {
      return row.terminalObservability === "not-applicable"
    })
  ).toBe(true)
})

test("package smoke resolves the package-name export without importing a relative build artifact", async () => {
  const smokeSource = await Bun.file(`${import.meta.dir}/smoke/package-smoke.ts`).text()

  expect(smokeSource).toContain('from "@likego/health"')
  expect(smokeSource).not.toContain("../../dist/")
})

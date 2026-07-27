import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

import { expect, test } from "bun:test"

import { createProject } from "../src/index"
import { createProjectWithFilesystem } from "../src/project"

/** Creates one isolated parent and removes it after the assertion. */
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "likego-create-test-"))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("creates one complete internal unary service after atomically claiming its directory", async () => {
  await withRoot(async (root) => {
    const target = join(root, "orders-service")
    const created = await createProject(target)

    expect(created).toEqual({ name: "orders-service", directory: target })
    expect(Object.isFrozen(created)).toBe(true)
    expect((await readdir(root)).sort()).toEqual(["orders-service"])
    expect((await readdir(target)).sort()).toEqual([
      ".gitignore",
      "README.md",
      "package.json",
      "src",
      "test",
      "tsconfig.json"
    ])
    expect((await readdir(join(target, "src"))).sort()).toEqual([
      "contract.ts",
      "main.ts",
      "service.ts"
    ])
    expect(await readdir(join(target, "test"))).toEqual(["service.test.ts"])

    const createManifest = JSON.parse(
      await readFile(join(import.meta.dir, "../package.json"), "utf8")
    )
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"))
    expect(manifest).toEqual({
      name: "orders-service",
      version: "0.0.1",
      private: true,
      packageManager: "bun@1.3.14",
      type: "module",
      scripts: {
        start: "node src/main.ts",
        test: "node --test test/service.test.ts",
        typecheck: "tsc -p tsconfig.json --pretty false"
      },
      dependencies: createManifest.dependencies,
      devDependencies: {
        "@types/node": "26.1.1",
        typescript: "7.0.2"
      },
      engines: { node: ">=24.18.0" }
    })
    expect(await readFile(join(target, "src/main.ts"), "utf8")).toContain("newNodeHTTPTransport()")
    expect(await readFile(join(target, "src/main.ts"), "utf8")).toContain("LIKEGO_READY=")
    expect(await readFile(join(target, "README.md"), "utf8")).toContain(
      "Likego-Service: orders-service.greeter"
    )
    expect((await stat(target)).isDirectory()).toBe(true)
  })
})

test("rejects existing targets, invalid parents, and non-kebab project names", async () => {
  await withRoot(async (root) => {
    const existing = join(root, "existing-service")
    await writeFile(existing, "caller-owned")
    await expect(createProject(existing)).rejects.toThrow("target directory already exists")
    expect(await readFile(existing, "utf8")).toBe("caller-owned")

    const parentFile = join(root, "parent-file")
    await writeFile(parentFile, "not a directory")
    await expect(createProject(join(parentFile, "valid-service"))).rejects.toThrow(
      "target parent must be a directory"
    )
    await expect(createProject(join(root, "missing", "valid-service"))).rejects.toBeInstanceOf(
      Error
    )

    for (const name of [
      "Uppercase",
      "snake_case",
      "-leading",
      "trailing-",
      "two--dashes",
      "naïve"
    ]) {
      await expect(createProject(join(root, name))).rejects.toThrow(
        "project name must use strict lower-kebab case"
      )
    }
    await expect(createProject("")).rejects.toThrow("target directory must be a non-empty string")
    await expect(Reflect.apply(createProject, undefined, [null])).rejects.toThrow(
      "target directory must be a non-empty string"
    )
  })
})

test("preserves claim failure identity and a partial target after post-claim failure", async () => {
  await withRoot(async (root) => {
    const claimFailure = new Error("claim denied")
    await expect(
      createProjectWithFilesystem(join(root, "claim-service"), {
        mkdir: async () => {
          throw claimFailure
        },
        writeFile
      })
    ).rejects.toBe(claimFailure)

    const target = join(root, "partial-service")
    const writeFailure = new Error("write denied")
    let mkdirCalls = 0
    await expect(
      createProjectWithFilesystem(target, {
        mkdir: async (path) => {
          mkdirCalls += 1
          if (mkdirCalls === 2) throw writeFailure
          await mkdir(path)
        },
        writeFile
      })
    ).rejects.toBe(writeFailure)
    expect((await stat(target)).isDirectory()).toBe(true)
    expect(await readdir(target)).toEqual([])
  })
})

test("copies non-default LikeGo dependency versions from the located create manifest", async () => {
  await withRoot(async (root) => {
    const packageRoot = join(root, "package-layout")
    await mkdir(join(packageRoot, "src"), { recursive: true })
    const dependencies = {
      "@likego/core": "9.8.7",
      "@likego/server": "9.8.7",
      "@likego/transport": "9.8.7",
      "@likego/transport-http": "9.8.7"
    }
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@likego/create",
        version: "9.8.7",
        dependencies
      })
    )
    const target = join(root, "versioned-service")
    await createProjectWithFilesystem(
      target,
      { mkdir, writeFile },
      pathToFileURL(join(packageRoot, "src", "project.ts")).href
    )

    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"))
    expect(manifest.version).toBe("0.0.1")
    expect(manifest.dependencies).toEqual(dependencies)

    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@likego/create", version: "9.8.7" })
    )
    await expect(
      createProjectWithFilesystem(
        join(root, "missing-dependencies-service"),
        { mkdir, writeFile },
        pathToFileURL(join(packageRoot, "src", "project.ts")).href
      )
    ).rejects.toThrow("@likego/create package dependencies are unavailable")

    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@likego/create",
        version: "9.8.7",
        dependencies: { ...dependencies, "@likego/core": "" }
      })
    )
    await expect(
      createProjectWithFilesystem(
        join(root, "missing-core-version-service"),
        { mkdir, writeFile },
        pathToFileURL(join(packageRoot, "src", "project.ts")).href
      )
    ).rejects.toThrow("@likego/create package dependency must use an exact semver: @likego/core")

    for (const [index, invalidVersion] of [
      "workspace:*",
      "^9.8.7",
      "9.8",
      "9.8.7+build.1"
    ].entries()) {
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@likego/create",
          version: "9.8.7",
          dependencies: { ...dependencies, "@likego/core": invalidVersion }
        })
      )
      await expect(
        createProjectWithFilesystem(
          join(root, `invalid-version-${index}-service`),
          { mkdir, writeFile },
          pathToFileURL(join(packageRoot, "src", "project.ts")).href
        )
      ).rejects.toThrow("@likego/create package dependency must use an exact semver: @likego/core")
    }
  })
})

test("typechecks a generated service against the current workspace packages", async () => {
  const artifacts = join(import.meta.dir, "../.artifacts")
  await mkdir(artifacts, { recursive: true })
  const root = await mkdtemp(join(artifacts, "generated-typecheck-"))
  try {
    const target = join(root, "typed-service")
    await createProject(target)
    const child = Bun.spawn({
      cmd: [
        join(import.meta.dir, "../../../node_modules/.bin/tsc"),
        "-p",
        join(target, "tsconfig.json"),
        "--pretty",
        "false"
      ],
      cwd: target,
      stdout: "pipe",
      stderr: "pipe"
    })
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    expect({ code, output, error }).toEqual({ code: 0, output: "", error: "" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

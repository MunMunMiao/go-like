import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { VerifyBunRuntime, VerifyWorkspace } from "./verify-workspace.ts"

const Roots: string[] = []
const RootScripts = {
  build: "tsc -b --pretty false",
  typecheck: "tsc -b --pretty false && tsc -p tsconfig.test.json --pretty false",
  test: "bun test --isolate --no-orphans",
  "test:coverage": "bun test --isolate --no-orphans --coverage",
  "verify:workspace": "bun scripts/verify-workspace.cli.ts",
  verify: "bun run verify:workspace && bun run typecheck && bun run test:coverage"
} as const
const ValidRootManifest = {
  name: "likego",
  private: true,
  type: "module",
  packageManager: "bun@1.3.14",
  workspaces: ["packages/*", "adapters/*", "examples/*"],
  scripts: RootScripts,
  devDependencies: {
    "@types/bun": "1.3.14",
    typescript: "7.0.2"
  }
} as const
const CliPath = fileURLToPath(new URL("./verify-workspace.cli.ts", import.meta.url))

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function Fixture(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-workspace-"))
  Roots.push(root)
  await Bun.write(join(root, "package.json"), `${JSON.stringify(manifest)}\n`)
  return root
}

async function RunVerifier(root: string): Promise<{
  readonly ExitCode: number
  readonly Stdout: string
  readonly Stderr: string
}> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, CliPath],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [ExitCode, Stdout, Stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text()
  ])
  return { ExitCode, Stdout, Stderr }
}

describe("VerifyWorkspace", () => {
  test("rejects Bun runtime version drift", () => {
    expect(VerifyBunRuntime("1.3.13")).toEqual({
      Code: "BUN_RUNTIME",
      Path: "Bun.version",
      Message: "Bun runtime must be exactly 1.3.14 (observed 1.3.13)"
    })
    expect(VerifyBunRuntime("1.3.14")).toBeNull()
  })

  test("accepts the repository root", async () => {
    expect(await VerifyWorkspace(fileURLToPath(new URL("..", import.meta.url)))).toEqual([])
  })

  test("rejects root toolchain and lockfile drift", async () => {
    const root = await Fixture({
      name: "wrong",
      private: false,
      type: "commonjs",
      packageManager: "npm@latest",
      workspaces: ["packages/**"],
      scripts: RootScripts,
      devDependencies: {
        "@types/bun": "^1.3.14",
        typescript: "latest"
      }
    })
    await Bun.write(join(root, "package-lock.json"), "{}\n")

    expect((await VerifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "ROOT_NAME",
      "ROOT_PRIVATE",
      "ROOT_TYPE",
      "PACKAGE_MANAGER",
      "WORKSPACES",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "BUN_LOCK_MISSING",
      "FOREIGN_LOCKFILE"
    ])
  })

  test("rejects invalid workspace manifests and floating dependencies", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "packages", "bad"), { recursive: true })
    await Bun.write(join(root, "packages", "bad", "package.json"), JSON.stringify({
      name: "bad",
      version: "0.0.0",
      private: false,
      type: "commonjs",
      dependencies: {
        external: "^1.0.0",
        internal: "workspace:^"
      }
    }))

    expect((await VerifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "WORKSPACE_NAME",
      "WORKSPACE_VERSION",
      "WORKSPACE_TYPE",
      "WORKSPACE_EXPORTS",
      "DEPENDENCY_SPECIFIER",
      "DEPENDENCY_SPECIFIER"
    ])
  })

  test("rejects dependency specifiers that contradict workspace ownership", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "packages", "app"), { recursive: true })
    await mkdir(join(root, "packages", "library"), { recursive: true })
    await Bun.write(join(root, "packages", "app", "package.json"), JSON.stringify({
      name: "@likego/app",
      version: "0.1.0",
      type: "module",
      exports: {
        ".": "./dist/index.js"
      },
      dependencies: {
        "@likego/library": "1.2.3",
        external: "workspace:*"
      }
    }))
    await Bun.write(join(root, "packages", "library", "package.json"), JSON.stringify({
      name: "@likego/library",
      version: "0.1.0",
      type: "module",
      exports: {
        ".": "./dist/index.js"
      }
    }))

    expect((await VerifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "DEPENDENCY_SPECIFIER",
      "DEPENDENCY_SPECIFIER"
    ])
  })

  test("rejects missing, unknown, and drifted root scripts", async () => {
    const invalidScripts: readonly unknown[] = [
      undefined,
      true,
      { ...RootScripts, unknown: "bun test" },
      { ...RootScripts, test: true },
      { ...RootScripts, test: "node --test" }
    ]

    for (const scripts of invalidScripts) {
      const root = await Fixture({ ...ValidRootManifest, scripts })
      await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
      expect((await VerifyWorkspace(root)).map((issue) => issue.Code)).toEqual(["ROOT_SCRIPTS"])
    }
  })

  test("CLI exits non-zero with a stable issue for an invalid fixture cwd", async () => {
    const root = await Fixture({
      ...ValidRootManifest,
      scripts: { ...RootScripts, test: "node --test" }
    })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")

    expect(await RunVerifier(root)).toEqual({
      ExitCode: 1,
      Stdout: "",
      Stderr: "ROOT_SCRIPTS package.json: scripts must exactly match the required root scripts\n"
    })
  })

  test("rejects floating and workspace root dependencies", async () => {
    const root = await Fixture({
      ...ValidRootManifest,
      dependencies: {
        exact: "1.2.3"
      },
      devDependencies: {
        ...ValidRootManifest.devDependencies,
        floating: "^1.0.0"
      },
      optionalDependencies: {
        workspace: "workspace:*"
      }
    })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")

    expect((await VerifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "DEPENDENCY_SPECIFIER",
      "DEPENDENCY_SPECIFIER"
    ])
  })

  test("rejects legacy root and nested workspace lockfiles", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await Bun.write(join(root, "bun.lockb"), "legacy\n")
    await mkdir(join(root, "packages", "app"), { recursive: true })
    await Bun.write(join(root, "packages", "app", "package.json"), JSON.stringify({
      name: "@likego/app",
      version: "0.1.0",
      type: "module",
      exports: {
        ".": "./dist/index.js"
      }
    }))
    await Bun.write(join(root, "packages", "app", "package-lock.json"), "{}\n")

    expect((await VerifyWorkspace(root)).map(({ Code, Path }) => ({ Code, Path }))).toEqual([
      { Code: "FOREIGN_LOCKFILE", Path: "bun.lockb" },
      { Code: "FOREIGN_LOCKFILE", Path: "packages/app/package-lock.json" }
    ])
  })
})

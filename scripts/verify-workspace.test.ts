import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { VerifyWorkspace } from "./verify-workspace.ts"

const Roots: string[] = []

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function Fixture(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-workspace-"))
  Roots.push(root)
  await Bun.write(join(root, "package.json"), `${JSON.stringify(manifest)}\n`)
  return root
}

describe("VerifyWorkspace", () => {
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
    const root = await Fixture({
      name: "likego",
      private: true,
      type: "module",
      packageManager: "bun@1.3.14",
      workspaces: ["packages/*", "adapters/*", "examples/*"],
      devDependencies: {
        "@types/bun": "1.3.14",
        typescript: "7.0.2"
      }
    })
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
})

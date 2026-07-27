import { join, resolve } from "node:path"

import { defineConfig, type UserConfig } from "tsdown"

import { annotateDist } from "./scripts/annotate-dist"
import { distPackageManifest, packageEntries } from "./scripts/package-dist"
import { discoverWorkspaces } from "./tools/workspaces/discovery"

const repositoryRoot = import.meta.dir

async function manifest(root: string): Promise<unknown> {
  return await Bun.file(join(root, "package.json")).json()
}

async function publishableWorkspaces(): Promise<readonly string[]> {
  return Object.freeze(
    (await discoverWorkspaces(repositoryRoot))
      .filter((workspace) => !workspace.private)
      .map((workspace) => workspace.root)
  )
}

async function publishVersions(): Promise<ReadonlyMap<string, string>> {
  const versions = new Map<string, string>()
  for (const workspace of await discoverWorkspaces(repositoryRoot)) {
    if (workspace.private) continue
    const value = await manifest(join(repositoryRoot, workspace.root))
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("version" in value) ||
      typeof value.version !== "string"
    ) {
      throw new TypeError(`${workspace.name} package version must be a string`)
    }
    versions.set(workspace.name, value.version)
  }
  return versions
}

const workspaceVersions = publishVersions()

async function packageConfig(cwd: string, value: unknown): Promise<UserConfig> {
  const entry = packageEntries(value)
  for (const source of Object.values(entry)) {
    if (!(await Bun.file(join(cwd, source)).exists())) {
      throw new Error(`package entry is missing: ${join(cwd, source)}`)
    }
  }
  return {
    clean: true,
    copy: ["README.md", "LICENSE"],
    cwd,
    deps: { neverBundle: [/^@likego\//, /^node:/] },
    dts: true,
    entry,
    format: "esm",
    hooks: {
      "build:done": async ({ options }) => {
        await annotateDist(
          options.cwd,
          Object.keys(entry).map((name) => `${name}.js`)
        )
        const packageJson = distPackageManifest(value, await workspaceVersions)
        await Bun.write(
          join(resolve(options.cwd, options.outDir), "package.json"),
          `${JSON.stringify(packageJson, null, 2)}\n`
        )
      }
    },
    inputOptions: {
      resolve: { mainFields: ["module", "main"] }
    },
    outDir: "dist",
    platform: "neutral",
    target: false,
    tsconfig: "tsconfig.json"
  }
}

export default defineConfig(async (inlineConfig) => {
  const cwd = inlineConfig.cwd ?? process.cwd()
  const value = await manifest(cwd)
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "private" in value &&
    value.private === true
  ) {
    return {
      workspace: {
        config: join(repositoryRoot, "tsdown.config.ts"),
        include: Array.from(await publishableWorkspaces())
      }
    }
  }
  return await packageConfig(cwd, value)
})

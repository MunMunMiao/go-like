import { join, posix, resolve } from "node:path"

import { defineConfig, type UserConfig } from "tsdown"

type JsonObject = Record<string, unknown>

const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"] as const
const repositoryUrl = "git+https://github.com/MunMunMiao/go-like.git"

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function sourceEntry(value: unknown): { readonly output: string; readonly source: string } {
  if (typeof value !== "string" || !value.startsWith("./src/") || !value.endsWith(".ts")) {
    throw new TypeError(`package export must target ./src/*.ts: ${String(value)}`)
  }
  const output = value.slice("./src/".length, -".ts".length)
  if (output.length === 0 || posix.normalize(output) !== output || output.startsWith("../")) {
    throw new TypeError(`package export must stay inside src: ${value}`)
  }
  return Object.freeze({ output, source: value.slice(2) })
}

/** Returns the tsdown entry for every public source export. */
export function packageEntries(value: unknown): Readonly<Record<string, string>> {
  const exports = object(object(value, "package manifest").exports, "package exports")
  if (sourceEntry(exports["."]).output !== "index") {
    throw new TypeError("package root export must target ./src/index.ts")
  }
  const entries: Record<string, string> = {}
  for (const [name, target] of Object.entries(exports)) {
    if (name === "./package.json") continue
    const entry = sourceEntry(target)
    if (entries[entry.output] !== undefined) {
      throw new TypeError(`duplicate package output: ${entry.output}`)
    }
    entries[entry.output] = entry.source
  }
  return Object.freeze(entries)
}

async function workspaceVersion(cwd: string, name: string): Promise<string> {
  const manifestPath = Bun.resolveSync(`${name}/package.json`, cwd)
  const manifest = object(await Bun.file(manifestPath).json(), `${name} package manifest`)
  if (typeof manifest.version !== "string") {
    throw new TypeError(`${name} package version must be a string`)
  }
  return manifest.version
}

async function rewriteWorkspaceDependencies(manifest: JsonObject, cwd: string): Promise<void> {
  for (const field of dependencyFields) {
    if (manifest[field] === undefined) continue
    const dependencies = object(manifest[field], field)
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        dependencies[name] = await workspaceVersion(cwd, name)
      }
    }
    manifest[field] = dependencies
  }
}

function distExport(output: string): JsonObject {
  return {
    types: `./${output}.d.ts`,
    import: `./${output}.js`,
    default: `./${output}.js`
  }
}

/** Produces the package manifest written directly into dist. */
export async function distPackageManifest(value: unknown, cwd: string): Promise<JsonObject> {
  const source = object(value, "package manifest")
  const manifest = structuredClone(source)
  const sourceExports = object(source.exports, "package exports")
  const root = sourceEntry(sourceExports["."])
  const exports: JsonObject = {}
  for (const [name, target] of Object.entries(sourceExports)) {
    if (name === "./package.json") continue
    exports[name] = distExport(sourceEntry(target).output)
  }
  exports["./package.json"] = "./package.json"

  manifest.main = `./${root.output}.js`
  manifest.module = `./${root.output}.js`
  manifest.types = `./${root.output}.d.ts`
  manifest.typings = `./${root.output}.d.ts`
  manifest.exports = exports
  manifest.repository ??= { type: "git", url: repositoryUrl }
  manifest.homepage ??= "https://github.com/MunMunMiao/go-like#readme"
  manifest.bugs ??= { url: "https://github.com/MunMunMiao/go-like/issues" }
  manifest.keywords ??= ["go-like", "microservices", "typescript"]
  delete manifest.scripts
  delete manifest.devDependencies
  delete manifest.private
  delete manifest.files
  if (manifest.publishConfig !== undefined) {
    const publishConfig = object(manifest.publishConfig, "publishConfig")
    manifest.publishConfig = { access: publishConfig.access }
  }
  await rewriteWorkspaceDependencies(manifest, cwd)
  return manifest
}

export default defineConfig(async (inlineConfig): Promise<UserConfig> => {
  const cwd = resolve(inlineConfig.cwd ?? process.cwd())
  const manifest = await Bun.file(join(cwd, "package.json")).json()
  const entry = packageEntries(manifest)
  return {
    clean: true,
    copy: ["README.md", "LICENSE"],
    cwd,
    deps: { neverBundle: [/^@go-like\//, /^node:/] },
    dts: true,
    entry,
    format: "esm",
    hooks: {
      "build:done": async ({ options }) => {
        const output = resolve(options.cwd, options.outDir)
        await Bun.write(
          join(output, "package.json"),
          `${JSON.stringify(await distPackageManifest(manifest, cwd), null, 2)}\n`
        )
      }
    },
    outDir: "dist",
    platform: "neutral",
    target: false,
    tsconfig: "tsconfig.json"
  }
})

import { posix } from "node:path"

type JsonObject = Record<string, unknown>

const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"] as const
const SafeBinCommand = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const RepositoryUrl = "git+https://github.com/MunMunMiao/likego.git"
const Homepage = "https://github.com/MunMunMiao/likego#readme"
const BugsUrl = "https://github.com/MunMunMiao/likego/issues"
const Keywords = Object.freeze(["likego", "microservices", "typescript"])

interface PackageBin {
  readonly command: string | null
  readonly output: string
  readonly published: string
  readonly source: string
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function sourceEntry(value: unknown): { readonly output: string; readonly source: string } {
  if (typeof value !== "string" || !value.startsWith("./src/") || !value.endsWith(".ts")) {
    throw new TypeError(`package export target must be a ./src/*.ts string: ${String(value)}`)
  }
  const output = value.slice("./src/".length, -".ts".length)
  if (output.length === 0) throw new TypeError("package export target must name a source entry")
  return Object.freeze({ output, source: value.slice(2) })
}

function packageBin(command: string | null, value: unknown): PackageBin {
  if (command !== null && !SafeBinCommand.test(command)) {
    throw new TypeError(`package bin command must be a safe bare name: ${command}`)
  }
  if (typeof value !== "string" || !value.startsWith("./dist/") || !value.endsWith(".js")) {
    throw new TypeError(`package bin target must be a ./dist/*.js string: ${String(value)}`)
  }
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    `./${posix.normalize(value.slice(2))}` !== value
  ) {
    throw new TypeError(`package bin target must stay inside ./dist: ${value}`)
  }
  const output = value.slice("./dist/".length, -".js".length)
  if (output.length === 0) throw new TypeError("package bin target must name a JavaScript entry")
  return Object.freeze({
    command,
    output,
    published: `./${output}.js`,
    source: `src/${output}.ts`
  })
}

function packageBins(value: unknown): readonly PackageBin[] {
  if (typeof value === "string") return Object.freeze([packageBin(null, value)])
  return Object.freeze(
    Object.entries(jsonObject(value, "package bin")).map(([command, target]) =>
      packageBin(command, target)
    )
  )
}

export function packageExportOutput(value: unknown): string {
  return sourceEntry(value).output
}

function distExport(output: string): JsonObject {
  return {
    types: `./${output}.d.ts`,
    import: `./${output}.js`,
    default: `./${output}.js`
  }
}

function rewriteWorkspaceDependencies(
  manifest: JsonObject,
  workspaceVersions: ReadonlyMap<string, string>
): void {
  for (const field of dependencyFields) {
    const value = manifest[field]
    if (value === undefined) continue
    const dependencies = jsonObject(value, field)
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) continue
      const version = workspaceVersions.get(name)
      if (version === undefined)
        throw new TypeError(`workspace dependency has no publish version: ${name}`)
      dependencies[name] = version
    }
    manifest[field] = dependencies
  }
}

/** Derives one tsdown bundle entry for every public package export and executable. */
export function packageEntries(value: unknown): Readonly<Record<string, string>> {
  const manifest = jsonObject(value, "package manifest")
  const exports = jsonObject(manifest.exports, "package exports")
  if (sourceEntry(exports["."]).output !== "index") {
    throw new TypeError("package root export must target ./src/index.ts")
  }
  const entries: Record<string, string> = {}
  for (const [name, exported] of Object.entries(exports)) {
    if (name === "./package.json") continue
    const { output, source } = sourceEntry(exported)
    if (entries[output] !== undefined)
      throw new TypeError(`duplicate package output entry: ${output}`)
    entries[output] = source
  }
  if (manifest.bin !== undefined) {
    for (const bin of packageBins(manifest.bin)) {
      const existing = entries[bin.output]
      if (existing !== undefined && existing !== bin.source) {
        throw new TypeError(`duplicate package output entry: ${bin.output}`)
      }
      entries[bin.output] = bin.source
    }
  }
  return Object.freeze(entries)
}

/** Creates the manifest that is packed directly from a package's dist directory. */
export function distPackageManifest(
  value: unknown,
  workspaceVersions: ReadonlyMap<string, string>
): JsonObject {
  const source = jsonObject(value, "package manifest")
  const manifest = structuredClone(source)
  const sourceExports = jsonObject(source.exports, "package exports")
  const rootExport = sourceExports["."]
  if (rootExport === undefined) throw new TypeError("package exports must contain a root export")
  const root = sourceEntry(rootExport)
  const runtime = `./${root.output}.js`
  const types = `./${root.output}.d.ts`
  const rewrittenExports: JsonObject = {}
  for (const [name, exported] of Object.entries(sourceExports)) {
    if (name === "./package.json") continue
    rewrittenExports[name] = distExport(sourceEntry(exported).output)
  }
  rewrittenExports["./package.json"] = "./package.json"
  manifest.main = runtime
  manifest.module = runtime
  manifest.typings = types
  manifest.types = types
  manifest.exports = rewrittenExports
  manifest.repository ??= { type: "git", url: RepositoryUrl }
  manifest.homepage ??= Homepage
  manifest.bugs ??= { url: BugsUrl }
  manifest.keywords ??= Keywords
  if (source.bin !== undefined) {
    if (typeof source.bin === "string") {
      manifest.bin = packageBin(null, source.bin).published
    } else {
      const rewrittenBins: JsonObject = {}
      for (const [command, target] of Object.entries(jsonObject(source.bin, "package bin"))) {
        rewrittenBins[command] = packageBin(command, target).published
      }
      manifest.bin = rewrittenBins
    }
  }
  delete manifest.scripts
  delete manifest.devDependencies
  delete manifest.private
  delete manifest.files
  if (manifest.publishConfig !== undefined) {
    const publishConfig = jsonObject(manifest.publishConfig, "publishConfig")
    if (publishConfig.access !== "public" && publishConfig.access !== "restricted") {
      throw new TypeError("publishConfig.access must be public or restricted")
    }
    manifest.publishConfig = { access: publishConfig.access }
  }
  delete manifest.unpkg
  delete manifest.jsdelivr
  rewriteWorkspaceDependencies(manifest, workspaceVersions)
  return manifest
}

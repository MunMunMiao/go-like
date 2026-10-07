import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink
} from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

interface PromClientModule {
  readonly Counter: new (options: {
    readonly name: string
    readonly help: string
    readonly registers: readonly unknown[]
  }) => { inc(): void }
  readonly Registry: new () => {
    clear(): void
    getMetricsAsJSON(): Promise<readonly unknown[]>
  }
}

interface PackageJson {
  readonly version: string
}

interface PrometheusModule {
  createPrometheusHandler(registry: unknown): (request: Request) => Promise<Response>
}

interface StagedBuiltModules {
  readonly directory: string
  readonly entryHref: string
}

interface PendingPackage {
  readonly name: string
  readonly fromDirectory: string
  readonly entry: boolean
}

const PackageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EntryName = "@go-like/prometheus"

/** Returns a Node error code when the failure exposes one. */
function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined
  return typeof value.code === "string" ? value.code : undefined
}

/** Requires one JSON object and rejects arrays and scalars. */
function jsonObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Readonly<Record<string, unknown>>
}

/** Reads one package manifest object. */
async function readManifest(
  directory: string,
  label: string
): Promise<Readonly<Record<string, unknown>>> {
  const parsed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
  return jsonObject(parsed, label)
}

/** Collects every string nested in one manifest value. */
function manifestStrings(value: unknown): readonly string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(manifestStrings)
  if (typeof value !== "object" || value === null) return []
  return Object.values(value).flatMap(manifestStrings)
}

/** Returns dependency names declared by one built package manifest. */
function dependencyNames(
  manifest: Readonly<Record<string, unknown>>,
  label: string
): readonly string[] {
  if (manifest.dependencies === undefined) return []
  return Object.keys(jsonObject(manifest.dependencies, `${label} dependencies`))
}

/** Returns the built root import path relative to the package directory. */
function rootRelativeImport(name: string, manifest: Readonly<Record<string, unknown>>): string {
  const exported = jsonObject(manifest.exports, `${name} exports`)
  const root = exported["."]
  const target = typeof root === "string" ? root : jsonObject(root, `${name} root export`).import
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new Error(`${name} dist root import is missing`)
  }
  const relativePath = target.slice("./".length)
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("../") ||
    relativePath.includes("/../")
  ) {
    throw new Error(`${name} dist root import escapes the package`)
  }
  return relativePath
}

/** Rejects a dist manifest that still points at workspace TypeScript source. */
function assertBuiltManifest(name: string, manifest: Readonly<Record<string, unknown>>): string {
  if (manifest.name !== name) {
    throw new Error(`${name} dist package name is ${String(manifest.name)}`)
  }
  if (manifest.type !== "module") throw new Error(`${name} dist must be an ESM package`)
  const sourceExport = manifestStrings(manifest.exports).find(
    (entry) =>
      /(?:^|\/)src(?:\/|$)/u.test(entry) ||
      (/\.[cm]?ts$/u.test(entry) && !/\.d\.[cm]?ts$/u.test(entry))
  )
  if (sourceExport !== undefined) {
    throw new Error(`${name} dist exports workspace source instead of built artifacts`)
  }
  return rootRelativeImport(name, manifest)
}

/** Returns the temporary node_modules path for one package name. */
function packageInstallPath(root: string, name: string): string {
  if (!PackageNamePattern.test(name)) throw new Error(`invalid package name ${name}`)
  return join(root, "node_modules", ...name.split("/"))
}

/** Resolves one installed package entry, including packages that export no main file. */
function resolveInstalled(fromDirectory: string, name: string): string {
  const resolver = createRequire(join(fromDirectory, "package.json"))
  try {
    return resolver.resolve(name)
  } catch (error: unknown) {
    if (errorCode(error) !== "MODULE_NOT_FOUND") throw error
    return resolver.resolve(`${name}/package.json`)
  }
}

/** Walks upward from a resolved file to the directory whose manifest owns that name. */
async function owningPackageDirectory(
  resolved: string,
  name: string,
  fromDirectory: string
): Promise<string> {
  let current = dirname(resolved)
  for (;;) {
    try {
      const manifest = jsonObject(
        JSON.parse(await readFile(join(current, "package.json"), "utf8")),
        `${name} package manifest`
      )
      if (manifest.name === name) return current
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    const parent = dirname(current)
    if (parent === current) throw new Error(`cannot locate package ${name} from ${fromDirectory}`)
    current = parent
  }
}

/**
 * Links one built file into the stage.
 * Node realpath follows a directory symlink back to the workspace package, then resolves
 * `@go-like/*` from source. A hardlink keeps the module path inside the temporary tree.
 */
async function linkBuiltFile(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination)
  } catch (error: unknown) {
    if (errorCode(error) !== "EXDEV") throw error
    await copyFile(source, destination)
  }
}

/** Reproduces one physical dist tree with hardlinks so Node resolves built artifacts. */
async function linkTree(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source)
  if (metadata.isSymbolicLink())
    throw new Error(`built package contains a symbolic link: ${source}`)
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const name of await readdir(source)) {
      await linkTree(join(source, name), join(destination, name))
    }
    return
  }
  if (!metadata.isFile()) throw new Error(`built package contains an unsupported entry: ${source}`)
  await linkBuiltFile(source, destination)
}

/** Stages the built dependency closure for one workspace package. */
async function stageBuiltModules(entryDirectory: string): Promise<StagedBuiltModules> {
  const entryManifest = await readManifest(entryDirectory, `${EntryName} package`)
  if (entryManifest.name !== EntryName) {
    throw new Error("prometheus native runtime must run from the @go-like/prometheus package")
  }
  const directory = await mkdtemp(join(tmpdir(), "likego-dev-built-node-"))
  try {
    const seen = new Set<string>()
    const externals = new Map<string, string>()
    const pending: PendingPackage[] = [
      { name: EntryName, fromDirectory: entryDirectory, entry: true }
    ]
    let entryRelative = ""
    while (pending.length > 0) {
      const item = pending.shift()
      if (item === undefined || seen.has(item.name)) continue
      seen.add(item.name)
      const sourceDirectory = item.entry
        ? item.fromDirectory
        : await owningPackageDirectory(
            resolveInstalled(item.fromDirectory, item.name),
            item.name,
            item.fromDirectory
          )
      const distDirectory = join(sourceDirectory, "dist")
      const distMetadata = await lstat(distDirectory)
      if (distMetadata.isSymbolicLink() || !distMetadata.isDirectory()) {
        throw new Error(`${item.name} dist must be a physical directory`)
      }
      const manifest = await readManifest(distDirectory, `${item.name} dist package`)
      const relativeImport = assertBuiltManifest(item.name, manifest)
      const installed = packageInstallPath(directory, item.name)
      await linkTree(distDirectory, installed)
      if (item.entry) entryRelative = join(installed, relativeImport)
      for (const dependency of dependencyNames(manifest, item.name)) {
        if (dependency.startsWith("@go-like/")) {
          if (!seen.has(dependency)) {
            pending.push({ name: dependency, fromDirectory: sourceDirectory, entry: false })
          }
          continue
        }
        const external = await owningPackageDirectory(
          resolveInstalled(sourceDirectory, dependency),
          dependency,
          sourceDirectory
        )
        const previous = externals.get(dependency)
        if (previous !== undefined && previous !== external) {
          throw new Error(`${dependency} resolved to multiple install locations`)
        }
        externals.set(dependency, external)
      }
    }
    if (entryRelative.length === 0) throw new Error(`${EntryName} built entry was not staged`)
    for (const [name, external] of externals) {
      const destination = packageInstallPath(directory, name)
      await mkdir(dirname(destination), { recursive: true })
      await symlink(external, destination, "dir")
    }
    return { directory, entryHref: pathToFileURL(entryRelative).href }
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Returns whether one temporary path has been removed. */
async function removed(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return true
    throw error
  }
}

const require = createRequire(resolve(process.cwd(), "package.json"))
const promClient = require("prom-client") as PromClientModule
const packageJson = require("prom-client/package.json") as PackageJson
if (packageJson.version !== "15.1.3") {
  throw new Error(`unexpected prom-client version ${packageJson.version}`)
}

const staged = await stageBuiltModules(resolve(process.cwd()))
try {
  const prometheus = (await import(staged.entryHref)) as PrometheusModule
  const registry = new promClient.Registry()
  const counter = new promClient.Counter({
    name: "go_like_e2e_total",
    help: "go-like sourced E2E counter.",
    registers: [registry]
  })
  counter.inc()
  const response = await prometheus.createPrometheusHandler(registry)(
    new Request("https://service.test/metrics")
  )
  const body = await response.text()
  const sampleMatch = /^go_like_e2e_total\s+([0-9]+(?:\.[0-9]+)?)$/m.exec(body)
  const sampleValue = sampleMatch?.[1] === undefined ? Number.NaN : Number(sampleMatch[1])
  if (response.status !== 200 || sampleValue !== 1) {
    throw new Error("Prometheus Handler scrape did not expose the incremented sample")
  }
  registry.clear()
  const registryCleared = (await registry.getMetricsAsJSON()).length === 0
  if (!registryCleared) {
    throw new Error("Prometheus Registry remained populated after explicit cleanup")
  }
} finally {
  await rm(staged.directory, { recursive: true, force: true })
}
if (!(await removed(staged.directory))) {
  throw new Error("Prometheus native stage remained after cleanup")
}

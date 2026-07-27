import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"

import { discoverWorkspaces } from "../../tools/workspaces/discovery"

import type {
  PublishedInventory,
  PublishedExport,
  PublishedExportKind,
  PublishedLane,
  PublishedManifest,
  PublishedPackage,
  PublishedPackageKind,
  PublishedResidency,
  PublishedRuntime,
  PublishedRuntimeRow,
  PublishedStage
} from "./contracts"
import { verifyPublishedBuildStamp } from "./build-stamp"
import { requireCommandSuccess, runCommand } from "./process"

const dependencyFields: readonly string[] = ["dependencies", "optionalDependencies"]
const supportedRuntimes = new Set(["bun", "node", "deno"])
const supportedLanes = new Set(["exact", "lts", "current"])

function isJsonObject(value: unknown): value is PublishedManifest {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonObjectFrom(value: unknown): PublishedManifest {
  if (isJsonObject(value)) return value
  return {}
}

function isPublishedRuntime(value: unknown): value is PublishedRuntime {
  return value === "bun" || value === "node" || value === "deno"
}

function isPublishedLane(value: unknown): value is PublishedLane {
  return value === "exact" || value === "lts" || value === "current"
}

function isPublishedPackageKind(value: unknown): value is PublishedPackageKind {
  return value === "portable" || value === "integration" || value === "hybrid"
}

function isPublishedExportKind(value: unknown): value is PublishedExportKind {
  return value === "portable" || value === "integration"
}

function isPublishedResidency(value: unknown): value is PublishedResidency {
  return value === "non-resident" || value === "resident"
}

function parseStringArray(
  packageName: string,
  exportName: string,
  label: string,
  value: unknown,
  allowEmpty: boolean
): readonly string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TypeError(`${packageName} ${exportName} ${label} must be a string array`)
  }
  const result = value.filter((item): item is string => typeof item === "string")
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${packageName} ${exportName} ${label} must be unique`)
  }
  return Object.freeze(Array.from(result))
}

function parseRuntimeRows(
  packageName: string,
  exportName: string,
  value: unknown
): readonly PublishedRuntimeRow[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${packageName} ${exportName} capability runtimes must be non-empty`)
  }
  const seen = new Set<string>()
  return Object.freeze(
    value.map((raw): PublishedRuntimeRow => {
      const row = jsonObjectFrom(raw)
      const runtime = row.runtime
      const lane = row.lane
      const minimumVersion = row.minimumVersion
      const testedVersions = row.testedVersions
      if (
        !isPublishedRuntime(runtime) ||
        !supportedRuntimes.has(runtime) ||
        !isPublishedLane(lane) ||
        !supportedLanes.has(lane) ||
        typeof minimumVersion !== "string" ||
        !Array.isArray(testedVersions) ||
        testedVersions.length !== 1 ||
        testedVersions[0] !== minimumVersion
      ) {
        throw new TypeError(`${packageName} ${exportName} has a non-exact capability runtime row`)
      }
      const key = `${runtime}:${lane}`
      if (seen.has(key)) {
        throw new TypeError(
          `${packageName} ${exportName} has a duplicate capability runtime row: ${key}`
        )
      }
      seen.add(key)
      return Object.freeze({
        runtime,
        lane,
        version: minimumVersion
      })
    })
  )
}

function packageBusinessExports(packageName: string, value: unknown): readonly string[] {
  if (!isJsonObject(value)) throw new TypeError(`${packageName} package exports must be an object`)
  const names = Object.keys(value)
    .filter((name) => name !== "./package.json")
    .sort()
  if (!names.includes(".") || names.some((name) => name !== "." && !name.startsWith("./"))) {
    throw new TypeError(`${packageName} package exports must contain a root business export`)
  }
  return Object.freeze(names)
}

function derivedPackageKind(exports: readonly PublishedExport[]): PublishedPackageKind {
  const kinds = new Set(exports.map((subject) => subject.kind))
  if (kinds.size > 1) return "hybrid"
  return kinds.has("portable") ? "portable" : "integration"
}

function parsePublishedExports(
  packageName: string,
  packageExportsValue: unknown,
  capabilityExportsValue: unknown
): readonly PublishedExport[] {
  const packageExports = packageBusinessExports(packageName, packageExportsValue)
  if (!isJsonObject(capabilityExportsValue)) {
    throw new TypeError(`${packageName} capability exports must be an object`)
  }
  const capabilityExports = Object.keys(capabilityExportsValue).sort()
  if (
    packageExports.length !== capabilityExports.length ||
    packageExports.some((name, index) => name !== capabilityExports[index])
  ) {
    throw new TypeError(`${packageName} package and capability exports drifted`)
  }
  const exports: PublishedExport[] = []
  for (const exportName of capabilityExports) {
    const claim = jsonObjectFrom(capabilityExportsValue[exportName])
    const kind = claim.kind
    const residency = claim.residency
    if (!isPublishedExportKind(kind) || !isPublishedResidency(residency)) {
      throw new TypeError(
        `${packageName} ${exportName} capability export kind or residency is invalid`
      )
    }
    exports.push(
      Object.freeze({
        name: exportName,
        kind,
        residency,
        ownerResources: parseStringArray(
          packageName,
          exportName,
          "ownerResources",
          claim.ownerResources,
          true
        ),
        capabilities: parseStringArray(
          packageName,
          exportName,
          "capabilities",
          claim.capabilities,
          false
        ),
        runtimes: parseRuntimeRows(packageName, exportName, claim.runtimes)
      })
    )
  }
  return Object.freeze(exports)
}

/** Discovers direct package ownership and validates every exact capability runtime row. */
export async function discoverPublishedPackages(root: string): Promise<PublishedInventory> {
  const packages: PublishedPackage[] = []
  const byName = new Map<string, PublishedPackage>()
  for (const workspace of await discoverWorkspaces(root)) {
    if (workspace.private) continue
    const packageRoot = resolve(root, workspace.root)
    const manifestPath = join(root, workspace.manifestPath)
    const capabilityPath = `${workspace.root}/capability.json`
    if (!(await Bun.file(join(root, capabilityPath)).exists())) {
      throw new Error(`${workspace.name} has no capability.json`)
    }
    const capability = jsonObjectFrom(await Bun.file(join(root, capabilityPath)).json())
    const manifest = jsonObjectFrom(await Bun.file(manifestPath).json())
    const name = manifest.name
    if (typeof name !== "string" || capability.package !== name) {
      throw new TypeError(`${capabilityPath} package name does not match package.json`)
    }
    if (byName.has(name)) throw new TypeError(`duplicate package name: ${name}`)
    if (capability.schemaVersion !== 2 || !isPublishedPackageKind(capability.packageKind)) {
      throw new TypeError(
        `${name} capability manifest must use schema v2 and a derived package kind`
      )
    }
    const exports = parsePublishedExports(name, manifest.exports, capability.exports)
    if (derivedPackageKind(exports) !== capability.packageKind) {
      throw new TypeError(`${name} capability packageKind is not derived from its exports`)
    }
    const publishedPackage: PublishedPackage = Object.freeze({
      name,
      root: packageRoot,
      manifest,
      releaseBlocking: capability.releaseBlocking === true,
      packageKind: capability.packageKind,
      exports
    })
    packages.push(publishedPackage)
    byName.set(name, publishedPackage)
  }
  packages.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return Object.freeze({ packages: Object.freeze(packages), byName })
}

function dependencies(subject: PublishedPackage): readonly string[] {
  const names = new Set<string>()
  for (const field of dependencyFields) {
    for (const name of Object.keys(jsonObjectFrom(subject.manifest[field]))) names.add(name)
  }
  return Array.from(names).sort()
}

function workspaceClosure(
  inventory: PublishedInventory,
  target: PublishedPackage
): readonly PublishedPackage[] {
  const visited = new Set<string>()
  const result: PublishedPackage[] = []
  function visit(subject: PublishedPackage): void {
    if (visited.has(subject.name)) return
    visited.add(subject.name)
    for (const dependencyName of dependencies(subject)) {
      const dependency = inventory.byName.get(dependencyName)
      if (dependency !== undefined) visit(dependency)
    }
    result.push(subject)
  }
  visit(target)
  return result.sort((left, right) => left.name.localeCompare(right.name))
}

interface MutableDependencies {
  [name: string]: string
}

function packageVersion(subject: PublishedPackage): string {
  const version = subject.manifest.version
  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError(`${subject.name} package version must be non-empty`)
  }
  return version
}

function pathIsInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`)
}

async function packPublishedPackage(packRoot: string, subject: PublishedPackage): Promise<string> {
  const packCwd = join(subject.root, "dist")
  const result = await runCommand(
    ["bun", "pm", "pack", "--destination", packRoot, "--ignore-scripts", "--quiet"],
    { cwd: packCwd }
  )
  requireCommandSuccess(`${subject.name} bun pm pack`, result)
  const lines = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
  if (lines.length !== 1)
    throw new Error(`${subject.name} bun pm pack returned an invalid tarball path`)
  const line = lines[0]
  if (line === undefined) throw new Error(`${subject.name} bun pm pack returned no tarball path`)
  const path = await realpath(resolve(packCwd, line))
  const realPackRoot = await realpath(packRoot)
  if (!pathIsInside(realPackRoot, path) || !path.endsWith(".tgz")) {
    throw new Error(`${subject.name} bun pm pack escaped its private tarball directory`)
  }
  return path
}

function collectExportTargets(value: unknown, targets: string[]): void {
  if (typeof value === "string") {
    if (value.startsWith("./")) targets.push(value.slice(2))
    return
  }
  if (!isJsonObject(value)) return
  for (const key of Object.keys(value).sort()) collectExportTargets(value[key], targets)
}

function validateInstalledDependencies(
  inventory: PublishedInventory,
  source: PublishedPackage,
  installed: PublishedManifest
): void {
  for (const field of dependencyFields) {
    const sourceDependencies = jsonObjectFrom(source.manifest[field])
    const installedDependencies = jsonObjectFrom(installed[field])
    const sourceNames = Object.keys(sourceDependencies).sort()
    const installedNames = Object.keys(installedDependencies).sort()
    if (JSON.stringify(sourceNames) !== JSON.stringify(installedNames)) {
      throw new Error(`${source.name} packed ${field} keys drifted`)
    }
    for (const name of sourceNames) {
      const sourceVersion = sourceDependencies[name]
      const workspaceDependency = inventory.byName.get(name)
      const expectedVersion =
        workspaceDependency === undefined ? sourceVersion : packageVersion(workspaceDependency)
      const observedVersion = installedDependencies[name]
      if (typeof expectedVersion !== "string" || observedVersion !== expectedVersion) {
        throw new Error(
          `${source.name} packed ${field}.${name} was not rewritten to its publish version`
        )
      }
      if (observedVersion.startsWith("workspace:")) {
        throw new Error(`${source.name} packed ${field}.${name} retained a workspace protocol`)
      }
    }
  }
}

async function installedPackageFiles(packageRoot: string): Promise<readonly string[]> {
  const files: string[] = []
  const glob = new Bun.Glob("**/*")
  for await (const path of glob.scan({ cwd: packageRoot, onlyFiles: true })) files.push(path)
  return Object.freeze(files.sort())
}

async function validateInstalledPackage(
  root: string,
  stageRoot: string,
  inventory: PublishedInventory,
  subject: PublishedPackage
): Promise<void> {
  const packageRoot = join(stageRoot, "node_modules", subject.name)
  const packageStat = await lstat(packageRoot)
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    throw new Error(`${subject.name} was not installed from an unpacked tarball`)
  }
  const rawManifest: unknown = await Bun.file(join(packageRoot, "package.json")).json()
  if (!isJsonObject(rawManifest)) throw new Error(`${subject.name} installed manifest is invalid`)
  if (rawManifest.name !== subject.name || rawManifest.version !== packageVersion(subject)) {
    throw new Error(`${subject.name} installed package identity drifted`)
  }
  validateInstalledDependencies(inventory, subject, rawManifest)

  const packageFiles = await installedPackageFiles(packageRoot)
  const expectedFiles = await installedPackageFiles(join(subject.root, "dist"))
  if (JSON.stringify(packageFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`${subject.name} tarball files drifted from its distribution directory`)
  }
  if (!packageFiles.includes("package.json") || !packageFiles.includes("README.md")) {
    throw new Error(`${subject.name} tarball is missing package.json or README.md`)
  }
  if (!packageFiles.includes("LICENSE"))
    throw new Error(`${subject.name} tarball is missing LICENSE`)
  for (const path of packageFiles) {
    if (path.includes(".min."))
      throw new Error(`${subject.name} tarball contains a minified lane: ${path}`)
    if (
      path !== "package.json" &&
      path !== "README.md" &&
      path !== "LICENSE" &&
      !path.endsWith(".js") &&
      !path.endsWith(".d.ts")
    ) {
      throw new Error(`${subject.name} tarball contains an unexpected file: ${path}`)
    }
  }
  const expectedLicense = await Bun.file(join(root, "LICENSE")).text()
  const installedLicense = await Bun.file(join(packageRoot, "LICENSE")).text()
  if (installedLicense !== expectedLicense)
    throw new Error(`${subject.name} tarball LICENSE drifted from the repository`)

  const targets: string[] = []
  collectExportTargets(rawManifest.exports, targets)
  if (targets.length === 0)
    throw new Error(`${subject.name} tarball has zero package export targets`)
  for (const target of targets) {
    const targetPath = resolve(packageRoot, target)
    if (
      target.includes(".min.") ||
      !pathIsInside(packageRoot, targetPath) ||
      !(await Bun.file(targetPath).exists())
    ) {
      throw new Error(`${subject.name} tarball is missing export target ${target}`)
    }
  }
}

async function installPublishedTarballs(
  root: string,
  stageRoot: string,
  inventory: PublishedInventory,
  closure: readonly PublishedPackage[]
): Promise<void> {
  const packRoot = join(stageRoot, "tarballs")
  await mkdir(packRoot, { recursive: true })
  const realStageRoot = await realpath(stageRoot)
  const consumerDependencies: MutableDependencies = {}
  for (const subject of closure) {
    const tarball = await packPublishedPackage(packRoot, subject)
    consumerDependencies[subject.name] =
      `file:${relative(realStageRoot, tarball).replaceAll("\\", "/")}`
  }
  await Bun.write(
    join(stageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "likego-published-consumer",
        private: true,
        type: "module",
        dependencies: consumerDependencies
      },
      null,
      2
    )}\n`
  )
  const install = await runCommand(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--loglevel=error"
    ],
    { cwd: stageRoot }
  )
  requireCommandSuccess("isolated npm tarball consumer install", install)
  for (const subject of closure) await validateInstalledPackage(root, stageRoot, inventory, subject)
}

/** Packs and installs one real tarball closure into an isolated npm consumer stage. */
export async function stagePublishedPackage(
  root: string,
  inventory: PublishedInventory,
  packageName: string
): Promise<PublishedStage> {
  const target = inventory.byName.get(packageName)
  if (target === undefined) throw new Error(`published package is missing: ${packageName}`)
  const closure = workspaceClosure(inventory, target)
  await verifyPublishedBuildStamp(root, closure)
  const prefix = join(tmpdir(), `${packageName.replaceAll(/[^a-z0-9]+/gi, "-")}-`)
  const stageRoot = await realpath(await mkdtemp(prefix))
  try {
    await installPublishedTarballs(root, stageRoot, inventory, closure)
  } catch (error) {
    try {
      await rm(stageRoot, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${packageName} tarball stage and cleanup failed`
      )
    }
    throw error
  }
  return Object.freeze({
    root: stageRoot,
    target,
    workspacePackages: Object.freeze(closure.map((subject) => subject.name))
  })
}

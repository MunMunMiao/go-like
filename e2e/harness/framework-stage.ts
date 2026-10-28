import { cp, copyFile, lstat, readFile, realpath, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

import { collectCleanupFailure, type CleanupFailure, finalizeWithCleanup } from "./cleanup"
import { runCommand, type CommandResult } from "./process"
import { errorValue } from "./result"
import {
  createTempDirectory,
  createTempSubdirectories,
  isPathContained,
  removeTempDirectory,
  type TempDirectory
} from "./temp"

export interface VendorPackageSource {
  readonly name: string
  readonly source: string
}

export interface FrameworkDistConsumerOptions {
  readonly root: string
  readonly prefix: string
  readonly consumer: string
  readonly arguments?: readonly string[] | undefined
  readonly builtPackages: readonly string[]
  readonly vendorPackages: readonly VendorPackageSource[]
  readonly requiredRuntimePeers?: Readonly<Record<string, readonly string[]>> | undefined
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignal | undefined
}

interface PackageManifest {
  readonly name: string
  readonly type?: string | undefined
  readonly exports?: unknown
  readonly dependencies?: Readonly<Record<string, unknown>> | undefined
}

interface VendorPackage {
  readonly name: string
  readonly source: string
}

const PackageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

function packageComponents(packageName: string): readonly string[] {
  if (!PackageNamePattern.test(packageName)) throw new Error(`invalid package name ${packageName}`)
  return Object.freeze(packageName.split("/"))
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Readonly<Record<string, unknown>>
}

async function packageManifest(
  packageRoot: string,
  expectedName: string
): Promise<PackageManifest> {
  const parsed: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  const value = jsonObject(parsed, `${expectedName} package manifest`)
  if (value.name !== expectedName) {
    throw new Error(`${expectedName} package manifest has name ${String(value.name)}`)
  }
  if (value.dependencies !== undefined) {
    jsonObject(value.dependencies, `${expectedName} dependencies`)
  }
  return value as unknown as PackageManifest
}

function manifestStrings(value: unknown): readonly string[] {
  if (typeof value === "string") return Object.freeze([value])
  if (Array.isArray(value)) return Object.freeze(value.flatMap(manifestStrings))
  if (typeof value !== "object" || value === null) return Object.freeze([])
  return Object.freeze(Object.values(value).flatMap(manifestStrings))
}

async function validatedBuiltPackage(root: string, packageName: string): Promise<string> {
  const components = packageComponents(packageName)
  if (components.length !== 2 || components[0] !== "@go-like") {
    throw new Error(`built framework staging only accepts @go-like packages: ${packageName}`)
  }
  const packageRoot = resolve(root, "packages", components[1] ?? "", "dist")
  const metadata = await lstat(packageRoot)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${packageName} dist must be a physical directory`)
  }
  const manifest = await packageManifest(packageRoot, packageName)
  if (manifest.type !== "module") throw new Error(`${packageName} dist must be an ESM package`)
  const exported = manifestStrings(manifest.exports)
  if (exported.length === 0) throw new Error(`${packageName} dist has no package exports`)
  const sourceExport = exported.find(
    (entry) =>
      /(?:^|\/)src(?:\/|$)/u.test(entry) ||
      (/\.[cm]?ts$/u.test(entry) && !/\.d\.[cm]?ts$/u.test(entry))
  )
  if (sourceExport !== undefined) {
    throw new Error(`${packageName} dist exports workspace source instead of built artifacts`)
  }
  return packageRoot
}

function packageViewRoot(packageRoot: string, packageName: string): string {
  const components = packageComponents(packageName)
  let view = packageRoot
  for (const component of components.toReversed()) {
    if (view.slice(view.lastIndexOf(sep) + 1) !== component) {
      throw new Error(`${packageName} resolved outside its package identity`)
    }
    view = dirname(view)
  }
  return view
}

async function physicalVendorSource(
  root: string,
  packageName: string,
  requestedSource: string
): Promise<string> {
  const canonical = await realpath(requestedSource)
  const metadata = await lstat(canonical)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${packageName} vendor source must resolve to a physical directory`)
  }
  const workspacePackages = resolve(root, "packages")
  if (canonical === workspacePackages || isPathContained(workspacePackages, canonical)) {
    throw new Error(`${packageName} vendor source resolved into the workspace packages tree`)
  }
  const installedPackages = resolve(root, "node_modules")
  if (!isPathContained(installedPackages, canonical)) {
    throw new Error(`${packageName} vendor source resolved outside repository node_modules`)
  }
  await packageManifest(canonical, packageName)
  return canonical
}

async function vendorClosure(
  root: string,
  initial: readonly VendorPackageSource[],
  requiredPeers: Readonly<Record<string, readonly string[]>>
): Promise<readonly VendorPackage[]> {
  const packages = new Map<string, string>()
  const pending = initial.slice()
  for (let index = 0; index < pending.length; index += 1) {
    const requested = pending[index]
    if (requested === undefined) continue
    const source = await physicalVendorSource(root, requested.name, requested.source)
    const existing = packages.get(requested.name)
    if (existing !== undefined) {
      if (existing !== source)
        throw new Error(`${requested.name} resolved to multiple vendor sources`)
      continue
    }
    packages.set(requested.name, source)
    const manifest = await packageManifest(source, requested.name)
    const dependencyNames = Object.keys(manifest.dependencies ?? {})
    const peerNames = requiredPeers[requested.name] ?? Object.freeze([])
    const view = packageViewRoot(source, requested.name)
    for (const dependencyName of [...dependencyNames, ...peerNames]) {
      const dependencySource = join(view, ...packageComponents(dependencyName))
      pending.push(Object.freeze({ name: dependencyName, source: dependencySource }))
    }
  }
  return Object.freeze(
    [...packages.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, source]) => Object.freeze({ name, source }))
  )
}

async function assertPhysicalTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink())
      throw new Error(`staged package contains a symbolic link: ${path}`)
    if (metadata.isDirectory()) await assertPhysicalTree(path)
  }
}

async function stagePackages(
  directory: TempDirectory,
  root: string,
  builtPackageNames: readonly string[],
  vendorSources: readonly VendorPackageSource[],
  requiredPeers: Readonly<Record<string, readonly string[]>>
): Promise<void> {
  const requestedNames = new Set<string>()
  for (const name of [...builtPackageNames, ...vendorSources.map((value) => value.name)]) {
    if (requestedNames.has(name)) throw new Error(`duplicate staged package identity ${name}`)
    requestedNames.add(name)
  }
  const builtPackages = await Promise.all(
    builtPackageNames.map(async (name) =>
      Object.freeze({ name, source: await validatedBuiltPackage(root, name) })
    )
  )
  const vendorPackages = await vendorClosure(root, vendorSources, requiredPeers)
  const builtNames = new Set(builtPackageNames)
  for (const vendor of vendorPackages) {
    if (builtNames.has(vendor.name))
      throw new Error(`duplicate staged package identity ${vendor.name}`)
  }
  const packages = [...builtPackages, ...vendorPackages].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
  const destinations = await createTempSubdirectories(
    directory,
    packages.map((value) => ["node_modules", ...packageComponents(value.name)])
  )
  for (const [index, sourcePackage] of packages.entries()) {
    const destination = destinations[index]
    if (destination === undefined)
      throw new Error(`staging destination missing for ${sourcePackage.name}`)
    await cp(sourcePackage.source, destination, { recursive: true, dereference: false })
    await assertPhysicalTree(destination)
  }
}

function commandFailure(result: CommandResult): Error | null {
  if (result.timedOut) return new Error("framework dist consumer timed out")
  if (result.termination === "signal") {
    return new Error(`framework dist consumer terminated by ${result.signal ?? "signal"}`)
  }
  if (result.termination !== "exit" || result.exitCode === null) {
    return new Error(`framework dist consumer ended with ${result.termination}`)
  }
  if (result.exitCode !== 0) {
    return new Error(
      `framework dist consumer exited ${result.exitCode}: ${result.stderr.slice(-4_000)}`
    )
  }
  return null
}

/** Runs one committed Node consumer against only physical packages in an invocation-owned temp stage. */
export async function runFrameworkDistConsumer(
  options: FrameworkDistConsumerOptions
): Promise<void> {
  options.signal?.throwIfAborted()
  const root = resolve(options.root)
  const consumer = resolve(options.consumer)
  if (!isAbsolute(consumer)) throw new Error("framework dist consumer path must be absolute")
  const directory = await createTempDirectory(options.prefix)
  let primary: Error | null = null
  try {
    await stagePackages(
      directory,
      root,
      options.builtPackages,
      options.vendorPackages,
      options.requiredRuntimePeers ?? Object.freeze({})
    )
    const consumerName = "framework-dist-consumer.mjs"
    await copyFile(consumer, join(directory.path, consumerName))
    const result = await runCommand(directory.path, {
      cwd: ".",
      command: ["node", consumerName, ...(options.arguments ?? [])],
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal,
      environment: Object.freeze({
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
        GO_LIKE_E2E_FRAMEWORK_STAGE: directory.path
      })
    })
    const failure = commandFailure(result)
    if (failure !== null) throw failure
  } catch (error) {
    primary = errorValue(error, "framework dist E2E failed")
  }
  const cleanupFailures: CleanupFailure[] = []
  await collectCleanupFailure(cleanupFailures, "framework dist stage cleanup", () =>
    removeTempDirectory(directory)
  )
  finalizeWithCleanup(primary, cleanupFailures, "framework dist E2E failed and cleanup failed")
}

/** Installs bounded signal handling around one framework staging controller entry point. */
export async function runFrameworkDistConsumerMain(
  options: Omit<FrameworkDistConsumerOptions, "signal">
): Promise<void> {
  const controller = new AbortController()
  const onSigint = (): void =>
    controller.abort(new Error("framework dist E2E interrupted by SIGINT"))
  const onSigterm = (): void =>
    controller.abort(new Error("framework dist E2E interrupted by SIGTERM"))
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    await runFrameworkDistConsumer({ ...options, signal: controller.signal })
  } finally {
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
  }
}

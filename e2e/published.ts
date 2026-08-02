import { copyFile, lstat, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises"
import { basename, join, posix, resolve } from "node:path"

import { collectCleanupFailure, type CleanupFailure, finalizeWithCleanup } from "./harness/cleanup"
import { boundedTail, errorSummary, sanitizeArgv } from "./harness/diagnostics"
import { runCommand, type CommandResult } from "./harness/process"
import { errorValue } from "./harness/result"
import {
  createTempDirectory,
  createTempSubdirectories,
  isPathContained,
  removeTempDirectory,
  type TempDirectory,
  verifyTempDirectory
} from "./harness/temp"

interface PublishedPackage {
  readonly name: string
  readonly root: string
}

interface PublishedStagePaths {
  readonly tarballs: string
  readonly nodeOutput: string
  readonly markers: string
}

const FixtureFiles = Object.freeze([
  "package.json",
  "portable.ts",
  "node.ts",
  "bun.ts",
  "deno.ts",
  "deno.json",
  "tsconfig.authoring.json",
  "tsconfig.types.json",
  "tsconfig.node.json",
  "authoring-stubs/likego.d.ts"
])

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("published package metadata must be an object")
  }
  return value as Record<string, unknown>
}

function stagePath(paths: readonly string[], index: number, label: string): string {
  const path = paths[index]
  if (path === undefined) throw new Error(`published stage did not create ${label}`)
  return path
}

async function createStagePaths(directory: TempDirectory): Promise<PublishedStagePaths> {
  const paths = await createTempSubdirectories(directory, [
    ["authoring-stubs"],
    ["tarballs"],
    ["home"],
    ["cache"],
    ["cache", "npm"],
    ["cache", "bun"],
    ["cache", "deno"],
    ["config"],
    ["npm-prefix"],
    ["compiled"],
    ["compiled", "node"],
    ["markers"]
  ])
  return Object.freeze({
    tarballs: stagePath(paths, 1, "tarball directory"),
    nodeOutput: stagePath(paths, 10, "Node output directory"),
    markers: stagePath(paths, 11, "marker directory")
  })
}

/** Removes ambient module/config search inputs and pins tool state beneath the stage. */
export function publishedEnvironment(
  stage: string,
  ambient: Readonly<Record<string, string | undefined>> = process.env
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {}
  for (const name of Object.keys(ambient)) {
    const upperName = name.toUpperCase()
    if (
      /^npm_config_/iu.test(name) ||
      /^bun_/iu.test(name) ||
      /^deno_/iu.test(name) ||
      upperName === "NODE_OPTIONS" ||
      upperName === "NODE_PATH" ||
      upperName === "INIT_CWD" ||
      upperName === "HOME" ||
      upperName === "XDG_CACHE_HOME" ||
      upperName === "XDG_CONFIG_HOME"
    ) {
      environment[name] = undefined
    }
  }
  Object.assign(environment, {
    HOME: join(stage, "home"),
    XDG_CACHE_HOME: join(stage, "cache"),
    XDG_CONFIG_HOME: join(stage, "config"),
    npm_config_cache: join(stage, "cache/npm"),
    npm_config_userconfig: join(stage, "config/npmrc"),
    npm_config_globalconfig: join(stage, "config/npmrc-global"),
    npm_config_prefix: join(stage, "npm-prefix"),
    npm_config_ignore_scripts: "true",
    BUN_INSTALL_CACHE_DIR: join(stage, "cache/bun"),
    DENO_DIR: join(stage, "cache/deno"),
    NODE_OPTIONS: undefined,
    NODE_PATH: undefined,
    INIT_CWD: undefined
  })
  return Object.freeze(environment)
}

function commandFailure(argv: readonly string[], result: CommandResult): Error | null {
  const rendered = sanitizeArgv(argv).join(" ")
  if (result.cleanupFailures.length > 0) {
    return new Error(
      `${rendered} had process cleanup failures: ${errorSummary(result.cleanupFailures)}`
    )
  }
  if (result.timedOut) return new Error(`${rendered} timed out`)
  if (result.termination !== "exit" || result.exitCode === null) {
    return new Error(`${rendered} ended with ${result.termination}`)
  }
  if (result.exitCode !== 0) {
    return new Error(
      `${rendered} exited ${result.exitCode}: ${boundedTail(result.stderr || result.stdout, 4_000)}`
    )
  }
  return null
}

async function execute(
  root: string,
  directory: TempDirectory,
  cwd: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CommandResult> {
  await verifyTempDirectory(directory)
  return await runCommand(root, {
    cwd,
    command: argv,
    timeoutMs,
    signal,
    environment
  })
}

async function command(
  root: string,
  directory: TempDirectory,
  cwd: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const result = await execute(root, directory, cwd, argv, environment, timeoutMs, signal)
  const failure = commandFailure(argv, result)
  if (failure !== null) throw failure
  return result.stdout.trim()
}

async function packageRoots(root: string): Promise<readonly PublishedPackage[]> {
  const packages: PublishedPackage[] = []
  const names = new Set<string>()
  for await (const path of new Bun.Glob("packages/**/package.json").scan({
    cwd: root,
    onlyFiles: true
  })) {
    if (path.includes("/dist/") || path.includes("/node_modules/")) continue
    const manifest = record(await Bun.file(join(root, path)).json())
    if (manifest.private === true) continue
    if (typeof manifest.name !== "string" || !/^@likego\/[a-z0-9-]+$/u.test(manifest.name)) {
      throw new Error(`public package at ${path} has an invalid name`)
    }
    if (names.has(manifest.name)) throw new Error(`duplicate public package ${manifest.name}`)
    names.add(manifest.name)
    packages.push(
      Object.freeze({
        name: manifest.name,
        root: resolve(root, path, "..", "dist")
      })
    )
  }
  return Object.freeze(packages.sort((left, right) => left.name.localeCompare(right.name, "en-US")))
}

function safePackPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path) ||
    posix.normalize(path) !== path
  ) {
    return false
  }
  return path
    .split("/")
    .every((component) => component.length > 0 && component !== "." && component !== "..")
}

/** Parses npm's structured pack output and rejects unsafe or incomplete archive inventories. */
export function parseNpmPackOutput(output: string, expectedName: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON for ${expectedName}`, { cause: error })
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack returned an invalid result count for ${expectedName}`)
  }
  const result = record(parsed[0])
  if (result.name !== expectedName) throw new Error(`npm pack returned the wrong package name`)
  if (
    typeof result.filename !== "string" ||
    !safePackPath(result.filename) ||
    basename(result.filename) !== result.filename ||
    !result.filename.endsWith(".tgz")
  ) {
    throw new Error(`npm pack returned an unsafe filename for ${expectedName}`)
  }
  if (!Array.isArray(result.files) || result.files.length === 0) {
    throw new Error(`npm pack returned no file inventory for ${expectedName}`)
  }
  const paths = new Set<string>()
  for (const value of result.files) {
    const file = record(value)
    if (typeof file.path !== "string" || !safePackPath(file.path)) {
      throw new Error(`npm pack returned an unsafe entry for ${expectedName}`)
    }
    if (paths.has(file.path))
      throw new Error(`npm pack returned a duplicate entry for ${expectedName}`)
    paths.add(file.path)
    if (
      !Number.isInteger(file.mode) ||
      (file.mode as number) < 0 ||
      (file.mode as number) > 0o777
    ) {
      throw new Error(`npm pack returned an invalid file mode for ${expectedName}`)
    }
  }
  if (!paths.has("package.json") || !Array.from(paths).some((path) => path.endsWith(".js"))) {
    throw new Error(`npm pack returned an incomplete runtime contract for ${expectedName}`)
  }
  if (!Array.from(paths).some((path) => path.endsWith(".d.ts"))) {
    throw new Error(`npm pack returned an incomplete type contract for ${expectedName}`)
  }
  return result.filename
}

async function assertRegularContained(root: string, path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`published archive is not a regular file: ${basename(path)}`)
  }
  const physical = await realpath(path)
  if (!isPathContained(root, physical)) {
    throw new Error(`published archive escaped its stage: ${basename(path)}`)
  }
}

function dependencyValues(manifest: Record<string, unknown>): readonly unknown[] {
  const fields = ["dependencies", "peerDependencies", "optionalDependencies"] as const
  return fields.flatMap((field) => {
    const value = manifest[field]
    return value === undefined ? [] : Object.values(record(value))
  })
}

async function validateInstalledPackages(stage: string, packages: readonly PublishedPackage[]) {
  const nodeModules = join(stage, "node_modules")
  for (const entry of packages) {
    const packagePath = join(nodeModules, ...entry.name.split("/"))
    const metadata = await lstat(packagePath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`installed package is not a physical directory: ${entry.name}`)
    }
    const physical = await realpath(packagePath)
    if (!isPathContained(nodeModules, physical)) {
      throw new Error(`installed package escaped stage node_modules: ${entry.name}`)
    }
    const manifest = record(JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")))
    if (
      manifest.name !== entry.name ||
      manifest.exports === undefined ||
      typeof manifest.types !== "string"
    ) {
      throw new Error(`installed package contract is incomplete: ${entry.name}`)
    }
    if (
      dependencyValues(manifest).some(
        (value) => typeof value === "string" && value.startsWith("workspace:")
      )
    ) {
      throw new Error(`installed package retained a workspace dependency: ${entry.name}`)
    }
    const typesPath = resolve(packagePath, manifest.types)
    if (!isPathContained(packagePath, typesPath) || !(await lstat(typesPath)).isFile()) {
      throw new Error(`installed package types escaped or are missing: ${entry.name}`)
    }
  }
}

/** Requires every public package root import to resolve inside the staged physical node_modules. */
export function validatePublishedTrace(
  trace: string,
  stage: string,
  packageNames: readonly string[]
): void {
  const nodeModules = join(resolve(stage), "node_modules")
  const resolved = new Map<string, string>()
  const pattern = /Module name '(@likego\/[^']+)' was successfully resolved to '([^']+)'/gu
  for (const match of trace.matchAll(pattern)) {
    const specifier = match[1]
    const path = match[2]
    if (specifier === undefined || path === undefined) continue
    if (!isPathContained(nodeModules, path)) {
      throw new Error(`published type resolution escaped staged node_modules: ${specifier}`)
    }
    resolved.set(specifier, path)
  }
  if (resolved.size === 0) throw new Error("published type trace contained no @likego resolutions")
  const missing = packageNames.filter((name) => !resolved.has(name))
  if (missing.length > 0) {
    throw new Error(`published type trace missed public packages: ${missing.join(", ")}`)
  }
}

/** Verifies TypeScript rewrote only the committed relative TS import for Node execution. */
export function validateNodeEmit(portable: string, node: string): void {
  if (!node.includes('from "./portable.js"') || node.includes("./portable.ts")) {
    throw new Error("published Node emit did not rewrite the relative TypeScript import")
  }
  if (!portable.includes('from "@likego/') || !node.includes('from "@likego/')) {
    throw new Error("published Node emit lost package specifiers")
  }
}

async function validateNodeOutput(paths: PublishedStagePaths): Promise<void> {
  const entries = (await readdir(paths.nodeOutput)).sort()
  if (entries.length !== 2 || entries[0] !== "node.js" || entries[1] !== "portable.js") {
    throw new Error(`published Node emit produced unexpected files: ${entries.join(", ")}`)
  }
  validateNodeEmit(
    await readFile(join(paths.nodeOutput, "portable.js"), "utf8"),
    await readFile(join(paths.nodeOutput, "node.js"), "utf8")
  )
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
  throw new Error(`unexpected published marker exists: ${basename(path)}`)
}

async function expectConsumerFailure(
  root: string,
  directory: TempDirectory,
  stage: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  marker: string,
  signal?: AbortSignal
): Promise<void> {
  const result = await execute(root, directory, stage, argv, environment, 120_000, signal)
  const failure = commandFailure(argv, result)
  if (failure === null) {
    await writeFile(marker, "unexpected success\n", { encoding: "utf8", flag: "wx", mode: 0o600 })
    throw new Error(`${sanitizeArgv(argv).join(" ")} unexpectedly resolved a hidden package`)
  }
  if (
    result.cleanupFailures.length > 0 ||
    result.timedOut ||
    result.termination !== "exit" ||
    result.exitCode === null
  ) {
    throw failure
  }
  if (!`${result.stdout}\n${result.stderr}`.includes("@likego/context")) {
    throw new Error(`${sanitizeArgv(argv).join(" ")} failed for an unrelated reason`, {
      cause: failure
    })
  }
  await assertMissing(marker)
}

async function runHidePackageNegatives(
  root: string,
  directory: TempDirectory,
  stage: string,
  paths: PublishedStagePaths,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal
): Promise<void> {
  const installed = join(stage, "node_modules/@likego/context")
  const hidden = join(stage, "node_modules/@likego/.context-hidden")
  await rename(installed, hidden)
  let primary: Error | null = null
  try {
    await expectConsumerFailure(
      root,
      directory,
      stage,
      ["node", "compiled/node/node.js"],
      environment,
      join(paths.markers, "node-hidden"),
      signal
    )
    await expectConsumerFailure(
      root,
      directory,
      stage,
      ["bun", "--no-install", "bun.ts"],
      environment,
      join(paths.markers, "bun-hidden"),
      signal
    )
  } catch (error) {
    primary = errorValue(error, "published hide-package negative failed")
  }
  const cleanupFailures: CleanupFailure[] = []
  await collectCleanupFailure(cleanupFailures, "published hidden package restore", () =>
    rename(hidden, installed)
  )
  finalizeWithCleanup(primary, cleanupFailures, "published negative failed and restore failed")
}

async function copyFixture(root: string, stage: string): Promise<void> {
  const fixture = join(root, "e2e/fixtures/published-consumer")
  for (const path of FixtureFiles) await copyFile(join(fixture, path), join(stage, path))
}

async function writeMarker(paths: PublishedStagePaths, name: string): Promise<void> {
  await writeFile(join(paths.markers, name), "passed\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  })
}

export async function runPublishedE2e(root: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const directory = await createTempDirectory("likego-published-")
  const stage = directory.path
  let primary: Error | null = null
  try {
    const paths = await createStagePaths(directory)
    await copyFixture(root, stage)
    const environment = publishedEnvironment(stage)
    const packages = await packageRoots(root)
    const tarballs: string[] = []
    for (const entry of packages) {
      const output = await command(
        root,
        directory,
        entry.root,
        ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", paths.tarballs],
        environment,
        120_000,
        signal
      )
      const tarball = join(paths.tarballs, parseNpmPackOutput(output, entry.name))
      await assertRegularContained(paths.tarballs, tarball)
      tarballs.push(tarball)
    }

    await command(
      root,
      directory,
      stage,
      [
        "npm",
        "install",
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--loglevel=error",
        ...tarballs
      ],
      environment,
      300_000,
      signal
    )
    await validateInstalledPackages(stage, packages)

    const trace = await command(
      root,
      directory,
      stage,
      [
        resolve(root, "node_modules/.bin/tsc"),
        "-p",
        "tsconfig.types.json",
        "--traceResolution",
        "--pretty",
        "false"
      ],
      environment,
      120_000,
      signal
    )
    validatePublishedTrace(
      trace,
      stage,
      packages.map((entry) => entry.name)
    )
    await command(
      root,
      directory,
      stage,
      [resolve(root, "node_modules/.bin/tsc"), "-p", "tsconfig.node.json", "--pretty", "false"],
      environment,
      120_000,
      signal
    )
    await validateNodeOutput(paths)

    await command(
      root,
      directory,
      stage,
      ["node", "compiled/node/node.js"],
      environment,
      120_000,
      signal
    )
    await writeMarker(paths, "node")
    await command(
      root,
      directory,
      stage,
      ["bun", "--no-install", "bun.ts"],
      environment,
      120_000,
      signal
    )
    await writeMarker(paths, "bun")
    await command(
      root,
      directory,
      stage,
      ["deno", "check", "--config", "deno.json", "--node-modules-dir=manual", "deno.ts"],
      environment,
      120_000,
      signal
    )
    await command(
      root,
      directory,
      stage,
      [
        "deno",
        "run",
        "--no-prompt",
        "--config",
        "deno.json",
        "--node-modules-dir=manual",
        "deno.ts"
      ],
      environment,
      120_000,
      signal
    )
    await writeMarker(paths, "deno")
    await runHidePackageNegatives(root, directory, stage, paths, environment, signal)
  } catch (error) {
    primary = errorValue(error, "published E2E failed")
  }
  const cleanupFailures: CleanupFailure[] = []
  await collectCleanupFailure(cleanupFailures, "published stage cleanup", () =>
    removeTempDirectory(directory)
  )
  finalizeWithCleanup(primary, cleanupFailures, "published E2E failed and cleanup failed")
}

if (import.meta.main) {
  const controller = new AbortController()
  const onSigint = () => controller.abort(new Error("published E2E interrupted by SIGINT"))
  const onSigterm = () => controller.abort(new Error("published E2E interrupted by SIGTERM"))
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    await runPublishedE2e(resolve(import.meta.dir, ".."), controller.signal)
  } catch (error) {
    process.stderr.write(`${errorSummary(error)}\n`)
    process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}

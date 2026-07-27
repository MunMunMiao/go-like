import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"

import { packageExportOutput } from "../package-dist"
import { parsePublishedLcov, requirePublishedFileInventory } from "./coverage"
import type {
  CommandResult,
  PublishedBusinessCase,
  PublishedCoverage,
  PublishedInventory,
  PublishedManifest,
  PublishedNatsExactOptionalPolicy,
  PublishedPackage,
  PublishedRuntimeRow,
  PublishedStage,
  RuntimeEvidence,
  TypeEvidence
} from "./contracts"
import { stagePublishedPackage } from "./inventory"
import { commandOutput, requireCommandSuccess, runCommand } from "./process"

export const nodeLtsImage =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
const expectedTypeScriptVersion = "7.0.2"
const bunBranchReason = "BUN_1_3_14_NO_BRANCH_COUNTER"
const h3Version = "1.15.11"
const natsCoreVersion = "3.4.0"
const publishedDockerPresenceLabel = "com.likego.published=true"
const publishedDockerOwnerLabel = "com.likego.published.owner"
const dockerCleanupTimeoutMs = 10_000
const nodePreloadModulePath = "node-preload.mjs"

type NatsTypeExceptionPolicy = PublishedNatsExactOptionalPolicy

const natsExpectedDiagnostics = [
  "@nats-io/nats-core/lib/msg.d.ts(3,22): error TS2420: Class 'MsgImpl' incorrectly implements interface 'Msg'.",
  "  Types of property 'headers' are incompatible.",
  "    Type 'MsgHdrs | undefined' is not assignable to type 'MsgHdrs'.",
  "      Type 'undefined' is not assignable to type 'MsgHdrs'.",
  "@nats-io/nats-core/lib/nats.d.ts(4,22): error TS2420: Class 'NatsConnectionImpl' incorrectly implements interface 'NatsConnection'.",
  "  Types of property 'info' are incompatible.",
  "    Type 'ServerInfo | undefined' is not assignable to type 'ServerInfo'.",
  "      Type 'undefined' is not assignable to type 'ServerInfo'."
].join("\n")

type NatsObservedException = Extract<
  NonNullable<TypeEvidence["observedException"]>,
  { readonly package: "@nats-io/nats-core" }
>

const natsObservedDiagnostics: NatsObservedException["diagnostics"] = Object.freeze([
  "TS2420:MsgImpl.headers",
  "TS2420:NatsConnectionImpl.info"
])

const h3ExpectedDiagnostics = [
  "node_modules/h3/dist/index.d.ts(3,49): error TS2591: Cannot find name 'node:http'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
  "node_modules/h3/dist/index.d.ts(4,94): error TS2591: Cannot find name 'node:http'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
  "node_modules/h3/dist/index.d.ts(7,26): error TS2591: Cannot find name 'node:stream'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
  "node_modules/h3/dist/index.d.ts(29,100): error TS2552: Cannot find name 'FetchEvent'. Did you mean 'TouchEvent'?",
  "node_modules/h3/dist/index.d.ts(458,11): error TS2591: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
  "node_modules/h3/dist/index.d.ts(477,116): error TS2591: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
  "node_modules/h3/dist/index.d.ts(978,31): error TS2591: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig."
].join("\n")

type H3ObservedException = Extract<
  NonNullable<TypeEvidence["observedException"]>,
  { readonly package: "h3" }
>

const h3ObservedDiagnostics: H3ObservedException["diagnostics"] = Object.freeze([
  "TS2591:node:http",
  "TS2591:node:stream",
  "TS2552:FetchEvent",
  "TS2591:Buffer"
])

function h3ObservedException(): H3ObservedException {
  return Object.freeze({
    kind: "upstream-lib-check",
    package: "h3",
    packageVersion: h3Version,
    compilerVersion: expectedTypeScriptVersion,
    export: ".",
    diagnostics: h3ObservedDiagnostics,
    compatibilityCheck: "skipLibCheck=true"
  })
}

function natsObservedException(policy: NatsTypeExceptionPolicy): NatsObservedException {
  return Object.freeze({
    kind: "upstream-exact-optional-properties",
    package: "@nats-io/nats-core",
    packageVersion: "3.4.0",
    compilerVersion: "7.0.2",
    export: policy.export,
    directDependency: policy.directDependency,
    diagnostics: natsObservedDiagnostics,
    compatibilityCheck: "exactOptionalPropertyTypes=false,skipLibCheck=false"
  })
}

interface PublishedFilePolicy {
  readonly required: ReadonlySet<string>
  readonly allowed: ReadonlySet<string>
}

const publishedJavaScriptScanner = new Bun.Transpiler({ loader: "js" })

interface DenoImports {
  [specifier: string]: string
}

export interface PublishedRuntimePackageResult {
  readonly package: string
  readonly expectedRows: number
  readonly checkedRows: number
  readonly evidence: readonly RuntimeEvidence[]
  readonly passed: boolean
  readonly detail: string | null
}

export interface PublishedTypePackageResult {
  readonly package: string
  readonly evidence: readonly TypeEvidence[]
  readonly passed: boolean
  readonly detail: string | null
}

function detail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 4_000 ? message : `${message.slice(0, 4_000)}…`
}

/** Keeps the command's first failure visible even when coverage inventory validation also fails. */
export function publishedCoverageDetail(
  label: string,
  result: CommandResult,
  inventoryDetail: string | null
): string | null {
  if (result.exitCode === 0) return inventoryDetail
  const output = commandOutput(result).trim()
  const commandDetail = `${label} failed with exit ${result.exitCode}${
    output.length === 0 ? "" : `: ${output}`
  }`
  return detail(
    new Error(inventoryDetail === null ? commandDetail : `${commandDetail}\n${inventoryDetail}`)
  )
}

function versionLine(output: string): string {
  const line = output.trim().split("\n")[0]
  if (line === undefined || line.length === 0)
    throw new Error("runtime version command returned no version")
  return line
}

function normalizedVersion(runtime: "bun" | "node" | "deno", output: string): string {
  const line = versionLine(output)
  if (runtime === "node") return line.startsWith("v") ? line.slice(1) : line
  if (runtime === "deno") {
    const match = /^deno\s+(\d+\.\d+\.\d+)/.exec(line)
    const version = match?.[1]
    if (version === undefined) throw new Error(`invalid Deno version output: ${line}`)
    return version
  }
  return line
}

function requireVersion(label: string, expected: string, observed: string): void {
  if (observed !== expected)
    throw new Error(`${label} version drift: expected ${expected}, observed ${observed}`)
}

function runtimeModulePath(stage: PublishedStage): string {
  return join(stage.root, "business-case.mjs")
}

function exportSpecifier(packageName: string, exportName: string): string {
  return exportName === "." ? packageName : `${packageName}${exportName.slice(1)}`
}

function exportSource(
  fallback: string,
  overrides: Readonly<Record<string, string>> | undefined,
  exportName: string
): string {
  return overrides?.[exportName] ?? fallback
}

async function writeCaseFiles(
  stage: PublishedStage,
  businessCase: PublishedBusinessCase,
  exportName: string
): Promise<void> {
  const specifier = exportSpecifier(businessCase.package, exportName)
  const runtimeModule = exportSource(
    businessCase.runtimeModule,
    businessCase.runtimeModules,
    exportName
  )
  const typeConsumer = exportSource(
    businessCase.typeConsumer,
    businessCase.typeConsumers,
    exportName
  )
  await mkdir(join(stage.root, ".artifacts"), { recursive: true })
  await Bun.write(
    runtimeModulePath(stage),
    [
      `import * as likegoPublishedExport from ${JSON.stringify(specifier)}`,
      "void likegoPublishedExport",
      runtimeModule
    ].join("\n")
  )
  await Bun.write(
    join(stage.root, "run-case.mjs"),
    ['import { run } from "./business-case.mjs"', "await run()", ""].join("\n")
  )
  await Bun.write(
    join(stage.root, "node-case.test.mjs"),
    [
      'import test from "node:test"',
      'import { run } from "./business-case.mjs"',
      `test(${JSON.stringify(`published behavior ${businessCase.package}`)}, run)`,
      ""
    ].join("\n")
  )
  await Bun.write(
    join(stage.root, "deno-case.test.mjs"),
    [
      'import { run } from "./business-case.mjs"',
      `Deno.test(${JSON.stringify(`published behavior ${businessCase.package}`)}, run)`,
      ""
    ].join("\n")
  )
  await Bun.write(
    join(stage.root, "type-consumer.ts"),
    [
      `import * as likegoPublishedExport from ${JSON.stringify(specifier)}`,
      "void likegoPublishedExport",
      typeConsumer
    ].join("\n")
  )
  if (businessCase.nodePreloadModule !== undefined) {
    await Bun.write(join(stage.root, nodePreloadModulePath), businessCase.nodePreloadModule)
  }
}

function isManifest(value: unknown): value is PublishedManifest {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function denoExportTarget(value: unknown): string | null {
  if (typeof value === "string") return value
  if (!isManifest(value)) return null
  if (typeof value.import === "string") return value.import
  return typeof value.default === "string" ? value.default : null
}

function registerDenoExport(
  imports: DenoImports,
  packageName: string,
  exportName: string,
  value: unknown
): void {
  const target = denoExportTarget(value)
  if (
    target === null ||
    !target.startsWith("./") ||
    target.startsWith("../") ||
    target.includes("/../") ||
    !target.endsWith(".js")
  ) {
    throw new Error(`${packageName} export ${exportName} has no published JavaScript import target`)
  }
  if (exportName !== "." && !exportName.startsWith("./")) {
    throw new Error(`${packageName} has invalid package export ${exportName}`)
  }
  const specifier = exportName === "." ? packageName : `${packageName}${exportName.slice(1)}`
  imports[specifier] = `./deno_modules/${packageName}/${target.slice(2)}`
}

/** Mirrors publish artifacts outside node_modules so Deno's native profiler records package code. */
export async function prepareDenoPackageStage(stage: PublishedStage): Promise<string> {
  const imports: DenoImports = {}
  for (const packageName of stage.workspacePackages) {
    const source = join(stage.root, "node_modules", packageName)
    const destination = join(stage.root, "deno_modules", packageName)
    await cp(source, destination, { recursive: true })
    const rawManifest: unknown = await Bun.file(join(destination, "package.json")).json()
    if (!isManifest(rawManifest))
      throw new Error(`${packageName} staged package manifest is invalid`)
    const packageExports = rawManifest.exports
    if (
      isManifest(packageExports) &&
      Object.keys(packageExports).some((name) => name.startsWith("."))
    ) {
      for (const exportName of Object.keys(packageExports).sort()) {
        if (exportName === "./package.json") continue
        registerDenoExport(imports, packageName, exportName, packageExports[exportName])
      }
    } else {
      registerDenoExport(imports, packageName, ".", packageExports)
    }
  }
  const importMapPath = join(stage.root, "deno-import-map.json")
  await Bun.write(importMapPath, `${JSON.stringify({ imports }, null, 2)}\n`)
  return importMapPath
}

function publishedJavaScriptTarget(subject: PublishedPackage, exportName: string): string {
  const exports = subject.manifest.exports
  if (!isManifest(exports)) throw new Error(`${subject.name} package exports are invalid`)
  return `${packageExportOutput(exports[exportName])}.js`
}

async function reachablePublishedJavaScript(
  subject: PublishedPackage,
  exportName: string,
  allowed: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  const pending = [publishedJavaScriptTarget(subject, exportName)]
  const reachable = new Set<string>()
  while (pending.length > 0) {
    const current = pending.shift()
    if (current === undefined || reachable.has(current)) continue
    if (!allowed.has(current)) {
      throw new Error(
        `${subject.name} export ${exportName} references missing published file ${current}`
      )
    }
    reachable.add(current)
    let imports: readonly Readonly<{ path: string }>[]
    try {
      imports = publishedJavaScriptScanner.scanImports(
        await Bun.file(join(subject.root, "dist", current)).text()
      )
    } catch {
      throw new Error(
        `${subject.name} export ${exportName} contains invalid published JavaScript: ${current}`
      )
    }
    for (const imported of imports) {
      if (!imported.path.startsWith(".")) continue
      const target = posix.normalize(posix.join(posix.dirname(current), imported.path))
      if (
        target === ".." ||
        target.startsWith("../") ||
        !target.endsWith(".js") ||
        !allowed.has(target)
      ) {
        throw new Error(
          `${subject.name} export ${exportName} has invalid relative published import ${imported.path}`
        )
      }
      if (!reachable.has(target)) pending.push(target)
    }
  }
  return Object.freeze(reachable)
}

async function publishedFilePolicy(
  subject: PublishedPackage,
  exportName: string
): Promise<PublishedFilePolicy> {
  const allowed = new Set<string>()
  const distGlob = new Bun.Glob("**/*.js")
  for await (const path of distGlob.scan({ cwd: join(subject.root, "dist"), onlyFiles: true }))
    allowed.add(path)
  if (allowed.size === 0) throw new Error(`${subject.name} has zero published JavaScript files`)
  const reachable = await reachablePublishedJavaScript(subject, exportName, allowed)
  if (reachable.size === 0)
    throw new Error(`${subject.name} has zero reachable published JavaScript files`)
  return Object.freeze({ required: reachable, allowed })
}

/** Adds one declared Node-only preload before the exact test command. */
export function publishedNodeTestArgs(
  preload: boolean,
  args: readonly string[]
): readonly string[] {
  const command = ["node"]
  if (preload) command.push(`--import=./${nodePreloadModulePath}`)
  for (const argument of args) command.push(argument)
  return Object.freeze(command)
}

export function nodeCoverageArgs(
  packageName: string,
  lcovPath: string,
  preload: boolean
): readonly string[] {
  return publishedNodeTestArgs(preload, [
    "--test",
    "--test-isolation=none",
    "--experimental-test-coverage",
    `--test-coverage-include=node_modules/${packageName}/**/*.js`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`,
    "node-case.test.mjs"
  ])
}

export function publishedDockerArgs(
  root: string,
  cidFile: string,
  ownerToken: string,
  command: readonly string[]
): readonly string[] {
  const args = [
    "docker",
    "run",
    "--rm",
    "--label",
    publishedDockerPresenceLabel,
    "--label",
    `${publishedDockerOwnerLabel}=${ownerToken}`,
    "--name",
    `likego-published-${ownerToken}`,
    "--cidfile",
    cidFile,
    "--mount",
    `type=bind,src=${root},dst=/consumer`,
    "--workdir",
    "/consumer",
    nodeLtsImage
  ]
  for (const value of command) args.push(value)
  return Object.freeze(args)
}

function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function combinedError(label: string, first: Error | null, second: unknown): Error {
  const next = normalizedError(second)
  return first === null ? next : new AggregateError([first, next], label)
}

interface DockerOwnership {
  readonly root: string
  readonly cidFile: string
  readonly ownerToken: string
}

export interface PublishedDockerCommandOptions {
  readonly timeoutMs?: number
  readonly ownerToken?: string
}

function validDockerOwnerToken(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
}

async function newDockerOwnership(
  purpose: string,
  requestedOwnerToken: string | undefined
): Promise<DockerOwnership> {
  if (!/^[a-z0-9-]+$/.test(purpose)) {
    throw new TypeError(`invalid published Docker command purpose: ${purpose}`)
  }
  const ownerToken = requestedOwnerToken ?? crypto.randomUUID()
  if (!validDockerOwnerToken(ownerToken)) {
    throw new TypeError(`invalid published Docker owner token: ${ownerToken}`)
  }
  const root = await mkdtemp(join(tmpdir(), "likego-published-docker-"))
  return Object.freeze({ root, cidFile: join(root, `${purpose}.cid`), ownerToken })
}

function dockerContainerIds(output: string): readonly string[] {
  const ids: string[] = []
  for (const line of output.split("\n")) {
    const value = line.trim()
    if (value.length === 0) continue
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`Docker returned an invalid full container ID: ${value}`)
    }
    if (!ids.includes(value)) ids.push(value)
  }
  return Object.freeze(ids)
}

async function listDockerContainers(
  stage: PublishedStage,
  filter: string
): Promise<readonly string[]> {
  const result = await runCommand(
    ["docker", "container", "ls", "--all", "--quiet", "--no-trunc", "--filter", filter],
    {
      cwd: stage.root,
      timeoutMs: dockerCleanupTimeoutMs
    }
  )
  requireCommandSuccess(`published Docker container query ${filter}`, result)
  return dockerContainerIds(commandOutput(result))
}

async function dockerContainerHasOwner(
  stage: PublishedStage,
  containerId: string,
  ownerToken: string
): Promise<boolean> {
  const result = await runCommand(
    [
      "docker",
      "container",
      "inspect",
      "--format",
      `{{ index .Config.Labels "${publishedDockerOwnerLabel}" }}`,
      containerId
    ],
    {
      cwd: stage.root,
      timeoutMs: dockerCleanupTimeoutMs
    }
  )
  if (result.exitCode !== 0) {
    const remaining = await listDockerContainers(stage, `id=${containerId}`)
    if (remaining.length === 0) return false
    requireCommandSuccess(`published Docker owner inspection ${containerId}`, result)
  }
  const observedOwner = commandOutput(result).trim()
  if (observedOwner !== ownerToken) {
    throw new Error(
      `refusing to remove Docker container ${containerId}: expected owner ${ownerToken}, observed ${observedOwner}`
    )
  }
  return true
}

async function cleanupPublishedDockerContainers(
  stage: PublishedStage,
  ownership: DockerOwnership
): Promise<boolean> {
  const cidFile = Bun.file(ownership.cidFile)
  const containerObserved = await cidFile.exists()
  let recordedContainerId: string | null = null
  let ownershipFailure: Error | null = null
  if (containerObserved) {
    const value = (await cidFile.text()).trim()
    if (/^[a-f0-9]{64}$/.test(value)) recordedContainerId = value
    else {
      ownershipFailure = new Error(
        `published Docker cidfile contains an invalid full container ID: ${ownership.cidFile}`
      )
    }
  }

  const ownerFilter = `label=${publishedDockerOwnerLabel}=${ownership.ownerToken}`
  const ownedIds = new Set(await listDockerContainers(stage, ownerFilter))
  if (recordedContainerId !== null) {
    const recordedIds = await listDockerContainers(stage, `id=${recordedContainerId}`)
    if (
      recordedIds.length > 1 ||
      (recordedIds.length === 1 && recordedIds[0] !== recordedContainerId)
    ) {
      throw new Error(`Docker returned an ambiguous container ID match for ${recordedContainerId}`)
    }
    if (
      recordedIds.length === 1 &&
      (await dockerContainerHasOwner(stage, recordedContainerId, ownership.ownerToken))
    ) {
      ownedIds.add(recordedContainerId)
    }
  }

  for (const containerId of ownedIds) {
    if (!(await dockerContainerHasOwner(stage, containerId, ownership.ownerToken))) continue
    await runCommand(["docker", "container", "rm", "--force", "--volumes", containerId], {
      cwd: stage.root,
      timeoutMs: dockerCleanupTimeoutMs
    })
  }

  const remainingOwned = await listDockerContainers(stage, ownerFilter)
  const remainingRecorded =
    recordedContainerId === null
      ? Object.freeze([])
      : await listDockerContainers(stage, `id=${recordedContainerId}`)
  if (remainingOwned.length !== 0 || remainingRecorded.length !== 0) {
    throw combinedError(
      "published Docker ownership validation failed",
      ownershipFailure,
      new Error(
        `published Docker containers remained after cleanup: ${remainingOwned.join(",")}${remainingRecorded.join(",")}`
      )
    )
  }
  if (ownershipFailure !== null) throw ownershipFailure
  return containerObserved
}

function dockerCommandResultError(purpose: string, result: CommandResult): Error {
  const output = commandOutput(result).trim()
  return new Error(
    `published Docker ${purpose} failed with exit ${result.exitCode}${
      output.length === 0 ? "" : `: ${output}`
    }`
  )
}

export function publishedDockerOutcome(
  purpose: string,
  result: CommandResult | null,
  primaryFailure: Error | null,
  cleanupFailure: Error | null,
  containerObserved: boolean
): CommandResult {
  let resolvedCleanupFailure = cleanupFailure
  if (
    result !== null &&
    result.exitCode === 0 &&
    !containerObserved &&
    resolvedCleanupFailure === null
  ) {
    resolvedCleanupFailure = new Error(
      "successful published Docker command produced no container ID"
    )
  }
  const resultFailure =
    result !== null && result.exitCode !== 0 ? dockerCommandResultError(purpose, result) : null
  const resolvedPrimaryFailure = primaryFailure ?? resultFailure
  if (resolvedPrimaryFailure !== null && resolvedCleanupFailure !== null) {
    throw new AggregateError(
      [resolvedPrimaryFailure, resolvedCleanupFailure],
      `${resolvedPrimaryFailure.message}; published Docker cleanup also failed`
    )
  }
  if (primaryFailure !== null) throw primaryFailure
  if (resolvedCleanupFailure !== null) throw resolvedCleanupFailure
  if (result === null) throw new Error("published Docker command settled without a result")
  return result
}

export async function runPublishedDockerCommand(
  stage: PublishedStage,
  command: readonly string[],
  purpose: string,
  options: PublishedDockerCommandOptions = Object.freeze({})
): Promise<CommandResult> {
  const ownership = await newDockerOwnership(purpose, options.ownerToken)
  let result: CommandResult | null = null
  let primaryFailure: Error | null = null
  try {
    const commandOptions =
      options.timeoutMs === undefined
        ? Object.freeze({ cwd: stage.root })
        : Object.freeze({ cwd: stage.root, timeoutMs: options.timeoutMs })
    result = await runCommand(
      publishedDockerArgs(stage.root, ownership.cidFile, ownership.ownerToken, command),
      commandOptions
    )
  } catch (error) {
    primaryFailure = normalizedError(error)
  }

  let cleanupFailure: Error | null = null
  let containerObserved = false
  try {
    containerObserved = await cleanupPublishedDockerContainers(stage, ownership)
  } catch (error) {
    cleanupFailure = combinedError(
      "published Docker container cleanup failed",
      cleanupFailure,
      error
    )
  }
  try {
    await rm(ownership.root, { recursive: true, force: true })
  } catch (error) {
    cleanupFailure = combinedError(
      "published Docker ownership cleanup failed",
      cleanupFailure,
      error
    )
  }
  return publishedDockerOutcome(purpose, result, primaryFailure, cleanupFailure, containerObserved)
}

function containerLcov(stage: PublishedStage, lcov: string): string {
  return lcov.replaceAll("/consumer", stage.root)
}

async function nodeEvidence(
  exportName: string,
  stage: PublishedStage,
  row: PublishedRuntimeRow,
  policy: PublishedFilePolicy,
  preload: boolean
): Promise<RuntimeEvidence> {
  const docker = row.lane === "lts"
  const expectedImage = docker ? nodeLtsImage : null
  const versionResult = docker
    ? await runPublishedDockerCommand(stage, ["node", "--version"], "node-lts-version")
    : await runCommand(["node", "--version"], { cwd: stage.root })
  requireCommandSuccess(`node-${row.lane} version`, versionResult)
  const observedVersion = normalizedVersion("node", commandOutput(versionResult))
  requireVersion(`node-${row.lane}`, row.version, observedVersion)

  const behaviorResult = docker
    ? await runPublishedDockerCommand(
        stage,
        publishedNodeTestArgs(preload, ["--test", "node-case.test.mjs"]),
        "node-lts-behavior"
      )
    : await runCommand(publishedNodeTestArgs(preload, ["--test", "node-case.test.mjs"]), {
        cwd: stage.root
      })
  requireCommandSuccess(`node-${row.lane} published behavior`, behaviorResult)

  const lcovPath = `.artifacts/node-${row.lane}.lcov`
  const coverageResult = docker
    ? await runPublishedDockerCommand(
        stage,
        nodeCoverageArgs(stage.target.name, lcovPath, preload),
        "node-lts-coverage"
      )
    : await runCommand(nodeCoverageArgs(stage.target.name, lcovPath, preload), { cwd: stage.root })
  const rawLcov = await Bun.file(join(stage.root, lcovPath)).text()
  const lcov = docker ? containerLcov(stage, rawLcov) : rawLcov
  const report = parsePublishedLcov(join(stage.root, "node_modules", stage.target.name), lcov)
  let coverageDetail: string | null = null
  try {
    requirePublishedFileInventory(`node-${row.lane}`, report, policy.required, policy.allowed)
  } catch (error) {
    coverageDetail = detail(error)
  }
  coverageDetail = publishedCoverageDetail(
    `node-${row.lane} published coverage`,
    coverageResult,
    coverageDetail
  )
  return Object.freeze({
    export: exportName,
    runtime: "node",
    lane: row.lane,
    expectedVersion: row.version,
    observedVersion,
    expectedImage,
    behaviorPassed: true,
    coverage: report.aggregate,
    coverageCounters: report.counters,
    coverageFiles: report.files,
    branches: Object.freeze({ supported: true, percent: report.aggregate.branches }),
    passed: coverageResult.exitCode === 0 && coverageDetail === null,
    detail: coverageDetail
  })
}

async function bunEvidence(
  exportName: string,
  stage: PublishedStage,
  row: PublishedRuntimeRow
): Promise<RuntimeEvidence> {
  const versionResult = await runCommand(["bun", "--version"], { cwd: stage.root })
  requireCommandSuccess("Bun version", versionResult)
  const observedVersion = normalizedVersion("bun", commandOutput(versionResult))
  requireVersion("Bun", row.version, observedVersion)
  const behaviorResult = await runCommand(["bun", "run-case.mjs"], { cwd: stage.root })
  requireCommandSuccess("Bun published behavior", behaviorResult)
  return Object.freeze({
    export: exportName,
    runtime: "bun",
    lane: row.lane,
    expectedVersion: row.version,
    observedVersion,
    expectedImage: null,
    behaviorPassed: true,
    coverage: null,
    coverageCounters: null,
    coverageFiles: null,
    branches: Object.freeze({ supported: false, percent: null, reason: bunBranchReason }),
    passed: true,
    detail: null
  })
}

function regexEscape(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function denoEvidence(
  root: string,
  exportName: string,
  stage: PublishedStage,
  row: PublishedRuntimeRow,
  policy: PublishedFilePolicy
): Promise<RuntimeEvidence> {
  const importMapPath = await prepareDenoPackageStage(stage)
  const versionResult = await runCommand(["deno", "--version"], { cwd: stage.root })
  requireCommandSuccess("Deno version", versionResult)
  const observedVersion = normalizedVersion("deno", commandOutput(versionResult))
  requireVersion("Deno", row.version, observedVersion)
  const behaviorResult = await runCommand(
    [
      "deno",
      "run",
      "--config",
      join(root, "deno.json"),
      "--import-map",
      importMapPath,
      "run-case.mjs"
    ],
    { cwd: stage.root }
  )
  requireCommandSuccess("Deno published behavior", behaviorResult)

  const rawDirectory = join(stage.root, ".artifacts", "deno-raw")
  const testResult = await runCommand(
    [
      "deno",
      "test",
      "--config",
      join(root, "deno.json"),
      "--import-map",
      importMapPath,
      "--clean",
      `--coverage=${rawDirectory}`,
      "--coverage-raw-data-only",
      "deno-case.test.mjs"
    ],
    { cwd: stage.root }
  )
  requireCommandSuccess("Deno published coverage behavior", testResult)
  const targetDistRoot = join(stage.root, "deno_modules", stage.target.name)
  const include = `${regexEscape(targetDistRoot)}/.*\\.js$`
  const lcovPath = join(stage.root, ".artifacts", "deno.lcov")
  const lcovResult = await runCommand(
    ["deno", "coverage", `--include=${include}`, "--lcov", `--output=${lcovPath}`, rawDirectory],
    { cwd: stage.root }
  )
  requireCommandSuccess("Deno published LCOV", lcovResult)
  const report = parsePublishedLcov(targetDistRoot, await Bun.file(lcovPath).text())
  let coverageDetail: string | null = null
  try {
    requirePublishedFileInventory("deno-exact", report, policy.required, policy.allowed)
  } catch (error) {
    coverageDetail = detail(error)
  }
  return Object.freeze({
    export: exportName,
    runtime: "deno",
    lane: row.lane,
    expectedVersion: row.version,
    observedVersion,
    expectedImage: null,
    behaviorPassed: true,
    coverage: report.aggregate,
    coverageCounters: report.counters,
    coverageFiles: report.files,
    branches: Object.freeze({ supported: true, percent: report.aggregate.branches }),
    passed: coverageDetail === null,
    detail: coverageDetail
  })
}

async function runtimeRowEvidence(
  root: string,
  exportName: string,
  stage: PublishedStage,
  row: PublishedRuntimeRow,
  policy: PublishedFilePolicy,
  preload: boolean
): Promise<RuntimeEvidence> {
  if (row.runtime === "bun") return bunEvidence(exportName, stage, row)
  if (row.runtime === "node") return nodeEvidence(exportName, stage, row, policy, preload)
  return denoEvidence(root, exportName, stage, row, policy)
}

function failedRuntimeRowEvidence(
  exportName: string,
  row: PublishedRuntimeRow,
  error: unknown
): RuntimeEvidence {
  const branches =
    row.runtime === "bun"
      ? Object.freeze({ supported: false, percent: null, reason: bunBranchReason })
      : Object.freeze({ supported: true, percent: null })
  return Object.freeze({
    export: exportName,
    runtime: row.runtime,
    lane: row.lane,
    expectedVersion: row.version,
    observedVersion: "unavailable",
    expectedImage: row.runtime === "node" && row.lane === "lts" ? nodeLtsImage : null,
    behaviorPassed: false,
    coverage: null,
    coverageCounters: null,
    coverageFiles: null,
    branches,
    passed: false,
    detail: detail(error)
  })
}

function expectedRuntimeRows(subject: PublishedPackage): number {
  return subject.exports.reduce((total, item) => total + item.runtimes.length, 0)
}

function businessExportsMatch(
  subject: PublishedPackage,
  businessCase: PublishedBusinessCase
): boolean {
  const expected = subject.exports.map((item) => item.name).sort()
  const actual = Array.from(businessCase.exports).sort()
  return (
    expected.length === actual.length && expected.every((name, index) => name === actual[index])
  )
}

/** Executes every exact capability row against one isolated published package stage. */
export async function runPublishedRuntimePackage(
  root: string,
  inventory: PublishedInventory,
  subject: PublishedPackage,
  businessCase: PublishedBusinessCase
): Promise<PublishedRuntimePackageResult> {
  let stage: PublishedStage | null = null
  const expectedRows = expectedRuntimeRows(subject)
  try {
    if (!businessExportsMatch(subject, businessCase)) {
      throw new Error(`${subject.name} published business export inventory drifted`)
    }
    stage = await stagePublishedPackage(root, inventory, subject.name)
    const evidence: RuntimeEvidence[] = []
    for (const publishedExport of subject.exports) {
      await writeCaseFiles(stage, businessCase, publishedExport.name)
      const policy = await publishedFilePolicy(subject, publishedExport.name)
      for (const row of publishedExport.runtimes) {
        try {
          evidence.push(
            await runtimeRowEvidence(
              root,
              publishedExport.name,
              stage,
              row,
              policy,
              businessCase.nodePreloadModule !== undefined
            )
          )
        } catch (error) {
          evidence.push(failedRuntimeRowEvidence(publishedExport.name, row, error))
        }
      }
    }
    if (evidence.length === 0 || evidence.length !== expectedRows) {
      throw new Error(`${subject.name} runtime evidence is missing capability rows`)
    }
    const passed = evidence.every((item) => item.passed)
    return Object.freeze({
      package: subject.name,
      expectedRows,
      checkedRows: evidence.length,
      evidence: Object.freeze(evidence),
      passed,
      detail: passed ? null : "one or more exact runtime rows failed"
    })
  } catch (error) {
    return Object.freeze({
      package: subject.name,
      expectedRows,
      checkedRows: 0,
      evidence: Object.freeze([]),
      passed: false,
      detail: detail(error)
    })
  } finally {
    if (stage !== null) await rm(stage.root, { recursive: true, force: true })
  }
}

async function typescriptEvidence(
  root: string,
  stage: PublishedStage,
  businessCase: PublishedBusinessCase,
  exportName: string
): Promise<TypeEvidence> {
  const compiler = join(root, "node_modules", ".bin", "tsc")
  const versionResult = await runCommand([compiler, "--version"], { cwd: stage.root })
  requireCommandSuccess("TypeScript version", versionResult)
  const observedVersion = versionLine(commandOutput(versionResult)).replace(/^Version\s+/, "")
  requireVersion("TypeScript", expectedTypeScriptVersion, observedVersion)
  const policy = natsTypeExceptionPolicy(businessCase, exportName)
  const h3LibCheckException = businessCase.package === "@likego/h3" && exportName === "."
  const hasException = policy !== null || h3LibCheckException
  const typePackages =
    dependencyVersion(stage.target.manifest, "@types/node") === null
      ? Object.freeze([])
      : Object.freeze(["node"])
  const strictResult = await runCommand(
    typescriptCheckArguments(compiler, stage.root, typePackages, true, !hasException),
    {
      cwd: stage.root
    }
  )
  let resolutionResult = strictResult
  let observedException: TypeEvidence["observedException"] = null
  if (!hasException) {
    if (strictResult.exitCode !== 0) {
      const diagnosticResult = await runCommand(
        typescriptCheckArguments(compiler, stage.root, typePackages, true, false),
        { cwd: stage.root }
      )
      requireCommandSuccess("TypeScript staged package consumer", diagnosticResult)
    }
  } else if (policy !== null) {
    const directVersion = requirePublishedProductionDependency(
      stage.target.manifest,
      policy.directDependency,
      stage.target.name
    )
    const directRoot = await realpath(join(stage.root, "node_modules", policy.directDependency))
    const observedDirectVersion = await installedPackageVersion(directRoot, policy.directDependency)
    const externalNodeModules = join(directRoot, "..", "..")
    const upstreamRoot = await realpath(join(externalNodeModules, "@nats-io", "nats-core"))
    const upstreamVersion = await installedPackageVersion(upstreamRoot, "@nats-io/nats-core")
    if (observedDirectVersion !== directVersion) {
      throw new Error(
        `${policy.directDependency} installed version drift: expected ${directVersion}, observed ${observedDirectVersion}`
      )
    }
    validateNatsExactOptionalException(
      policy,
      observedVersion,
      directVersion,
      upstreamVersion,
      strictResult.exitCode,
      commandOutput(strictResult)
    )
    resolutionResult = await runCommand(
      typescriptCheckArguments(compiler, stage.root, typePackages, false, true),
      { cwd: stage.root }
    )
    requireCommandSuccess("TypeScript staged NATS compatibility consumer", resolutionResult)
    observedException = natsObservedException(policy)
  } else {
    const upstreamRoot = await realpath(join(stage.root, "node_modules", "h3"))
    const upstreamVersion = await installedPackageVersion(upstreamRoot, "h3")
    validateH3LibCheckException(
      observedVersion,
      upstreamVersion,
      strictResult.exitCode,
      commandOutput(strictResult)
    )
    resolutionResult = await runCommand(
      typescriptCheckArguments(compiler, stage.root, typePackages, true, true, true),
      { cwd: stage.root }
    )
    requireCommandSuccess("TypeScript staged H3 compatibility consumer", resolutionResult)
    observedException = h3ObservedException()
  }
  const expectedPath = publishedTypeTarget(stage, exportName)
  if (!commandOutput(resolutionResult).includes(expectedPath)) {
    throw new Error(
      `TypeScript did not resolve ${exportSpecifier(stage.target.name, exportName)} through ${expectedPath}`
    )
  }
  return Object.freeze({
    export: exportName,
    authority: "typescript",
    expectedVersion: expectedTypeScriptVersion,
    observedVersion,
    passed: true,
    detail: null,
    observedException
  })
}

function natsTypeExceptionPolicy(
  businessCase: PublishedBusinessCase,
  exportName: string
): NatsTypeExceptionPolicy | null {
  return (
    businessCase.natsExactOptionalPolicies?.find((policy) => policy.export === exportName) ?? null
  )
}

function dependencyVersion(manifest: PublishedManifest, dependency: string): string | null {
  for (const field of ["dependencies", "optionalDependencies"]) {
    const dependencies = manifest[field]
    if (!isManifest(dependencies)) continue
    const version = dependencies[dependency]
    if (typeof version === "string") return version
  }
  return null
}

/** Returns exact production dependency evidence and ignores development-only declarations. */
export function requirePublishedProductionDependency(
  manifest: PublishedManifest,
  dependency: string,
  packageName = "published package"
): string {
  const version = dependencyVersion(manifest, dependency)
  if (version === null) {
    throw new Error(`${packageName} is missing exact ${dependency} dependency evidence`)
  }
  return version
}

function publishedTypeTarget(stage: PublishedStage, exportName: string): string {
  const exports = stage.target.manifest.exports
  if (!isManifest(exports)) {
    throw new Error(`${stage.target.name} package exports are invalid`)
  }
  return join(
    stage.root,
    "node_modules",
    stage.target.name,
    `${packageExportOutput(exports[exportName])}.d.ts`
  )
}

async function installedPackageVersion(root: string, expectedName: string): Promise<string> {
  const value: unknown = await Bun.file(join(root, "package.json")).json()
  if (!isManifest(value) || value.name !== expectedName || typeof value.version !== "string") {
    throw new Error(`${expectedName} installed package evidence is invalid`)
  }
  return value.version
}

function normalizedNatsDiagnostics(output: string): string {
  const normalized: string[] = []
  for (const line of output.trim().split("\n")) {
    const marker = line.indexOf("@nats-io/nats-core/lib/")
    normalized.push(marker === -1 ? line : line.slice(marker))
  }
  return normalized.join("\n")
}

function normalizedH3Diagnostics(output: string): string {
  const normalized: string[] = []
  for (const line of output.trim().split("\n")) {
    const marker = line.indexOf("node_modules/h3/dist/")
    normalized.push(marker === -1 ? line : line.slice(marker))
  }
  return normalized.join("\n")
}

/** Accepts only H3 1.15.11's version-bound declaration defects under TypeScript 7.0.2. */
export function validateH3LibCheckException(
  compilerVersion: string,
  upstreamVersion: string,
  exitCode: number,
  output: string
): void {
  if (compilerVersion !== expectedTypeScriptVersion) {
    throw new Error(`H3 TypeScript exception compiler drift: ${compilerVersion}`)
  }
  if (upstreamVersion !== h3Version) {
    throw new Error(`H3 TypeScript exception SDK drift: ${upstreamVersion}`)
  }
  if (exitCode !== 1) {
    throw new Error(`H3 TypeScript exception disappeared or changed exit status: ${exitCode}`)
  }
  const diagnostics = normalizedH3Diagnostics(output)
  if (diagnostics !== h3ExpectedDiagnostics) {
    throw new Error(`H3 TypeScript exception diagnostics drifted:\n${diagnostics}`)
  }
}

/** Accepts only the two version-bound TS 7 exact-optional defects in NATS Core 3.4.0. */
export function validateNatsExactOptionalException(
  policy: PublishedNatsExactOptionalPolicy,
  compilerVersion: string,
  directDependencyVersion: string,
  upstreamVersion: string,
  exitCode: number,
  output: string
): void {
  if (
    policy.directDependency !== "@nats-io/transport-node" &&
    policy.directDependency !== "@nats-io/jetstream"
  ) {
    throw new Error(`unknown NATS direct dependency policy: ${policy.directDependency}`)
  }
  if (compilerVersion !== expectedTypeScriptVersion) {
    throw new Error(`NATS TypeScript exception compiler drift: ${compilerVersion}`)
  }
  if (directDependencyVersion !== natsCoreVersion || upstreamVersion !== natsCoreVersion) {
    throw new Error(
      `NATS TypeScript exception SDK drift: direct=${directDependencyVersion}, upstream=${upstreamVersion}`
    )
  }
  if (exitCode !== 1) {
    throw new Error(`NATS TypeScript exception disappeared or changed exit status: ${exitCode}`)
  }
  const diagnostics = normalizedNatsDiagnostics(output)
  if (diagnostics !== natsExpectedDiagnostics) {
    throw new Error(`NATS TypeScript exception diagnostics drifted:\n${diagnostics}`)
  }
}

function typescriptCheckArguments(
  compiler: string,
  stageRoot: string,
  typePackages: readonly string[],
  exactOptionalPropertyTypes: boolean,
  traceResolution: boolean,
  skipLibCheck = false
): string[] {
  const args = [
    compiler,
    "--ignoreConfig",
    "--pretty",
    "false",
    "--noEmit",
    "--target",
    "ES2023",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--lib",
    "ES2023,ESNext.Disposable,DOM,DOM.Iterable",
    "--strict",
    "--exactOptionalPropertyTypes",
    exactOptionalPropertyTypes ? "true" : "false",
    "--noUncheckedIndexedAccess",
    "--skipLibCheck",
    skipLibCheck ? "true" : "false",
    "--typeRoots",
    join(stageRoot, "node_modules", "@types")
  ]
  if (typePackages.length > 0) args.push("--types", typePackages.join(","))
  if (traceResolution) args.push("--traceResolution")
  args.push("type-consumer.ts")
  return args
}

async function denoTypeEvidence(
  root: string,
  stage: PublishedStage,
  exportName: string,
  row: PublishedRuntimeRow
): Promise<TypeEvidence> {
  const importMapPath = await prepareDenoPackageStage(stage)
  const versionResult = await runCommand(["deno", "--version"], { cwd: stage.root })
  requireCommandSuccess("Deno type version", versionResult)
  const observedVersion = normalizedVersion("deno", commandOutput(versionResult))
  requireVersion("Deno type", row.version, observedVersion)
  const checkResult = await runCommand(
    [
      "deno",
      "check",
      "--config",
      join(root, "deno.json"),
      "--import-map",
      importMapPath,
      "type-consumer.ts"
    ],
    { cwd: stage.root }
  )
  requireCommandSuccess("Deno staged package type consumer", checkResult)
  return Object.freeze({
    export: exportName,
    authority: "deno",
    expectedVersion: row.version,
    observedVersion,
    passed: true,
    detail: null,
    observedException: null
  })
}

/** Runs TypeScript authority and portable Deno self-types checks against staged declarations. */
export async function runPublishedTypePackage(
  root: string,
  inventory: PublishedInventory,
  subject: PublishedPackage,
  businessCase: PublishedBusinessCase
): Promise<PublishedTypePackageResult> {
  let stage: PublishedStage | null = null
  try {
    if (!businessExportsMatch(subject, businessCase)) {
      throw new Error(`${subject.name} published business export inventory drifted`)
    }
    stage = await stagePublishedPackage(root, inventory, subject.name)
    const evidence: TypeEvidence[] = []
    for (const publishedExport of subject.exports) {
      await writeCaseFiles(stage, businessCase, publishedExport.name)
      evidence.push(await typescriptEvidence(root, stage, businessCase, publishedExport.name))
      const denoRow = publishedExport.runtimes.find((row) => row.runtime === "deno")
      if (denoRow !== undefined) {
        evidence.push(await denoTypeEvidence(root, stage, publishedExport.name, denoRow))
      }
    }
    return Object.freeze({
      package: subject.name,
      evidence: Object.freeze(evidence),
      passed: true,
      detail: null
    })
  } catch (error) {
    return Object.freeze({
      package: subject.name,
      evidence: Object.freeze([]),
      passed: false,
      detail: detail(error)
    })
  } finally {
    if (stage !== null) await rm(stage.root, { recursive: true, force: true })
  }
}

import { mkdir } from "node:fs/promises"
import { join, relative } from "node:path"

import { discoverWorkspaces } from "../../tools/workspaces/discovery"
import type { PublishedInventory, PublishedPackage } from "./contracts"

interface PackageBuildStamp {
  readonly package: string
  readonly outputSha256: string
  readonly outputFiles: readonly string[]
}

interface PublishedBuildStamp {
  readonly schemaVersion: 2
  readonly buildInputSha256: string
  readonly buildInputFiles: readonly string[]
  readonly packages: readonly PackageBuildStamp[]
}

interface JsonObject {
  readonly [key: string]: unknown
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function files(root: string, patterns: readonly string[]): Promise<readonly string[]> {
  const paths = new Set<string>()
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern)
    for await (const path of glob.scan({ cwd: root, onlyFiles: true })) paths.add(path)
  }
  return Object.freeze(Array.from(paths).sort())
}

async function digest(root: string, paths: readonly string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const path of paths) {
    hasher.update(path)
    hasher.update("\0")
    hasher.update(await Bun.file(join(root, path)).bytes())
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

const requiredRootBuildInputs = Object.freeze([
  "bun.lock",
  "package.json",
  "scripts/annotate-dist.ts",
  "scripts/package-dist.ts",
  "tools/workspaces/discovery.ts",
  "tsconfig.base.json",
  "tsconfig.tsdown.json",
  "tsdown.config.ts"
])

async function buildInputs(root: string): Promise<readonly string[]> {
  const patterns = Array.from(requiredRootBuildInputs)
  const workspaces = await discoverWorkspaces(root)
  let workspaceCount = 0
  for (const workspace of workspaces) {
    if (workspace.private) continue
    workspaceCount += 1
    patterns.push(workspace.manifestPath)
    patterns.push(`${workspace.root}/LICENSE`)
    patterns.push(`${workspace.root}/README.md`)
    patterns.push(`${workspace.root}/tsconfig.json`)
    patterns.push(`${workspace.root}/src/**/*.ts`)
  }
  if (workspaceCount === 0) {
    throw new Error("published build stamp discovered zero workspace build inputs")
  }
  const paths = await files(root, patterns)
  for (const path of requiredRootBuildInputs) {
    if (!paths.includes(path)) throw new Error(`published build input is missing: ${path}`)
  }
  for (const workspace of workspaces) {
    if (workspace.private) continue
    for (const path of [
      workspace.manifestPath,
      `${workspace.root}/LICENSE`,
      `${workspace.root}/README.md`,
      `${workspace.root}/tsconfig.json`
    ]) {
      if (!paths.includes(path)) throw new Error(`published build input is missing: ${path}`)
    }
  }
  return paths
}

async function packageBuildStamp(subject: PublishedPackage): Promise<PackageBuildStamp> {
  const outputFiles = await files(subject.root, [
    "dist/**/*.js",
    "dist/**/*.d.ts",
    "dist/LICENSE",
    "dist/README.md",
    "dist/package.json"
  ])
  if (outputFiles.length === 0)
    throw new Error(`${subject.name} has zero distribution outputs for published build stamp`)
  return Object.freeze({
    package: subject.name,
    outputSha256: await digest(subject.root, outputFiles),
    outputFiles
  })
}

function stampPath(root: string): string {
  return join(root, ".artifacts", "published-build.json")
}

/** Writes one deterministic hash authority immediately after a successful root build. */
export async function writePublishedBuildStamp(
  root: string,
  inventory: PublishedInventory
): Promise<void> {
  const buildInputFiles = await buildInputs(root)
  const packages: PackageBuildStamp[] = []
  for (const subject of inventory.packages) packages.push(await packageBuildStamp(subject))
  const stamp: PublishedBuildStamp = Object.freeze({
    schemaVersion: 2,
    buildInputSha256: await digest(root, buildInputFiles),
    buildInputFiles,
    packages: Object.freeze(packages)
  })
  await mkdir(join(root, ".artifacts"), { recursive: true })
  await Bun.write(stampPath(root), `${JSON.stringify(stamp, null, 2)}\n`)
}

function decodePackageStamp(value: unknown): PackageBuildStamp | null {
  if (!isJsonObject(value)) return null
  if (
    typeof value.package !== "string" ||
    typeof value.outputSha256 !== "string" ||
    !Array.isArray(value.outputFiles) ||
    !value.outputFiles.every((path) => typeof path === "string")
  )
    return null
  const outputFiles: string[] = []
  for (const path of value.outputFiles) if (typeof path === "string") outputFiles.push(path)
  return Object.freeze({
    package: value.package,
    outputSha256: value.outputSha256,
    outputFiles: Object.freeze(outputFiles)
  })
}

async function readPublishedBuildStamp(root: string): Promise<PublishedBuildStamp> {
  const path = stampPath(root)
  if (!(await Bun.file(path).exists()))
    throw new Error("published build stamp is missing; run the root build first")
  const raw: unknown = JSON.parse(await Bun.file(path).text())
  if (
    !isJsonObject(raw) ||
    raw.schemaVersion !== 2 ||
    typeof raw.buildInputSha256 !== "string" ||
    !Array.isArray(raw.buildInputFiles) ||
    !raw.buildInputFiles.every((path) => typeof path === "string") ||
    !Array.isArray(raw.packages)
  ) {
    throw new Error("published build stamp has an invalid shape")
  }
  const buildInputFiles: string[] = []
  for (const value of raw.buildInputFiles)
    if (typeof value === "string") buildInputFiles.push(value)
  const packages: PackageBuildStamp[] = []
  const names = new Set<string>()
  for (const value of raw.packages) {
    const subject = decodePackageStamp(value)
    if (subject === null)
      throw new Error("published build stamp contains an invalid package record")
    if (names.has(subject.package))
      throw new Error(`published build stamp contains duplicate package ${subject.package}`)
    names.add(subject.package)
    packages.push(subject)
  }
  return Object.freeze({
    schemaVersion: 2,
    buildInputSha256: raw.buildInputSha256,
    buildInputFiles: Object.freeze(buildInputFiles),
    packages: Object.freeze(packages)
  })
}

/** Verifies each staged package still matches the exact successful build inputs and outputs. */
export async function verifyPublishedBuildStamp(
  root: string,
  subjects: readonly PublishedPackage[]
): Promise<void> {
  const stamp = await readPublishedBuildStamp(root)
  const actualBuildInputFiles = await buildInputs(root)
  const actualBuildInputSha256 = await digest(root, actualBuildInputFiles)
  if (
    stamp.buildInputSha256 !== actualBuildInputSha256 ||
    JSON.stringify(stamp.buildInputFiles) !== JSON.stringify(actualBuildInputFiles)
  ) {
    throw new Error("published build inputs changed after the successful build")
  }
  for (const subject of subjects) {
    const matches = stamp.packages.filter((entry) => entry.package === subject.name)
    if (matches.length !== 1)
      throw new Error(`${subject.name} is missing from published build stamp`)
    const expected = matches[0]
    if (expected === undefined)
      throw new Error(`${subject.name} published build stamp record is missing`)
    const actual = await packageBuildStamp(subject)
    if (
      expected.outputSha256 !== actual.outputSha256 ||
      JSON.stringify(expected.outputFiles) !== JSON.stringify(actual.outputFiles)
    ) {
      throw new Error(
        `${subject.name} has stale distribution output relative to the published build stamp`
      )
    }
  }
}

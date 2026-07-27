import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { publishedCoverageMarker, type PublishedPackage } from "./contracts"
import { discoverPublishedPackages } from "./inventory"
import {
  runPublishedRuntimePackage,
  runPublishedTypePackage,
  type PublishedRuntimePackageResult,
  type PublishedTypePackageResult
} from "./runner"
import { publishedBusinessCases } from "../../test/published/business-cases"

type PublishedGate = "runtime" | "types"
type PublishedGateScope = "full" | "selected"
type PublishedPackageResult = PublishedRuntimePackageResult | PublishedTypePackageResult

const expectedReleaseBlockingPackageCount = 46

interface PublishedArguments {
  readonly gate: PublishedGate
  readonly packages: readonly string[]
}

interface PublishedGateResult {
  readonly schemaVersion: 1
  readonly marker: string
  readonly gate: PublishedGate
  readonly scope: PublishedGateScope
  readonly selection: readonly string[]
  readonly status: "pass" | "fail"
  readonly subjects: Readonly<{
    expected: number
    checked: number
  }>
  readonly packages: readonly PublishedPackageResult[]
}

/** Returns the canonical or explicitly selected evidence path for one published gate. */
export function publishedGateArtifactPath(
  root: string,
  gate: PublishedGate,
  scope: PublishedGateScope
): string {
  const name = scope === "full" ? `${gate}-result.json` : `${gate}-selected-result.json`
  return join(root, ".artifacts", "published", name)
}

/** Removes stale full and selected evidence before any new published gate attempt. */
export async function clearPublishedGateArtifacts(
  root: string,
  gate: PublishedGate
): Promise<void> {
  await Promise.all([
    rm(publishedGateArtifactPath(root, gate, "full"), { force: true }),
    rm(publishedGateArtifactPath(root, gate, "selected"), { force: true })
  ])
}

/** Locks the full release surface to 46 packages and one exact business case per package. */
export function validatePublishedReleaseInventory(
  releasePackages: readonly string[],
  businessCases: readonly string[]
): void {
  if (releasePackages.length !== expectedReleaseBlockingPackageCount) {
    throw new Error(
      `published gate requires exactly ${expectedReleaseBlockingPackageCount} release-blocking packages; found ${releasePackages.length}`
    )
  }
  const expected = Array.from(releasePackages).sort()
  const actual = Array.from(businessCases).sort()
  if (
    expected.length !== actual.length ||
    expected.some((packageName, index) => packageName !== actual[index])
  ) {
    throw new Error(
      `published business-case inventory drifted: release=${expected.join(",")} cases=${actual.join(",")}`
    )
  }
}

function parseArguments(args: readonly string[]): PublishedArguments {
  let gate: PublishedGate | null = null
  const packages: string[] = []
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === undefined || value === undefined || value.length === 0) {
      throw new TypeError("published gate arguments must be name/value pairs")
    }
    if (name === "--gate" && (value === "runtime" || value === "types") && gate === null) {
      gate = value
    } else if (name === "--package" && !packages.includes(value)) {
      packages.push(value)
    } else {
      throw new TypeError(`invalid or duplicate published gate argument: ${name}`)
    }
  }
  if (gate === null) throw new TypeError("published gate requires --gate runtime|types")
  return Object.freeze({ gate, packages: Object.freeze(packages) })
}

function missingCase(subject: PublishedPackage, gate: PublishedGate): PublishedPackageResult {
  if (gate === "runtime") {
    const expectedRows = subject.exports.reduce(
      (total, publishedExport) => total + publishedExport.runtimes.length,
      0
    )
    return Object.freeze({
      package: subject.name,
      expectedRows,
      checkedRows: 0,
      evidence: Object.freeze([]),
      passed: false,
      detail: `missing published business case for ${subject.name}`
    })
  }
  return Object.freeze({
    package: subject.name,
    evidence: Object.freeze([]),
    passed: false,
    detail: `missing published business case for ${subject.name}`
  })
}

/** Executes one complete manifest-driven published gate and writes its machine evidence. */
export async function runPublishedGate(
  root: string,
  args: readonly string[]
): Promise<PublishedGateResult> {
  const parsed = parseArguments(args)
  const scope: PublishedGateScope = parsed.packages.length === 0 ? "full" : "selected"
  await clearPublishedGateArtifacts(root, parsed.gate)
  const inventory = await discoverPublishedPackages(root)
  const releaseSubjects = inventory.packages.filter((subject) => subject.releaseBlocking)
  const registry = publishedBusinessCases()
  validatePublishedReleaseInventory(
    releaseSubjects.map((subject) => subject.name),
    registry.list().map((businessCase) => businessCase.package)
  )
  const selected = releaseSubjects.filter(
    (subject) => parsed.packages.length === 0 || parsed.packages.includes(subject.name)
  )
  if (selected.length === 0)
    throw new Error("published gate selected zero release-blocking subjects")
  for (const packageName of parsed.packages) {
    if (!selected.some((subject) => subject.name === packageName)) {
      throw new Error(`published gate package is missing or not release-blocking: ${packageName}`)
    }
  }
  const results: PublishedPackageResult[] = []
  for (const subject of selected) {
    const businessCase = registry.get(subject.name)
    if (businessCase === null) {
      results.push(missingCase(subject, parsed.gate))
      continue
    }
    results.push(
      parsed.gate === "runtime"
        ? await runPublishedRuntimePackage(root, inventory, subject, businessCase)
        : await runPublishedTypePackage(root, inventory, subject, businessCase)
    )
  }
  if (results.length !== selected.length)
    throw new Error("published gate package evidence is incomplete")
  const passed = results.every((result) => result.passed)
  const result: PublishedGateResult = Object.freeze({
    schemaVersion: 1,
    marker:
      parsed.gate === "runtime" ? publishedCoverageMarker : "LIKEGO_PUBLISHED_TYPE_AUTHORITY_V1",
    gate: parsed.gate,
    scope,
    selection: Object.freeze(selected.map((subject) => subject.name)),
    status: passed ? "pass" : "fail",
    subjects: Object.freeze({ expected: selected.length, checked: results.length }),
    packages: Object.freeze(results)
  })
  const artifacts = join(root, ".artifacts", "published")
  await mkdir(artifacts, { recursive: true })
  await Bun.write(
    publishedGateArtifactPath(root, parsed.gate, scope),
    `${JSON.stringify(result, null, 2)}\n`
  )
  return result
}

async function main(): Promise<number> {
  try {
    const result = await runPublishedGate(process.cwd(), process.argv.slice(2))
    process.stdout.write(`${result.marker}=${JSON.stringify(result)}\n`)
    return result.status === "pass" ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`LIKEGO_PUBLISHED_GATE_ERROR ${message}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()

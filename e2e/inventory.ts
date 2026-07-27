import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { SourcedCase } from "./case"
import { suiteDefinitions } from "./suites"

export interface MigrationBaseline {
  readonly businessE2eCaseIds: readonly string[]
  readonly dockerSuiteIds: readonly string[]
}

export interface SourcedE2eInventory {
  readonly cases: readonly SourcedCase[]
  readonly migrationBaseline: MigrationBaseline
  readonly suiteDefinitions: ReturnType<typeof suiteDefinitions>
}

const ExpectedBaselineCaseCount = 53
const ExpectedBaselineDockerSuiteCount = 6

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function StringSet(value: unknown, expectedCount: number, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length !== expectedCount ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new TypeError(`${label} must contain exactly ${expectedCount} non-empty identifiers`)
  }
  const values = value.filter((entry): entry is string => typeof entry === "string")
  if (new Set(values).size !== values.length)
    throw new TypeError(`${label} must not contain duplicates`)
  return Object.freeze(values)
}

/** Loads the immutable migration floor that later E2E inventories may only preserve or extend. */
export async function loadMigrationBaseline(root: string): Promise<MigrationBaseline> {
  const path = resolve(root, "test/fixtures/2026-07-19-migration-baseline.json")
  let value: unknown
  try {
    value = await Bun.file(path).json()
  } catch {
    throw new TypeError("migration E2E baseline must be valid JSON")
  }
  if (
    !IsRecord(value) ||
    Object.keys(value).sort().join(",") !== "businessE2eCaseIds,dockerSuiteIds"
  ) {
    throw new TypeError("migration E2E baseline must contain only the approved identifier sets")
  }
  return Object.freeze({
    businessE2eCaseIds: StringSet(
      value.businessE2eCaseIds,
      ExpectedBaselineCaseCount,
      "migration business E2E case baseline"
    ),
    dockerSuiteIds: StringSet(
      value.dockerSuiteIds,
      ExpectedBaselineDockerSuiteCount,
      "migration Docker suite baseline"
    )
  })
}

function RequireMigrationBaseline(
  cases: readonly SourcedCase[],
  baseline: MigrationBaseline,
  definitions: ReturnType<typeof suiteDefinitions>
): void {
  const caseIds = new Set(cases.map((sourcedCase) => sourcedCase.id))
  for (const caseId of baseline.businessE2eCaseIds) {
    if (!caseIds.has(caseId)) throw new Error(`migration business E2E case is missing: ${caseId}`)
  }
  const dockerSuiteIds = new Set(
    definitions.filter((definition) => definition.docker).map((definition) => definition.id)
  )
  for (const suiteId of baseline.dockerSuiteIds) {
    if (!dockerSuiteIds.has(suiteId))
      throw new Error(`migration Docker suite is missing: ${suiteId}`)
  }
}

/** Reports whether an imported case module exposes the exact sourced-case shape used by the runner. */
function sourcedCase(value: unknown): value is SourcedCase {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "domain" in value &&
    typeof value.domain === "string" &&
    "source" in value &&
    typeof value.source === "object" &&
    value.source !== null &&
    "normalizedScenario" in value &&
    typeof value.normalizedScenario === "string" &&
    "runtimes" in value &&
    Array.isArray(value.runtimes) &&
    "services" in value &&
    Array.isArray(value.services) &&
    "assertions" in value &&
    Array.isArray(value.assertions) &&
    "cleanupEvidence" in value &&
    Array.isArray(value.cleanupEvidence) &&
    "assertionScenarios" in value &&
    Array.isArray(value.assertionScenarios) &&
    "cleanupProofs" in value &&
    Array.isArray(value.cleanupProofs) &&
    "suite" in value &&
    typeof value.suite === "string" &&
    "scenario" in value &&
    typeof value.scenario === "string" &&
    "run" in value &&
    typeof value.run === "function"
  )
}

async function LoadSourcedCaseModules(root: string): Promise<readonly SourcedCase[]> {
  const paths: string[] = []
  const casesRoot = resolve(root, "e2e/cases")
  for await (const path of new Bun.Glob("*.case.ts").scan({ cwd: casesRoot, onlyFiles: true })) {
    paths.push(path)
  }
  paths.sort()

  const cases: SourcedCase[] = []
  for (const path of paths) {
    const moduleValue: unknown = await import(pathToFileURL(resolve(casesRoot, path)).href)
    if (
      typeof moduleValue !== "object" ||
      moduleValue === null ||
      !("sourcedCase" in moduleValue) ||
      !sourcedCase(moduleValue.sourcedCase)
    ) {
      throw new Error(`case module ${path} must export one sourcedCase`)
    }
    cases.push(moduleValue.sourcedCase)
  }
  cases.sort(function byIdentifier(left, right) {
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  return Object.freeze(cases)
}

/** Loads one immutable case, baseline, and suite-definition snapshot for an E2E run. */
export async function loadSourcedE2eInventory(root: string): Promise<SourcedE2eInventory> {
  const cases = await LoadSourcedCaseModules(root)
  const migrationBaseline = await loadMigrationBaseline(root)
  const definitions = suiteDefinitions()
  RequireMigrationBaseline(cases, migrationBaseline, definitions)
  return Object.freeze({
    cases,
    migrationBaseline,
    suiteDefinitions: definitions
  })
}

/** Loads the one-module-per-use-case inventory in deterministic identifier order. */
export async function loadSourcedCases(root: string): Promise<readonly SourcedCase[]> {
  return (await loadSourcedE2eInventory(root)).cases
}

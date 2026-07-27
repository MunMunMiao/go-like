import { resolve } from "node:path"

import type { CaseResult, SuiteEvidence } from "./case"
import { loadSourcedE2eInventory } from "./inventory"
import { runSuite } from "./suites"
import { validateSourcedCases } from "./validate"

interface CliOptions {
  readonly inventoryOnly: boolean
  readonly suites: ReadonlySet<string>
}

/** Parses the narrow sourced-E2E command line without accepting ambiguous positional arguments. */
function options(args: readonly string[]): CliOptions {
  let inventoryOnly = false
  const suites = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--inventory") {
      inventoryOnly = true
      continue
    }
    if (argument === "--suite") {
      const suite = args[index + 1]
      if (suite === undefined || suite.startsWith("--"))
        throw new Error("--suite requires one identifier")
      suites.add(suite)
      index += 1
      continue
    }
    throw new Error(`unknown sourced E2E argument ${String(argument)}`)
  }
  return Object.freeze({ inventoryOnly, suites })
}

/** Runs the complete sourced inventory or a selected suite subset and emits one JSON result. */
export async function runSourcedE2e(root: string, args: readonly string[]): Promise<void> {
  const configured = options(args)
  const sourcedInventory = await loadSourcedE2eInventory(root)
  const cases = sourcedInventory.cases
  const migrationBaseline = sourcedInventory.migrationBaseline
  const inventory = validateSourcedCases(cases, sourcedInventory.suiteDefinitions)
  if (configured.inventoryOnly && configured.suites.size > 0) {
    throw new Error("sourced E2E inventory mode does not accept suite selection")
  }
  const definitions = sourcedInventory.suiteDefinitions
  const declaredSuites = new Set(
    definitions.map(function suiteId(definition) {
      return definition.id
    })
  )
  for (const requestedSuite of Array.from(configured.suites).sort()) {
    if (!declaredSuites.has(requestedSuite)) {
      throw new Error(`unknown sourced E2E suite ${requestedSuite}`)
    }
  }
  if (configured.inventoryOnly) {
    process.stdout.write(
      `LIKEGO_SOURCED_E2E_RESULT=${JSON.stringify({
        valid: true,
        mode: "inventory",
        inventory,
        migrationBaseline: Object.freeze({
          cases: migrationBaseline.businessE2eCaseIds.length,
          dockerSuites: migrationBaseline.dockerSuiteIds.length
        })
      })}\n`
    )
    return
  }

  const releaseSuites = new Set(
    definitions
      .filter(function blocking(definition) {
        return definition.releaseBlocking
      })
      .map(function suiteId(definition) {
        return definition.id
      })
  )
  const evidenceOnlySuites = Object.freeze(
    definitions
      .filter(function evidenceOnly(definition) {
        return !definition.releaseBlocking
      })
      .map(function suiteId(definition) {
        return definition.id
      })
      .sort()
  )
  const selectedCases =
    configured.suites.size === 0
      ? cases.filter(function releaseCase(sourcedCase) {
          return releaseSuites.has(sourcedCase.suite)
        })
      : cases.filter(function selected(sourcedCase) {
          return configured.suites.has(sourcedCase.suite)
        })
  if (selectedCases.length === 0)
    throw new Error("selected sourced E2E suites do not own any cases")
  const suiteIds = Array.from(
    new Set(
      selectedCases.map(function suiteId(sourcedCase) {
        return sourcedCase.suite
      })
    )
  ).sort()
  const evidenceBySuite = new Map<string, SuiteEvidence>()
  for (const suite of suiteIds) {
    process.stderr.write(
      `LIKEGO_SOURCED_E2E_PROGRESS=${JSON.stringify({ suite, status: "running" })}\n`
    )
    const evidence = await runSuite(root, suite)
    evidenceBySuite.set(suite, evidence)
    process.stderr.write(
      `LIKEGO_SOURCED_E2E_PROGRESS=${JSON.stringify({
        suite,
        status: "passed",
        scenarios: evidence.scenarios.length
      })}\n`
    )
  }

  const results: CaseResult[] = []
  for (const sourcedCase of selectedCases) {
    const evidence = evidenceBySuite.get(sourcedCase.suite)
    if (evidence === undefined)
      throw new Error(`missing executed suite evidence ${sourcedCase.suite}`)
    results.push(sourcedCase.run(evidence))
  }
  const serviceVersions = Object.freeze(
    Array.from(
      new Set(
        Array.from(evidenceBySuite.values()).flatMap(function services(evidence) {
          return evidence.services
        })
      )
    ).sort()
  )
  process.stdout.write(
    `LIKEGO_SOURCED_E2E_RESULT=${JSON.stringify({
      valid: results.length === selectedCases.length,
      mode: configured.suites.size === 0 ? "release" : "selected",
      inventory,
      inventoryCases: cases.length,
      migrationBaseline: Object.freeze({
        cases: migrationBaseline.businessE2eCaseIds.length,
        dockerSuites: migrationBaseline.dockerSuiteIds.length
      }),
      executedCases: results.length,
      executedSuites: suiteIds,
      evidenceOnlySuites,
      serviceVersions,
      cleanupValid: Array.from(evidenceBySuite.values()).every(function cleaned(evidence) {
        return evidence.cleanupValid
      }),
      results
    })}\n`
  )
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..")
  try {
    await runSourcedE2e(root, process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `LIKEGO_SOURCED_E2E_RESULT=${JSON.stringify({ valid: false, error: message })}\n`
    )
    process.exitCode = 1
  }
}

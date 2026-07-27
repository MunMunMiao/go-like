import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import { newSourcedCase, type SuiteEvidence } from "./case"
import { loadMigrationBaseline, loadSourcedCases, loadSourcedE2eInventory } from "./inventory"
import { runSourcedE2e } from "./run"
import { evaluateSuiteEvidence, suiteDefinitions } from "./suites"
import { validateSourcedCases } from "./validate"

const Root = resolve(import.meta.dir, "..")
const QuoteBoundary = "Link only; behavior paraphrased; no verbatim source copied."

function winstonDetails(): Readonly<Record<string, unknown>> {
  return {
    valid: true,
    runtime: "Node.js 26.5.0",
    winstonVersion: "3.19.0",
    scenarios: ["winston-native-file-lifecycle"],
    scenarioEvidence: {
      "winston-native-file-lifecycle": {
        component: "winston",
        final: true,
        message: "native logger",
        level: "info",
        joinedStops: true,
        startPendingBeforeStop: true,
        nativeFinishObserved: true,
        fileLanded: true,
        lifecycleOrder: "native-finish>stop-resolved>start-resolved>file-read",
        finishBeforeStopResolution: true,
        finishBeforeStartResolution: true,
        finalRecordReadAfterFinish: true
      }
    },
    assertions: { nativeLoggerRecord: true, joinedStops: true, fileLanded: true },
    cleanup: { terminalCompleted: true, listenerDelta: 0, directoryRemoved: true }
  }
}

function evaluateWinston(details: Readonly<Record<string, unknown>>) {
  return evaluateSuiteEvidence("winston-runtime", {
    details,
    runtime: "Node.js 26.5.0",
    runtimeVersion: "26.5.0",
    runtimeProof: "command:node --version",
    processTreeClean: true,
    dockerResourcesRestored: true
  })
}

/** Constructs one isolated valid case for boundary tests. */
function validCase() {
  return newSourcedCase({
    id: "boundary-case",
    domain: "web",
    source: {
      url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      retrievedAt: "2026-07-18",
      quoteBoundary: QuoteBoundary
    },
    normalizedScenario: "One boundary case.",
    runtimes: ["Bun 1.3.14"],
    services: ["standard Fetch"],
    assertions: ["The boundary is observable."],
    cleanupEvidence: ["No resource remains."],
    suite: "kernel-native",
    scenario: "boundary-scenario"
  })
}

describe("sourced E2E inventory", () => {
  test("loads one frozen case baseline and suite-definition snapshot", async () => {
    const inventory = await loadSourcedE2eInventory(Root)

    expect(inventory.cases).toHaveLength(81)
    expect(inventory.suiteDefinitions).toHaveLength(28)
    expect(inventory.migrationBaseline.businessE2eCaseIds).toHaveLength(53)
    expect(inventory.migrationBaseline.dockerSuiteIds).toHaveLength(6)
    expect(inventory.suiteDefinitions.filter((definition) => definition.docker)).toHaveLength(15)
    expect(Object.isFrozen(inventory)).toBe(true)
    expect(Object.isFrozen(inventory.cases)).toBe(true)
    expect(Object.isFrozen(inventory.migrationBaseline)).toBe(true)
    expect(Object.isFrozen(inventory.suiteDefinitions)).toBe(true)
  })

  test("locks the migration floor to 53 business cases and 6 Docker suites", async () => {
    const cases = await loadSourcedCases(Root)
    const baseline = await loadMigrationBaseline(Root)
    const caseIds = new Set(cases.map((sourcedCase) => sourcedCase.id))
    const dockerSuiteIds = new Set(
      suiteDefinitions()
        .filter((definition) => definition.docker)
        .map((definition) => definition.id)
    )

    expect(baseline.businessE2eCaseIds).toHaveLength(53)
    expect(baseline.dockerSuiteIds).toHaveLength(6)
    expect(baseline.businessE2eCaseIds.every((id) => caseIds.has(id))).toBe(true)
    expect(baseline.dockerSuiteIds.every((id) => dockerSuiteIds.has(id))).toBe(true)
    expect(Object.isFrozen(baseline)).toBe(true)
    expect(Object.isFrozen(baseline.businessE2eCaseIds)).toBe(true)
    expect(Object.isFrozen(baseline.dockerSuiteIds)).toBe(true)
  })

  test("derives the deduplicated inventory from the current case and suite modules", async () => {
    const cases = await loadSourcedCases(Root)
    const definitions = suiteDefinitions()
    const summary = validateSourcedCases(cases, definitions)
    expect(summary.cases).toBe(cases.length)
    expect(summary.suites).toBe(
      new Set(
        cases.map(function suite(sourcedCase) {
          return sourcedCase.suite
        })
      ).size
    )
    expect(summary.sources).toBe(
      new Set(
        cases.map(function source(sourcedCase) {
          return sourcedCase.source.url
        })
      ).size
    )
    expect(summary.suites).toBe(28)
    expect(summary.dockerSuites).toBe(15)
    expect(summary.releaseBlockingSuites).toBe(
      definitions.filter(function blocking(definition) {
        return definition.releaseBlocking
      }).length
    )
    expect(summary.releaseBlockingSuites + summary.evidenceOnlySuites).toBe(summary.suites)
    expect(Object.keys(summary.domains).sort()).toEqual([
      "app",
      "config",
      "context",
      "cron",
      "durable-job",
      "health",
      "logging",
      "messaging-core",
      "messaging-jetstream",
      "metrics",
      "registry",
      "resilience",
      "store",
      "telemetry",
      "transport",
      "web"
    ])
  })

  test("validates cases against the caller-provided suite-definition snapshot", async () => {
    const cases = await loadSourcedCases(Root)
    const definitions = suiteDefinitions().filter((definition) => definition.id !== "kernel-native")

    expect(() => validateSourcedCases(cases, definitions)).toThrow(
      "references unknown suite kernel-native"
    )
  })

  test("keeps one TypeScript case module per sourced use case", async () => {
    const paths: string[] = []
    for await (const path of new Bun.Glob("cases/*").scan({
      cwd: import.meta.dir,
      onlyFiles: true
    })) {
      paths.push(path)
    }
    const cases = await loadSourcedCases(Root)
    expect(paths.length).toBe(cases.length)
    expect(
      paths.every(function caseModule(path) {
        return path.endsWith(".case.ts")
      })
    ).toBe(true)
  })

  test("declares all native and Docker suite owners exactly once", () => {
    const definitions = suiteDefinitions()
    expect(
      new Set(
        definitions.map(function id(definition) {
          return definition.id
        })
      ).size
    ).toBe(definitions.length)
    expect(
      definitions.filter(function docker(definition) {
        return definition.docker
      }).length
    ).toBe(15)
    expect(
      definitions.every(function blocking(definition) {
        return definition.releaseBlocking
      })
    ).toBe(true)
  })

  test("fails closed when a release-blocking suite owns no sourced case", async () => {
    const cases = await loadSourcedCases(Root)
    const missingSuite = "winston-runtime"
    const incompleteCases = cases.filter(function differentSuite(sourcedCase) {
      return sourcedCase.suite !== missingSuite
    })

    expect(() => validateSourcedCases(incompleteCases, suiteDefinitions())).toThrow(
      `release-blocking sourced E2E suite is missing cases: ${missingSuite}`
    )
  })

  test("fails closed for every unknown suite and inventory-selection ambiguity", async () => {
    await expect(
      runSourcedE2e(Root, ["--suite", "kernel-native", "--suite", "definitely-not-a-suite"])
    ).rejects.toThrow("unknown sourced E2E suite definitely-not-a-suite")
    await expect(runSourcedE2e(Root, ["--inventory", "--suite", "kernel-native"])).rejects.toThrow(
      "inventory mode does not accept suite selection"
    )
  })
})

describe("sourced case boundary", () => {
  test("rejects unsafe sources, identifiers, and empty evidence", () => {
    expect(() =>
      newSourcedCase({
        id: "bad",
        domain: "web",
        source: {
          url: "http://example.test/source",
          retrievedAt: "2026-07-18",
          quoteBoundary: QuoteBoundary
        },
        normalizedScenario: "Unsafe source.",
        runtimes: [],
        services: ["service"],
        assertions: ["assertion"],
        cleanupEvidence: ["cleanup"],
        suite: "kernel-native",
        scenario: "unsafe-source"
      })
    ).toThrow("source.url must use HTTPS")
    expect(() =>
      newSourcedCase({
        id: "UPPER-case",
        domain: "web",
        source: {
          url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
          retrievedAt: "2026-07-18",
          quoteBoundary: QuoteBoundary
        },
        normalizedScenario: "Invalid identifier.",
        runtimes: ["Bun"],
        services: ["service"],
        assertions: ["assertion"],
        cleanupEvidence: ["cleanup"],
        suite: "kernel-native",
        scenario: "invalid-identifier"
      })
    ).toThrow("id must be a stable lower-kebab identifier")
  })

  test("binds only valid, cleaned evidence containing the exact suite scenario", () => {
    const sourcedCase = validCase()
    const evidence: SuiteEvidence = {
      suite: "kernel-native",
      valid: true,
      scenarios: ["boundary-scenario"],
      cleanupValid: true,
      runtime: "Bun 1.3.14",
      runtimeProof: "runner.Bun.version",
      services: ["standard Fetch"],
      serviceProofs: [
        { service: "standard Fetch", source: "scenario:boundary-scenario@details.scenarios" }
      ],
      scenarioProofs: [
        { scenario: "boundary-scenario", source: "scenario:boundary-scenario@details.scenarios" }
      ],
      cleanupProofs: [
        { proof: "scenario:boundary-scenario", source: "details.cleanup.remaining=0" }
      ],
      releaseBlocking: true,
      details: {}
    }
    expect(sourcedCase.run(evidence)).toEqual({
      id: "boundary-case",
      domain: "web",
      suite: "kernel-native",
      scenario: "boundary-scenario",
      releaseBlocking: true,
      evidence: {
        runtimes: [{ claim: "Bun 1.3.14", proof: "runner.Bun.version" }],
        services: [
          { claim: "standard Fetch", proof: "scenario:boundary-scenario@details.scenarios" }
        ],
        assertions: [
          {
            claim: "The boundary is observable.",
            proof: "scenario:boundary-scenario@details.scenarios"
          }
        ],
        cleanupEvidence: [{ claim: "No resource remains.", proof: "details.cleanup.remaining=0" }]
      },
      valid: true
    })
    expect(() =>
      sourcedCase.run({
        suite: "kernel-native",
        valid: true,
        scenarios: [],
        cleanupValid: true,
        runtime: "Bun 1.3.14",
        runtimeProof: "runner.Bun.version",
        services: ["standard Fetch"],
        serviceProofs: [{ service: "standard Fetch", source: "details.scenarios" }],
        scenarioProofs: [],
        cleanupProofs: [
          { proof: "scenario:boundary-scenario", source: "details.cleanup.remaining=0" }
        ],
        releaseBlocking: true,
        details: {}
      })
    ).toThrow("did not prove scenario")
    expect(() =>
      sourcedCase.run({
        suite: "kernel-native",
        valid: true,
        scenarios: ["boundary-scenario"],
        cleanupValid: false,
        runtime: "Bun 1.3.14",
        runtimeProof: "runner.Bun.version",
        services: ["standard Fetch"],
        serviceProofs: [
          { service: "standard Fetch", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        scenarioProofs: [
          { scenario: "boundary-scenario", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        cleanupProofs: [],
        releaseBlocking: true,
        details: {}
      })
    ).toThrow("did not prove cleanup")
    expect(() =>
      sourcedCase.run({
        suite: "kernel-native",
        valid: true,
        scenarios: ["boundary-scenario"],
        cleanupValid: true,
        runtime: "Node.js 26.5.0",
        runtimeProof: "command:node --version",
        services: ["standard Fetch"],
        serviceProofs: [
          { service: "standard Fetch", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        scenarioProofs: [
          { scenario: "boundary-scenario", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        cleanupProofs: [
          { proof: "scenario:boundary-scenario", source: "details.cleanup.remaining=0" }
        ],
        releaseBlocking: true,
        details: {}
      })
    ).toThrow("did not execute declared runtimes")
    expect(() =>
      sourcedCase.run({
        suite: "kernel-native",
        valid: true,
        scenarios: ["boundary-scenario"],
        cleanupValid: true,
        runtime: "Bun 1.3.14",
        runtimeProof: "runner.Bun.version",
        services: ["different service"],
        serviceProofs: [
          { service: "different service", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        scenarioProofs: [
          { scenario: "boundary-scenario", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        cleanupProofs: [
          { proof: "scenario:boundary-scenario", source: "details.cleanup.remaining=0" }
        ],
        releaseBlocking: true,
        details: {}
      })
    ).toThrow("did not execute declared service")
    expect(() =>
      sourcedCase.run({
        suite: "kernel-native",
        valid: true,
        scenarios: ["boundary-scenario"],
        cleanupValid: true,
        runtime: "Bun 1.3.14",
        runtimeProof: "runner.Bun.version",
        services: ["standard Fetch"],
        serviceProofs: [
          { service: "standard Fetch", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        scenarioProofs: [],
        cleanupProofs: [
          { proof: "scenario:boundary-scenario", source: "details.cleanup.remaining=0" }
        ],
        releaseBlocking: true,
        details: {}
      })
    ).toThrow("did not prove assertion scenario")
    expect(() =>
      sourcedCase.run({
        suite: "kernel-native",
        valid: true,
        scenarios: ["boundary-scenario"],
        cleanupValid: true,
        runtime: "Bun 1.3.14",
        runtimeProof: "runner.Bun.version",
        services: ["standard Fetch"],
        serviceProofs: [
          { service: "standard Fetch", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        scenarioProofs: [
          { scenario: "boundary-scenario", source: "scenario:boundary-scenario@details.scenarios" }
        ],
        cleanupProofs: [],
        releaseBlocking: true,
        details: {}
      })
    ).toThrow("did not prove cleanup field")
  })
})

describe("release proof mutation resistance", () => {
  test("rejects a suite that only prints the expected scenario slug", () => {
    expect(() =>
      evaluateWinston({
        valid: true,
        scenarios: ["winston-native-file-lifecycle"]
      })
    ).toThrow("expected winstonVersion=3.19.0")
  })

  test("rejects omitted service execution evidence even when scenario values are present", () => {
    const details = { ...winstonDetails() }
    delete (details as Record<string, unknown>).winstonVersion
    expect(() => evaluateWinston(details)).toThrow("expected winstonVersion=3.19.0")
  })

  test("rejects renamed assertion booleans without domain scenario values", () => {
    const details = { ...winstonDetails() }
    delete (details as Record<string, unknown>).scenarioEvidence
    expect(() => evaluateWinston(details)).toThrow(
      "expected details.scenarioEvidence.winston-native-file-lifecycle.component=winston"
    )
  })

  test("rejects fabricated valid and scenario fields when native cleanup did not occur", () => {
    const details = {
      ...winstonDetails(),
      cleanup: { terminalCompleted: false, listenerDelta: 1, directoryRemoved: false }
    }
    expect(() => evaluateWinston(details)).toThrow("expected cleanup.terminalCompleted=true")
  })
})

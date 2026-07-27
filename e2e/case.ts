export type E2eDomain =
  | "app"
  | "config"
  | "context"
  | "cron"
  | "durable-job"
  | "health"
  | "logging"
  | "messaging-core"
  | "messaging-jetstream"
  | "metrics"
  | "registry"
  | "resilience"
  | "store"
  | "telemetry"
  | "transport"
  | "web"

export interface SourceEvidence {
  readonly url: string
  readonly retrievedAt: string
  readonly quoteBoundary: string
}

export interface SourcedCaseInput {
  readonly id: string
  readonly domain: E2eDomain
  readonly source: SourceEvidence
  readonly normalizedScenario: string
  readonly runtimes: readonly string[]
  readonly services: readonly string[]
  readonly assertions: readonly string[]
  readonly cleanupEvidence: readonly string[]
  readonly assertionScenarios?: readonly string[]
  readonly cleanupProofs?: readonly string[]
  readonly suite: string
  readonly scenario: string
}

export interface ScenarioProof {
  readonly scenario: string
  readonly source: string
}

export interface ServiceProof {
  readonly service: string
  readonly source: string
}

export interface CleanupProof {
  readonly proof: string
  readonly source: string
}

export interface SuiteEvidence {
  readonly suite: string
  readonly valid: boolean
  readonly scenarios: readonly string[]
  readonly cleanupValid: boolean
  readonly runtime: string
  readonly runtimeProof: string
  readonly services: readonly string[]
  readonly serviceProofs: readonly ServiceProof[]
  readonly scenarioProofs: readonly ScenarioProof[]
  readonly cleanupProofs: readonly CleanupProof[]
  readonly releaseBlocking: boolean
  readonly details: Readonly<Record<string, unknown>>
}

export interface ClaimBinding {
  readonly claim: string
  readonly proof: string
}

export interface CaseEvidenceBindings {
  readonly runtimes: readonly ClaimBinding[]
  readonly services: readonly ClaimBinding[]
  readonly assertions: readonly ClaimBinding[]
  readonly cleanupEvidence: readonly ClaimBinding[]
}

export interface CaseResult {
  readonly id: string
  readonly domain: E2eDomain
  readonly suite: string
  readonly scenario: string
  readonly releaseBlocking: boolean
  readonly evidence: CaseEvidenceBindings
  readonly valid: true
}

export interface SourcedCase extends SourcedCaseInput {
  readonly assertionScenarios: readonly string[]
  readonly cleanupProofs: readonly string[]

  /** Binds one sourced requirement to the independently executed suite evidence. */
  run(evidence: SuiteEvidence): CaseResult
}

const IdentifierPattern = /^[a-z][a-z0-9-]{2,95}$/
const DatePattern = /^\d{4}-\d{2}-\d{2}$/

/** Captures a non-empty immutable string list at the case construction boundary. */
function stringList(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} must contain at least one value`)
  }
  const snapshot: string[] = []
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${label} must contain only non-empty strings`)
    }
    snapshot.push(value)
  }
  return Object.freeze(snapshot)
}

/** Captures one proof list or repeats an explicit fallback proof for every claim. */
function proofList(
  values: readonly string[] | undefined,
  claims: readonly string[],
  fallback: string,
  label: string
): readonly string[] {
  if (values === undefined) {
    return Object.freeze(
      claims.map(function fallbackProof() {
        return fallback
      })
    )
  }
  const proofs = stringList(values, label)
  if (proofs.length !== claims.length) {
    throw new TypeError(`${label} must contain exactly one proof per claim`)
  }
  return proofs
}

/** Creates one immutable claim-to-proof binding. */
function claimBinding(claim: string, proof: string): ClaimBinding {
  return Object.freeze({ claim, proof })
}

/** Validates one stable identifier used by inventory and machine-readable evidence. */
function identifier(value: string, label: string): string {
  if (typeof value !== "string" || !IdentifierPattern.test(value)) {
    throw new TypeError(`${label} must be a stable lower-kebab identifier`)
  }
  return value
}

/** Captures one link-only source record without retaining mutable caller state. */
function sourceEvidence(value: SourceEvidence): SourceEvidence {
  const url = new URL(value.url)
  if (url.protocol !== "https:") throw new TypeError("source.url must use HTTPS")
  if (!DatePattern.test(value.retrievedAt))
    throw new TypeError("source.retrievedAt must be YYYY-MM-DD")
  if (value.quoteBoundary.trim().length === 0)
    throw new TypeError("source.quoteBoundary must be explicit")
  return Object.freeze({
    url: url.href,
    retrievedAt: value.retrievedAt,
    quoteBoundary: value.quoteBoundary
  })
}

/** Defines one immutable sourced use case and its evidence-binding runner. */
export function newSourcedCase(input: SourcedCaseInput): SourcedCase {
  const id = identifier(input.id, "id")
  const suite = identifier(input.suite, "suite")
  const scenario = identifier(input.scenario, "scenario")
  if (input.normalizedScenario.trim().length === 0) {
    throw new TypeError("normalizedScenario must be non-empty")
  }
  const source = sourceEvidence(input.source)
  const runtimes = stringList(input.runtimes, "runtimes")
  const services = stringList(input.services, "services")
  const assertions = stringList(input.assertions, "assertions")
  const cleanupEvidence = stringList(input.cleanupEvidence, "cleanupEvidence")
  const assertionScenarios = proofList(
    input.assertionScenarios,
    assertions,
    scenario,
    "assertionScenarios"
  )
  for (const assertionScenario of assertionScenarios) {
    identifier(assertionScenario, "assertionScenarios")
  }
  const cleanupProofs = proofList(
    input.cleanupProofs,
    cleanupEvidence,
    `scenario:${scenario}`,
    "cleanupProofs"
  )

  return Object.freeze({
    id,
    domain: input.domain,
    source,
    normalizedScenario: input.normalizedScenario,
    runtimes,
    services,
    assertions,
    cleanupEvidence,
    assertionScenarios,
    cleanupProofs,
    suite,
    scenario,
    run(evidence: SuiteEvidence): CaseResult {
      if (evidence.suite !== suite) {
        throw new Error(`case ${id} received evidence for ${evidence.suite}`)
      }
      if (!evidence.valid) throw new Error(`suite ${suite} did not report valid evidence`)
      if (!evidence.cleanupValid) throw new Error(`suite ${suite} did not prove cleanup`)
      if (!evidence.scenarios.includes(scenario)) {
        throw new Error(`suite ${suite} did not prove scenario ${scenario}`)
      }
      if (
        runtimes.length !== 1 ||
        runtimes[0] !== evidence.runtime ||
        evidence.runtimeProof.length === 0
      ) {
        throw new Error(`suite ${suite} did not execute declared runtimes for case ${id}`)
      }

      const runtimeBindings = Object.freeze([claimBinding(runtimes[0], evidence.runtimeProof)])
      const serviceBindings: ClaimBinding[] = []
      for (const service of services) {
        const proof = evidence.serviceProofs.find(function matching(candidate) {
          return candidate.service === service
        })
        if (!evidence.services.includes(service) || proof === undefined) {
          throw new Error(
            `suite ${suite} did not execute declared service ${service} for case ${id}`
          )
        }
        serviceBindings.push(claimBinding(service, proof.source))
      }

      const assertionBindings: ClaimBinding[] = []
      for (let index = 0; index < assertions.length; index += 1) {
        const claim = assertions[index]
        const assertionScenario = assertionScenarios[index]
        if (claim === undefined || assertionScenario === undefined) {
          throw new Error(`case ${id} assertion proof inventory is incomplete`)
        }
        const proof = evidence.scenarioProofs.find(function matching(candidate) {
          return candidate.scenario === assertionScenario
        })
        if (proof === undefined) {
          throw new Error(
            `suite ${suite} did not prove assertion scenario ${assertionScenario} for case ${id}`
          )
        }
        assertionBindings.push(claimBinding(claim, proof.source))
      }

      const cleanupBindings: ClaimBinding[] = []
      for (let index = 0; index < cleanupEvidence.length; index += 1) {
        const claim = cleanupEvidence[index]
        const proof = cleanupProofs[index]
        if (claim === undefined || proof === undefined) {
          throw new Error(`case ${id} cleanup proof inventory is incomplete`)
        }
        const observed = evidence.cleanupProofs.find(function matching(candidate) {
          return candidate.proof === proof
        })
        if (observed === undefined) {
          throw new Error(`suite ${suite} did not prove cleanup field ${proof} for case ${id}`)
        }
        cleanupBindings.push(claimBinding(claim, observed.source))
      }

      const boundEvidence = Object.freeze({
        runtimes: runtimeBindings,
        services: Object.freeze(serviceBindings),
        assertions: Object.freeze(assertionBindings),
        cleanupEvidence: Object.freeze(cleanupBindings)
      })
      return Object.freeze({
        id,
        domain: input.domain,
        suite,
        scenario,
        releaseBlocking: evidence.releaseBlocking,
        evidence: boundEvidence,
        valid: true
      })
    }
  })
}

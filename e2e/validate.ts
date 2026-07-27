import type { E2eDomain, SourcedCase } from "./case"

export interface SourcedSuiteDefinition {
  readonly id: string
  readonly docker: boolean
  readonly releaseBlocking: boolean
}

export interface InventorySummary {
  readonly cases: number
  readonly suites: number
  readonly sources: number
  readonly domains: Readonly<Record<string, number>>
  readonly dockerSuites: number
  readonly releaseBlockingSuites: number
  readonly evidenceOnlySuites: number
}

const RetrievedDates = new Set([
  "2026-07-18",
  "2026-07-19",
  "2026-07-20",
  "2026-07-21",
  "2026-07-22"
])
const RequiredDomains: ReadonlySet<E2eDomain> = new Set([
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
const OfficialHosts = new Set([
  "developer.hashicorp.com",
  "developer.mozilla.org",
  "docs.bullmq.io",
  "docs.nats.io",
  "etcd.io",
  "elysiajs.com",
  "github.com",
  "h3.dev",
  "hono.dev",
  "jsr.io",
  "kubernetes.io",
  "nodejs.org",
  "opentelemetry.io",
  "pkg.go.dev",
  "www.rfc-editor.org",
  "zookeeper.apache.org"
])
const OfficialGitHubPrefixes = [
  "/go-kratos/kratos/",
  "/micro/go-micro/",
  "/pinojs/pino/",
  "/prometheus/client_js/",
  "/winstonjs/winston/"
] as const

/** Fails when a GitHub source does not belong to one of the reviewed upstream projects. */
function officialGitHubSource(url: URL): boolean {
  if (url.hostname !== "github.com") return true
  return OfficialGitHubPrefixes.some(function matching(prefix) {
    return url.pathname.startsWith(prefix)
  })
}

/** Increments one immutable-summary accumulator entry. */
function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

/** Validates the complete sourced-use-case inventory and returns its distribution summary. */
export function validateSourcedCases(
  cases: readonly SourcedCase[],
  declaredSuites: readonly SourcedSuiteDefinition[]
): InventorySummary {
  if (cases.length < 40)
    throw new Error(`sourced E2E inventory requires at least 40 cases; observed ${cases.length}`)
  const identifiers = new Set<string>()
  const scenarios = new Set<string>()
  const normalized = new Set<string>()
  const sources = new Set<string>()
  const observedDomains = new Set<E2eDomain>()
  const observedSuites = new Set<string>()
  const domains: Record<string, number> = {}
  const declaredSuiteIds = new Set(
    declaredSuites.map(function identifier(definition) {
      return definition.id
    })
  )
  const releaseSuiteIds = new Set(
    declaredSuites
      .filter(function blocking(definition) {
        return definition.releaseBlocking
      })
      .map(function identifier(definition) {
        return definition.id
      })
  )

  for (const sourcedCase of cases) {
    if (identifiers.has(sourcedCase.id))
      throw new Error(`duplicate sourced case id ${sourcedCase.id}`)
    identifiers.add(sourcedCase.id)
    const scenarioKey = `${sourcedCase.suite}/${sourcedCase.scenario}`
    if (scenarios.has(scenarioKey))
      throw new Error(`duplicate sourced suite scenario ${scenarioKey}`)
    scenarios.add(scenarioKey)
    const normalizedKey = sourcedCase.normalizedScenario.trim().toLocaleLowerCase("en-US")
    if (normalized.has(normalizedKey)) {
      throw new Error(`duplicate normalized sourced scenario ${sourcedCase.normalizedScenario}`)
    }
    normalized.add(normalizedKey)
    if (!RetrievedDates.has(sourcedCase.source.retrievedAt)) {
      throw new Error(`case ${sourcedCase.id} source has an unreviewed retrieval date`)
    }
    const sourceUrl = new URL(sourcedCase.source.url)
    if (!OfficialHosts.has(sourceUrl.hostname) || !officialGitHubSource(sourceUrl)) {
      throw new Error(`case ${sourcedCase.id} does not use a reviewed official source`)
    }
    sources.add(sourceUrl.href)
    if (!declaredSuiteIds.has(sourcedCase.suite)) {
      throw new Error(`case ${sourcedCase.id} references unknown suite ${sourcedCase.suite}`)
    }
    observedSuites.add(sourcedCase.suite)
    observedDomains.add(sourcedCase.domain)
    increment(domains, sourcedCase.domain)
  }

  for (const releaseSuiteId of releaseSuiteIds) {
    if (!observedSuites.has(releaseSuiteId)) {
      throw new Error(`release-blocking sourced E2E suite is missing cases: ${releaseSuiteId}`)
    }
  }
  for (const requiredDomain of RequiredDomains) {
    if (!observedDomains.has(requiredDomain))
      throw new Error(`sourced E2E domain is missing: ${requiredDomain}`)
  }
  if (sources.size < 12)
    throw new Error(
      `sourced E2E inventory requires at least 12 official sources; observed ${sources.size}`
    )
  const dockerSuiteIds = new Set(
    declaredSuites
      .filter(function docker(definition) {
        return definition.docker
      })
      .map(function identifier(definition) {
        return definition.id
      })
  )
  let dockerSuites = 0
  let releaseBlockingSuites = 0
  for (const suite of observedSuites) {
    if (dockerSuiteIds.has(suite)) dockerSuites += 1
    if (releaseSuiteIds.has(suite)) releaseBlockingSuites += 1
  }
  if (dockerSuites < 15)
    throw new Error(
      `sourced E2E inventory requires all fifteen declared real-service Docker suites; observed ${dockerSuites}`
    )

  return Object.freeze({
    cases: cases.length,
    suites: observedSuites.size,
    sources: sources.size,
    domains: Object.freeze(domains),
    dockerSuites,
    releaseBlockingSuites,
    evidenceOnlySuites: observedSuites.size - releaseBlockingSuites
  })
}

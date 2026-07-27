export const publishedCoverageMarker = "LIKEGO_PUBLISHED_JS_BRANCH_AUTHORITY_V1"
export const bunCoverageMarker = "LIKEGO_BUN_PACKAGE_COVERAGE_V1"

export type PublishedRuntime = "bun" | "node" | "deno"
export type PublishedLane = "exact" | "lts" | "current"
export type PublishedPackageKind = "portable" | "integration" | "hybrid"
export type PublishedExportKind = "portable" | "integration"
export type PublishedResidency = "non-resident" | "resident"

export interface PublishedManifest {
  readonly [key: string]: unknown
}

export interface PublishedRuntimeRow {
  readonly runtime: PublishedRuntime
  readonly lane: PublishedLane
  readonly version: string
}

export interface PublishedExport {
  readonly name: string
  readonly kind: PublishedExportKind
  readonly residency: PublishedResidency
  readonly ownerResources: readonly string[]
  readonly capabilities: readonly string[]
  readonly runtimes: readonly PublishedRuntimeRow[]
}

export interface PublishedPackage {
  readonly name: string
  readonly root: string
  readonly manifest: PublishedManifest
  readonly releaseBlocking: boolean
  readonly packageKind: PublishedPackageKind
  readonly exports: readonly PublishedExport[]
}

export interface PublishedInventory {
  readonly packages: readonly PublishedPackage[]
  readonly byName: ReadonlyMap<string, PublishedPackage>
}

export interface PublishedCoverage {
  readonly lines: number
  readonly functions: number
  readonly branches: number
}

export interface PublishedCoverageCounter {
  readonly found: number
  readonly hit: number
}

export interface PublishedCoverageCounters {
  readonly lines: PublishedCoverageCounter
  readonly functions: PublishedCoverageCounter
  readonly branches: PublishedCoverageCounter
}

export interface PublishedCoverageFile {
  readonly path: string
  readonly coverage: PublishedCoverage
  readonly counters: PublishedCoverageCounters
}

export interface PublishedBusinessCase {
  readonly package: string
  readonly exports: readonly string[]
  readonly runtimeModule: string
  readonly typeConsumer: string
  readonly nodePreloadModule?: string | undefined
  readonly runtimeModules?: Readonly<Record<string, string>> | undefined
  readonly typeConsumers?: Readonly<Record<string, string>> | undefined
  readonly natsExactOptionalPolicies?: readonly PublishedNatsExactOptionalPolicy[] | undefined
}

export interface PublishedNatsExactOptionalPolicy {
  readonly export: string
  readonly directDependency: string
}

export interface PublishedStage {
  readonly root: string
  readonly target: PublishedPackage
  readonly workspacePackages: readonly string[]
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface RuntimeEvidence {
  readonly export: string
  readonly runtime: PublishedRuntime
  readonly lane: PublishedLane
  readonly expectedVersion: string
  readonly observedVersion: string
  readonly expectedImage: string | null
  readonly behaviorPassed: boolean
  readonly coverage: PublishedCoverage | null
  readonly coverageCounters: PublishedCoverageCounters | null
  readonly coverageFiles: readonly PublishedCoverageFile[] | null
  readonly branches: Readonly<{
    supported: boolean
    percent: number | null
    reason?: string
  }>
  readonly passed: boolean
  readonly detail: string | null
}

export interface TypeEvidence {
  readonly export: string
  readonly authority: "typescript" | "deno"
  readonly expectedVersion: string
  readonly observedVersion: string
  readonly passed: boolean
  readonly detail: string | null
  readonly observedException:
    | Readonly<{
        readonly kind: "upstream-exact-optional-properties"
        readonly package: "@nats-io/nats-core"
        readonly packageVersion: "3.4.0"
        readonly compilerVersion: "7.0.2"
        readonly export: string
        readonly directDependency: string
        readonly diagnostics: readonly ["TS2420:MsgImpl.headers", "TS2420:NatsConnectionImpl.info"]
        readonly compatibilityCheck: "exactOptionalPropertyTypes=false,skipLibCheck=false"
      }>
    | Readonly<{
        readonly kind: "upstream-lib-check"
        readonly package: "h3"
        readonly packageVersion: "1.15.11"
        readonly compilerVersion: "7.0.2"
        readonly export: "."
        readonly diagnostics: readonly [
          "TS2591:node:http",
          "TS2591:node:stream",
          "TS2552:FetchEvent",
          "TS2591:Buffer"
        ]
        readonly compatibilityCheck: "skipLibCheck=true"
      }>
    | null
}

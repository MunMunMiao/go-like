export const LongSoakDurationMs = 60 * 60 * 1_000
export const ConcurrentShutdownRequests = 8

const SampleCoverageToleranceMs = 5_000
const SampleDensityLimitMs = 15_000

export interface SoakSample {
  readonly atMs: number
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly activeHandles: number
  readonly fdCount: number | null
}

export interface SoakResult {
  readonly startedAt: string
  readonly finishedAt: string
  readonly requestedDurationMs: number
  readonly durationMs: number
  readonly environment: {
    readonly arch: string
    readonly bunVersion: string
    readonly dockerVersion: string
    readonly k6Image: string
    readonly k6Version: string
    readonly nodeVersion: string
    readonly platform: string
  }
  readonly load: {
    readonly requests: number
    readonly failedRequests: number
    readonly checksFailed: number
    readonly droppedIterations: number
    readonly p50Ms: number
    readonly p95Ms: number
    readonly p99Ms: number
  }
  readonly runtime: {
    readonly calls: number
    readonly dials: number
    readonly unexpectedErrors: number
    readonly unhandledRejections: number
    readonly runnerSamples: readonly SoakSample[]
    readonly webHostSamples: readonly SoakSample[]
  }
  readonly scenarios: {
    readonly standardFetchHttp: boolean
    readonly clientPoolReuse: boolean
    readonly endpointChurn: boolean
    readonly shutdownUnderLoad: {
      readonly admittedRequests: number
      readonly drainedRequests: number
      readonly rejectedAfterStop: boolean
    }
    readonly rabbitConfirmInterruption: boolean
    readonly redisFailover: boolean
  }
  readonly cleanup: {
    readonly serverTerminal: boolean
    readonly clientClosed: boolean
    readonly portRebind: boolean
    readonly residualContainers: number
    readonly residualNetworks: number
    readonly residualVolumes: number
  }
}

export interface SoakEvaluation {
  readonly issues: readonly string[]
}

export class SoakResultShapeError extends TypeError {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`soak result shape is invalid: ${issues.join("; ")}`)
    this.name = "SoakResultShapeError"
    this.issues = Object.freeze([...issues])
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function pathValue(value: unknown, path: string): unknown {
  let selected = value
  for (const component of path.split(".")) {
    const parent = record(selected)
    if (parent === null) return undefined
    selected = parent[component]
  }
  return selected
}

function finite(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
}

function utcTimestamp(value: string): number {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : Number.NaN
}

function validateSoakResultShape(value: unknown): readonly string[] {
  if (record(value) === null) return Object.freeze(["result must be an object"])
  const issues: string[] = []
  const strings = [
    "startedAt",
    "finishedAt",
    "environment.arch",
    "environment.bunVersion",
    "environment.dockerVersion",
    "environment.k6Image",
    "environment.k6Version",
    "environment.nodeVersion",
    "environment.platform"
  ]
  const integers = [
    "requestedDurationMs",
    "durationMs",
    "load.requests",
    "load.failedRequests",
    "load.checksFailed",
    "load.droppedIterations",
    "runtime.calls",
    "runtime.dials",
    "runtime.unexpectedErrors",
    "runtime.unhandledRejections",
    "scenarios.shutdownUnderLoad.admittedRequests",
    "scenarios.shutdownUnderLoad.drainedRequests",
    "cleanup.residualContainers",
    "cleanup.residualNetworks",
    "cleanup.residualVolumes"
  ]
  const numbers = ["load.p50Ms", "load.p95Ms", "load.p99Ms"]
  const booleans = [
    "scenarios.standardFetchHttp",
    "scenarios.clientPoolReuse",
    "scenarios.endpointChurn",
    "scenarios.shutdownUnderLoad.rejectedAfterStop",
    "scenarios.rabbitConfirmInterruption",
    "scenarios.redisFailover",
    "cleanup.serverTerminal",
    "cleanup.clientClosed",
    "cleanup.portRebind"
  ]
  for (const path of strings) {
    const selected = pathValue(value, path)
    if (typeof selected !== "string" || selected.length === 0) {
      issues.push(`${path} must be a non-empty string`)
    }
  }
  for (const path of integers) {
    const selected = pathValue(value, path)
    if (!Number.isSafeInteger(selected) || (selected as number) < 0) {
      issues.push(`${path} must be a non-negative safe integer`)
    }
  }
  for (const path of numbers) {
    if (!finite(pathValue(value, path))) issues.push(`${path} must be a non-negative finite number`)
  }
  for (const path of booleans) {
    if (typeof pathValue(value, path) !== "boolean") issues.push(`${path} must be a boolean`)
  }
  for (const path of ["runtime.runnerSamples", "runtime.webHostSamples"]) {
    const samples = pathValue(value, path)
    if (!Array.isArray(samples)) {
      issues.push(`${path} must be an array`)
      continue
    }
    for (const [index, sample] of samples.entries()) {
      const prefix = `${path}[${index}]`
      if (record(sample) === null) {
        issues.push(`${prefix} must be an object`)
        continue
      }
      for (const field of ["atMs", "rssBytes", "heapUsedBytes", "activeHandles"]) {
        const selected = pathValue(sample, field)
        if (!Number.isSafeInteger(selected) || (selected as number) < 0) {
          issues.push(`${prefix}.${field} must be a non-negative safe integer`)
        }
      }
      const descriptors = pathValue(sample, "fdCount")
      if (
        descriptors !== null &&
        (typeof descriptors !== "number" || !Number.isSafeInteger(descriptors) || descriptors < 0)
      ) {
        issues.push(`${prefix}.fdCount must be null or a non-negative safe integer`)
      }
    }
  }
  return Object.freeze(issues)
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null) return
  for (const nested of Object.values(value)) deepFreeze(nested)
  Object.freeze(value)
}

/** Validates and freezes one already-decoded soak result. */
export function parseSoakResult(value: unknown): SoakResult {
  const issues = validateSoakResultShape(value)
  if (issues.length > 0) throw new SoakResultShapeError(issues)
  deepFreeze(value)
  return value as SoakResult
}

/** Keeps JSON syntax failures separate from result-shape failures. */
export function parseSoakResultJson(value: string): SoakResult {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch (error) {
    throw new SyntaxError("soak result is not valid JSON", { cause: error })
  }
  return parseSoakResult(decoded)
}

function median(values: readonly number[]): number {
  const ordered = values.toSorted((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0)
}

function sustainedGrowth(
  samples: readonly SoakSample[],
  field: keyof SoakSample,
  minimumGrowth: number,
  minimumRecentGrowth: number
): boolean {
  const firstAt = samples[0]?.atMs
  const lastAt = samples.at(-1)?.atMs
  if (!finite(firstAt) || !finite(lastAt) || lastAt - firstAt < 60_000) return false
  const values = samples.map((sample) => sample[field])
  if (values.some((selected) => !finite(selected))) return false
  const numbers = values as number[]
  if (numbers.length < 4) return false
  const window = Math.max(2, Math.floor(numbers.length / 4))
  const late = numbers.slice(-window)
  const middle = Math.floor(late.length / 2)
  const totalGrowth = median(late) - median(numbers.slice(0, window))
  if (minimumRecentGrowth === 0) return totalGrowth > minimumGrowth
  const recentGrowth = median(late.slice(middle)) - median(late.slice(0, middle))
  return (
    totalGrowth > minimumGrowth &&
    (recentGrowth > minimumRecentGrowth || totalGrowth > minimumGrowth * 2 + minimumRecentGrowth)
  )
}

function evaluateSamples(
  samples: readonly SoakSample[],
  label: string,
  requestedDurationMs: number,
  durationMs: number,
  platform: string,
  issues: string[]
): void {
  if (
    (platform === "linux" || platform === "darwin") &&
    samples.some((sample) => sample.fdCount === null)
  ) {
    issues.push(`${label}.fdCount is required on ${platform}`)
  }

  const times = samples.map((entry) => entry.atMs)
  const firstAt = times[0]
  const lastAt = times.at(-1)
  if (
    times.length < 3 ||
    !times.every((atMs, index) => index === 0 || atMs > (times[index - 1] ?? atMs)) ||
    !finite(firstAt) ||
    !finite(lastAt) ||
    !finite(requestedDurationMs, 1) ||
    !finite(durationMs, 1) ||
    firstAt > SampleCoverageToleranceMs ||
    lastAt - firstAt < requestedDurationMs - SampleCoverageToleranceMs ||
    lastAt > durationMs
  ) {
    issues.push(`${label} must strictly cover the requested load interval`)
  }
  if (
    finite(requestedDurationMs, LongSoakDurationMs) &&
    times.some(
      (atMs, index) => index > 0 && atMs - (times[index - 1] ?? atMs) > SampleDensityLimitMs
    )
  ) {
    issues.push(`${label} must sample the requested load interval at least every 15 seconds`)
  }

  const steady = samples.slice(Math.floor(samples.length / 2))
  const growth = [
    ["rssBytes", 8 * 1024 * 1024, 1024 * 1024],
    ["heapUsedBytes", 8 * 1024 * 1024, 1024 * 1024],
    ["activeHandles", 4, 0],
    ["fdCount", 4, 0]
  ] as const
  for (const [field, minimum, recentMinimum] of growth) {
    if (sustainedGrowth(steady, field, minimum, recentMinimum)) {
      issues.push(`${label}.${field} grows without a stable bound`)
    }
  }
}

/** Evaluates the thresholds measured by one validated soak result. */
export function evaluateSoakResult(result: SoakResult): SoakEvaluation {
  const issues: string[] = []
  const startedAt = utcTimestamp(result.startedAt)
  const finishedAt = utcTimestamp(result.finishedAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    issues.push("startedAt and finishedAt must describe an ordered interval")
  }
  if (
    Number.isFinite(startedAt) &&
    Number.isFinite(finishedAt) &&
    Math.abs(finishedAt - startedAt - result.durationMs) > 5_000
  ) {
    issues.push("durationMs must match the measured UTC interval")
  }
  if (result.durationMs < result.requestedDurationMs) {
    issues.push("durationMs must cover requestedDurationMs")
  }

  const load = result.load
  if (load.requests < 1) issues.push("load.requests must be positive")
  if (load.failedRequests !== 0) issues.push("load.failedRequests must equal 0")
  if (load.checksFailed !== 0) issues.push("load.checksFailed must equal 0")
  if (load.droppedIterations !== 0) issues.push("load.droppedIterations must equal 0")
  if (load.p50Ms > load.p95Ms || load.p95Ms > load.p99Ms) {
    issues.push("load latency quantiles must satisfy p50 <= p95 <= p99")
  }

  const runtime = result.runtime
  if (runtime.calls < 1) issues.push("runtime.calls must be positive")
  if (runtime.dials < 1) issues.push("runtime.dials must be positive")
  if (runtime.calls <= runtime.dials) issues.push("runtime.calls must exceed runtime.dials")
  if (runtime.unexpectedErrors !== 0) issues.push("runtime.unexpectedErrors must equal 0")
  if (runtime.unhandledRejections !== 0) {
    issues.push("runtime.unhandledRejections must equal 0")
  }
  evaluateSamples(
    runtime.runnerSamples,
    "runtime.runnerSamples",
    result.requestedDurationMs,
    result.durationMs,
    result.environment.platform,
    issues
  )
  evaluateSamples(
    runtime.webHostSamples,
    "runtime.webHostSamples",
    result.requestedDurationMs,
    result.durationMs,
    result.environment.platform,
    issues
  )

  const scenarios = result.scenarios
  for (const field of ["standardFetchHttp", "clientPoolReuse", "endpointChurn"] as const) {
    if (!scenarios[field]) issues.push(`scenarios.${field} must equal true`)
  }
  const shutdown = scenarios.shutdownUnderLoad
  if (
    shutdown.admittedRequests < ConcurrentShutdownRequests ||
    shutdown.drainedRequests !== shutdown.admittedRequests ||
    !shutdown.rejectedAfterStop
  ) {
    issues.push("scenarios.shutdownUnderLoad must prove concurrent drain and rejected admission")
  }
  const longRun =
    result.requestedDurationMs >= LongSoakDurationMs && result.durationMs >= LongSoakDurationMs
  if (longRun) {
    if (!scenarios.rabbitConfirmInterruption) {
      issues.push("scenarios.rabbitConfirmInterruption must equal true")
    }
    if (!scenarios.redisFailover) issues.push("scenarios.redisFailover must equal true")
  }

  const cleanup = result.cleanup
  for (const field of ["serverTerminal", "clientClosed", "portRebind"] as const) {
    if (!cleanup[field]) issues.push(`cleanup.${field} must equal true`)
  }
  for (const field of ["residualContainers", "residualNetworks", "residualVolumes"] as const) {
    if (cleanup[field] !== 0) issues.push(`cleanup.${field} must equal 0`)
  }

  return Object.freeze({ issues: Object.freeze(issues) })
}

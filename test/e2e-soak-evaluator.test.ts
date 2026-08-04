import { expect, test } from "bun:test"

import {
  evaluateSoakResult,
  LongSoakDurationMs,
  parseSoakResult,
  parseSoakResultJson,
  type SoakResult,
  SoakResultShapeError,
  type SoakSample
} from "../e2e/soak-evaluator"

const StartedAtMs = Date.parse("2026-08-02T00:00:00.000Z")

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key]
}

function sample(atMs: number): SoakSample {
  return Object.freeze({
    atMs,
    rssBytes: 100 * 1024 * 1024,
    heapUsedBytes: 50 * 1024 * 1024,
    activeHandles: 10,
    fdCount: 20
  })
}

function sampleSeries(durationMs: number): readonly SoakSample[] {
  const step = durationMs >= LongSoakDurationMs ? 15_000 : Math.max(1, Math.floor(durationMs / 2))
  const samples: SoakSample[] = []
  for (let atMs = 0; atMs < durationMs; atMs += step) samples.push(sample(atMs))
  samples.push(sample(durationMs))
  return Object.freeze(samples)
}

function validResult(
  requestedDurationMs = 10_000,
  durationMs = requestedDurationMs,
  platform = "darwin"
): SoakResult {
  const runnerSamples = sampleSeries(requestedDurationMs)
  const webHostSamples = sampleSeries(requestedDurationMs)
  const longRun = requestedDurationMs >= LongSoakDurationMs && durationMs >= LongSoakDurationMs
  return Object.freeze({
    startedAt: new Date(StartedAtMs).toISOString(),
    finishedAt: new Date(StartedAtMs + durationMs).toISOString(),
    requestedDurationMs,
    durationMs,
    environment: Object.freeze({
      arch: "arm64",
      bunVersion: "1.3.14",
      dockerVersion: "28.3.3",
      k6Image: "fixed",
      k6Version: "2.1.0",
      nodeVersion: "26.5.0",
      platform
    }),
    load: Object.freeze({
      requests: 100,
      failedRequests: 0,
      checksFailed: 0,
      droppedIterations: 0,
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: 3
    }),
    runtime: Object.freeze({
      calls: 100,
      dials: 2,
      unexpectedErrors: 0,
      unhandledRejections: 0,
      runnerSamples,
      webHostSamples
    }),
    scenarios: Object.freeze({
      standardFetchHttp: true,
      clientPoolReuse: true,
      endpointChurn: true,
      shutdownUnderLoad: Object.freeze({
        admittedRequests: 8,
        drainedRequests: 8,
        rejectedAfterStop: true
      }),
      rabbitConfirmInterruption: longRun,
      redisFailover: longRun
    }),
    cleanup: Object.freeze({
      serverTerminal: true,
      clientClosed: true,
      portRebind: true,
      residualContainers: 0,
      residualNetworks: 0,
      residualVolumes: 0
    })
  })
}

function mutable(result = validResult()): Mutable<SoakResult> {
  return structuredClone(result) as Mutable<SoakResult>
}

function issues(result: Mutable<SoakResult>): readonly string[] {
  return evaluateSoakResult(parseSoakResult(result)).issues
}

test("soak result JSON parsing is layered, structured, and deeply frozen", () => {
  const parsed = parseSoakResultJson(JSON.stringify(validResult()))
  expect(Object.isFrozen(parsed)).toBe(true)
  expect(Object.isFrozen(parsed.runtime.runnerSamples)).toBe(true)
  expect(Object.isFrozen(parsed.runtime.runnerSamples[0])).toBe(true)
  expect(() => parseSoakResultJson("not json")).toThrow(SyntaxError)

  const malformed = mutable()
  Reflect.set(malformed.load, "requests", "100")
  Reflect.set(malformed.runtime.runnerSamples[0]!, "fdCount", -1)
  let failure: unknown = null
  try {
    parseSoakResult(malformed)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(SoakResultShapeError)
  expect((failure as SoakResultShapeError).issues).toEqual([
    "load.requests must be a non-negative safe integer",
    "runtime.runnerSamples[0].fdCount must be null or a non-negative safe integer"
  ])
})

test("valid short and 60-minute results preserve the long-run boundary", () => {
  const short = evaluateSoakResult(validResult())
  expect(short.issues).toEqual([])
  expect(Object.isFrozen(short)).toBe(true)
  expect(Object.isFrozen(short.issues)).toBe(true)
  expect(evaluateSoakResult(validResult(LongSoakDurationMs)).issues).toEqual([])

  const requestedLongButMeasuredShort = mutable(validResult(LongSoakDurationMs, 10_000))
  requestedLongButMeasuredShort.runtime.runnerSamples = [...sampleSeries(LongSoakDurationMs)]
  requestedLongButMeasuredShort.runtime.webHostSamples = [...sampleSeries(LongSoakDurationMs)]
  requestedLongButMeasuredShort.scenarios.rabbitConfirmInterruption = false
  requestedLongButMeasuredShort.scenarios.redisFailover = false
  expect(issues(requestedLongButMeasuredShort)).not.toContain(
    "scenarios.rabbitConfirmInterruption must equal true"
  )
})

test("timestamps and measured duration fail independently", () => {
  const invalid = mutable()
  invalid.startedAt = "invalid"
  expect(issues(invalid)).toContain("startedAt and finishedAt must describe an ordered interval")

  const nonUtc = mutable()
  nonUtc.startedAt = "2026-08-02T08:00:00.000+08:00"
  expect(issues(nonUtc)).toContain("startedAt and finishedAt must describe an ordered interval")

  const reversed = mutable()
  reversed.finishedAt = new Date(StartedAtMs - 1).toISOString()
  expect(issues(reversed)).toContain("startedAt and finishedAt must describe an ordered interval")

  const short = mutable()
  short.durationMs = 9_999
  short.finishedAt = new Date(StartedAtMs + 9_999).toISOString()
  expect(issues(short)).toContain("durationMs must cover requestedDurationMs")

  const drifted = mutable()
  drifted.finishedAt = new Date(StartedAtMs + 15_001).toISOString()
  expect(issues(drifted)).toContain("durationMs must match the measured UTC interval")

  const tolerated = mutable()
  tolerated.finishedAt = new Date(StartedAtMs + 15_000).toISOString()
  expect(issues(tolerated)).not.toContain("durationMs must match the measured UTC interval")
})

test.each([
  ["requests", 0, "load.requests must be positive"],
  ["failedRequests", 1, "load.failedRequests must equal 0"],
  ["checksFailed", 1, "load.checksFailed must equal 0"],
  ["droppedIterations", 1, "load.droppedIterations must equal 0"]
] as const)("load.%s threshold is enforced", (field, value, issue) => {
  const result = mutable()
  result.load[field] = value
  expect(issues(result)).toContain(issue)
})

test("latency quantiles must remain ordered", () => {
  const result = mutable()
  result.load.p50Ms = 4
  expect(issues(result)).toContain("load latency quantiles must satisfy p50 <= p95 <= p99")
})

test.each([
  ["calls", 0, "runtime.calls must be positive"],
  ["dials", 0, "runtime.dials must be positive"],
  ["unexpectedErrors", 1, "runtime.unexpectedErrors must equal 0"],
  ["unhandledRejections", 1, "runtime.unhandledRejections must equal 0"]
] as const)("runtime.%s threshold is enforced", (field, value, issue) => {
  const result = mutable()
  result.runtime[field] = value
  expect(issues(result)).toContain(issue)
})

test("runtime calls must exceed dials", () => {
  const result = mutable()
  result.runtime.calls = result.runtime.dials
  expect(issues(result)).toContain("runtime.calls must exceed runtime.dials")
})

test.each(["standardFetchHttp", "clientPoolReuse", "endpointChurn"] as const)(
  "scenario %s is required",
  (field) => {
    const result = mutable()
    result.scenarios[field] = false
    expect(issues(result)).toContain(`scenarios.${field} must equal true`)
  }
)

test.each([
  [7, 7, true],
  [8, 7, true],
  [8, 8, false]
] as const)(
  "shutdown invariant rejects admitted=%d drained=%d rejected=%p",
  (admitted, drained, rejected) => {
    const result = mutable()
    result.scenarios.shutdownUnderLoad = {
      admittedRequests: admitted,
      drainedRequests: drained,
      rejectedAfterStop: rejected
    }
    expect(issues(result)).toContain(
      "scenarios.shutdownUnderLoad must prove concurrent drain and rejected admission"
    )
  }
)

test.each(["serverTerminal", "clientClosed", "portRebind"] as const)(
  "cleanup.%s is required",
  (field) => {
    const result = mutable()
    result.cleanup[field] = false
    expect(issues(result)).toContain(`cleanup.${field} must equal true`)
  }
)

test.each(["residualContainers", "residualNetworks", "residualVolumes"] as const)(
  "cleanup.%s must be zero",
  (field) => {
    const result = mutable()
    result.cleanup[field] = 1
    expect(issues(result)).toContain(`cleanup.${field} must equal 0`)
  }
)

test("POSIX samples require fd counts while other platforms permit null", () => {
  for (const platform of ["linux", "darwin"]) {
    const result = mutable(validResult(10_000, 10_000, platform))
    result.runtime.runnerSamples[0]!.fdCount = null
    expect(issues(result)).toContain(`runtime.runnerSamples.fdCount is required on ${platform}`)
  }
  const windows = mutable(validResult(10_000, 10_000, "win32"))
  windows.runtime.runnerSamples[0]!.fdCount = null
  expect(issues(windows)).not.toContain("runtime.runnerSamples.fdCount is required on win32")
})

test.each([
  ["too few", [sample(0), sample(10_000)]],
  ["not increasing", [sample(0), sample(5_000), sample(5_000), sample(10_000)]],
  ["insufficient coverage", [sample(0), sample(1_000), sample(2_000)]],
  ["past duration", [sample(0), sample(5_000), sample(10_001)]]
] as const)("sample coverage rejects %s data", (_label, samples) => {
  const result = mutable()
  result.runtime.runnerSamples = structuredClone(samples) as unknown as Mutable<SoakSample>[]
  expect(issues(result)).toContain(
    "runtime.runnerSamples must strictly cover the requested load interval"
  )
})

test("60-minute samples reject a gap greater than 15 seconds", () => {
  const result = mutable(validResult(LongSoakDurationMs))
  result.runtime.runnerSamples[1]!.atMs = 15_001
  expect(issues(result)).toContain(
    "runtime.runnerSamples must sample the requested load interval at least every 15 seconds"
  )
})

function growthSamples(field: keyof SoakSample, totalGrowth: number): Mutable<SoakSample>[] {
  const samples = Array.from({ length: 16 }, (_, index) => mutableSample(sample(index * 10_000)))
  const baseline = samples[8]![field]
  if (typeof baseline !== "number") throw new TypeError("growth field must be numeric")
  const recentSpread = field === "rssBytes" || field === "heapUsedBytes" ? 2 * 1024 * 1024 : 0
  Reflect.set(samples[14]!, field, baseline + totalGrowth - recentSpread / 2)
  Reflect.set(samples[15]!, field, baseline + totalGrowth + recentSpread / 2)
  return samples
}

function mutableSample(value: SoakSample): Mutable<SoakSample> {
  return structuredClone(value) as Mutable<SoakSample>
}

test.each([
  ["rssBytes", 8 * 1024 * 1024],
  ["heapUsedBytes", 8 * 1024 * 1024],
  ["activeHandles", 4],
  ["fdCount", 4]
] as const)("%s sustained-growth threshold is strict", (field, threshold) => {
  for (const growth of [threshold - 1, threshold]) {
    const result = mutable(validResult(150_000))
    result.runtime.runnerSamples = growthSamples(field, growth)
    expect(issues(result)).not.toContain(
      `runtime.runnerSamples.${field} grows without a stable bound`
    )
  }
  const result = mutable(validResult(150_000))
  result.runtime.runnerSamples = growthSamples(field, threshold + 1)
  expect(issues(result)).toContain(`runtime.runnerSamples.${field} grows without a stable bound`)
})

test.each(["rabbitConfirmInterruption", "redisFailover"] as const)(
  "60-minute result requires %s while short results do not",
  (field) => {
    const long = mutable(validResult(LongSoakDurationMs))
    long.scenarios[field] = false
    expect(issues(long)).toContain(`scenarios.${field} must equal true`)
    const short = mutable()
    short.scenarios[field] = false
    expect(issues(short)).not.toContain(`scenarios.${field} must equal true`)
  }
)

test("evaluator issue order is stable", () => {
  const result = mutable()
  result.load.requests = 0
  result.load.failedRequests = 1
  result.runtime.unexpectedErrors = 1
  result.scenarios.standardFetchHttp = false
  result.cleanup.clientClosed = false
  result.cleanup.residualVolumes = 1
  expect(issues(result)).toEqual([
    "load.requests must be positive",
    "load.failedRequests must equal 0",
    "runtime.unexpectedErrors must equal 0",
    "scenarios.standardFetchHttp must equal true",
    "cleanup.clientClosed must equal true",
    "cleanup.residualVolumes must equal 0"
  ])
})

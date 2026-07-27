import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { evaluateSoakResult, type SoakResult } from "./soak.cli"

const Roots: string[] = []
const CliPath = fileURLToPath(new URL("./soak.cli.ts", import.meta.url))

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function samples(durationMs: number, fdCount: number | null = 20) {
  const interval = durationMs >= 3_600_000 ? 5_000 : 1_000
  return Array.from({ length: Math.floor(durationMs / interval) + 1 }, (_value, index) => ({
    atMs: Math.min(index * interval, durationMs),
    rssBytes: 50_000_000 + (index % 3) * 100_000,
    heapUsedBytes: 10_000_000 + (index % 4) * 50_000,
    activeHandles: 8,
    fdCount
  }))
}

function result(durationMs = 10_000): SoakResult {
  return {
    schemaVersion: 3,
    command: [
      process.execPath,
      CliPath,
      "--duration",
      `${durationMs}ms`,
      "--output",
      ".artifacts/soak/test.json"
    ],
    startedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: new Date(Date.parse("2026-07-26T00:00:00.000Z") + durationMs).toISOString(),
    requestedDurationMs: durationMs,
    durationMs,
    environment: {
      arch: "arm64",
      bunVersion: "1.3.14",
      dockerVersion: "29.6.2",
      gitCleanAtFinish: true,
      gitCleanAtStart: true,
      gitHead: "0123456789abcdef0123456789abcdef01234567",
      k6Image:
        "grafana/k6:2.1.0@sha256:65c920dc067d5e2e00befbf982af6ad6ad0117034e8b1c65817c7975c52d4669",
      k6Version: "2.1.0",
      nodeVersion: "26.5.0",
      platform: "darwin"
    },
    load: {
      requests: 200,
      failedRequests: 0,
      checksFailed: 0,
      droppedIterations: 0,
      p50Ms: 2,
      p95Ms: 4,
      p99Ms: 8
    },
    runtime: {
      calls: 100,
      dials: 2,
      unexpectedErrors: 0,
      unhandledRejections: 0,
      runnerSamples: samples(durationMs),
      webHostSamples: samples(durationMs)
    },
    scenarios: {
      standardFetchHttp: true,
      clientPoolReuse: true,
      endpointChurn: true,
      shutdownUnderLoad: {
        admittedRequests: 8,
        drainedRequests: 8,
        rejectedAfterStop: true
      },
      rabbitConfirmInterruption: durationMs >= 3_600_000,
      redisFailover: durationMs >= 3_600_000
    },
    cleanup: {
      serverTerminal: true,
      clientClosed: true,
      portRebind: true,
      residualContainers: 0,
      residualNetworks: 0,
      residualVolumes: 0
    }
  }
}

test("accepts valid evidence but only marks a complete 60 minute run as release candidate", () => {
  expect(evaluateSoakResult(result())).toEqual({ issues: [], releaseCandidate: false })
  expect(evaluateSoakResult(result(3_600_000))).toEqual({ issues: [], releaseCandidate: true })
  const forged = { ...result(), scenarios: result(3_600_000).scenarios }
  expect(evaluateSoakResult(forged)).toEqual({ issues: [], releaseCandidate: false })
})

test("rejects forged runner provenance and a sample timeline shorter than the claimed duration", () => {
  const complete = result(3_600_000)
  const shortSamples = result().runtime.runnerSamples
  const cases: SoakResult[] = [
    { ...complete, command: ["unrelated"] },
    { ...complete, environment: { ...complete.environment, bunVersion: "0.0.0" } },
    { ...complete, environment: { ...complete.environment, nodeVersion: "0.0.0" } },
    { ...complete, runtime: { ...complete.runtime, runnerSamples: shortSamples } },
    {
      ...complete,
      runtime: {
        ...complete.runtime,
        webHostSamples: complete.runtime.webHostSamples.toReversed()
      }
    }
  ]
  for (const candidate of cases) {
    const evaluation = evaluateSoakResult(candidate)
    expect(evaluation.issues.length).toBeGreaterThan(0)
    expect(evaluation.releaseCandidate).toBeFalse()
  }
})

test("only clean source provenance can become a release candidate", () => {
  const complete = result(3_600_000)
  for (const environment of [
    { ...complete.environment, gitCleanAtStart: false },
    { ...complete.environment, gitCleanAtFinish: false }
  ]) {
    const evaluation = evaluateSoakResult({ ...complete, environment })
    expect(evaluation.issues).toEqual([])
    expect(evaluation.releaseCandidate).toBeFalse()
  }
})

test("fails closed on errors missing provenance cleanup and inconsistent latency", () => {
  const cases: SoakResult[] = [
    { ...result(), command: [] },
    { ...result(), environment: { ...result().environment, k6Version: "" } },
    { ...result(), load: { ...result().load, failedRequests: 1 } },
    { ...result(), load: { ...result().load, checksFailed: 1 } },
    { ...result(), load: { ...result().load, droppedIterations: 1 } },
    { ...result(), load: { ...result().load, p50Ms: 9 } },
    { ...result(), runtime: { ...result().runtime, calls: 2, dials: 2 } },
    { ...result(), runtime: { ...result().runtime, unexpectedErrors: 1 } },
    { ...result(), runtime: { ...result().runtime, unhandledRejections: 1 } },
    {
      ...result(),
      scenarios: {
        ...result().scenarios,
        shutdownUnderLoad: {
          admittedRequests: 1,
          drainedRequests: 1,
          rejectedAfterStop: true
        }
      }
    },
    {
      ...result(),
      scenarios: {
        ...result().scenarios,
        shutdownUnderLoad: {
          admittedRequests: 8,
          drainedRequests: 7,
          rejectedAfterStop: true
        }
      }
    },
    {
      ...result(),
      scenarios: {
        ...result().scenarios,
        shutdownUnderLoad: {
          admittedRequests: 8,
          drainedRequests: 8,
          rejectedAfterStop: false
        }
      }
    },
    { ...result(), cleanup: { ...result().cleanup, portRebind: false } },
    { ...result(), cleanup: { ...result().cleanup, residualContainers: 1 } },
    { ...result(), finishedAt: "2026-07-26T00:00:30.000Z" }
  ]
  for (const candidate of cases) {
    expect(evaluateSoakResult(candidate).issues.length).toBeGreaterThan(0)
  }
})

test("rejects sawtooth resource growth despite intermittent drops", () => {
  const growing = result(3_600_000)
  const runnerSamples = growing.runtime.runnerSamples.map((entry, index) => {
    const growth = Math.max(0, index - growing.runtime.runnerSamples.length / 2)
    const dip = index % 40 === 0 ? 2_000_000 : 0
    return {
      ...entry,
      rssBytes: entry.rssBytes + growth * 1_500_000 - dip,
      heapUsedBytes: entry.heapUsedBytes + growth * 750_000 - dip
    }
  })
  const evidence = { ...growing, runtime: { ...growing.runtime, runnerSamples } }
  expect(evaluateSoakResult(evidence).issues).toEqual(
    expect.arrayContaining([
      "runtime.runnerSamples.rssBytes grows without a stable bound",
      "runtime.runnerSamples.heapUsedBytes grows without a stable bound"
    ])
  )
})

test("distinguishes a late RSS plateau from sustained RSS growth", () => {
  const complete = result(3_600_000)
  const plateauAt = Math.floor(complete.runtime.runnerSamples.length * 0.83)
  const plateau = complete.runtime.runnerSamples.map((entry, index) => ({
    ...entry,
    rssBytes: entry.rssBytes + (index >= plateauAt ? 16 * 1024 * 1024 : 0)
  }))
  const growing = complete.runtime.runnerSamples.map((entry, index) => ({
    ...entry,
    rssBytes:
      entry.rssBytes +
      Math.max(0, index - Math.floor(complete.runtime.runnerSamples.length / 2)) * 100_000
  }))

  expect(
    evaluateSoakResult({
      ...complete,
      runtime: { ...complete.runtime, runnerSamples: plateau }
    }).issues
  ).not.toContain("runtime.runnerSamples.rssBytes grows without a stable bound")
  expect(
    evaluateSoakResult({
      ...complete,
      runtime: { ...complete.runtime, runnerSamples: growing }
    }).issues
  ).toContain("runtime.runnerSamples.rssBytes grows without a stable bound")
})

test("rejects retained handle and FD growth even after it plateaus", () => {
  const complete = result(3_600_000)
  const growthAt = Math.floor(complete.runtime.runnerSamples.length * 0.6)
  const runnerSamples = complete.runtime.runnerSamples.map((entry, index) => ({
    ...entry,
    activeHandles: entry.activeHandles + (index >= growthAt ? 100 : 0),
    fdCount: (entry.fdCount ?? 0) + (index >= growthAt ? 100 : 0)
  }))

  expect(
    evaluateSoakResult({
      ...complete,
      runtime: { ...complete.runtime, runnerSamples }
    }).issues
  ).toEqual(
    expect.arrayContaining([
      "runtime.runnerSamples.activeHandles grows without a stable bound",
      "runtime.runnerSamples.fdCount grows without a stable bound"
    ])
  )
})

test("rejects repeated retained-memory steps followed by a late plateau", () => {
  const complete = result(3_600_000)
  const steps = [0.6, 0.7, 0.8].map((ratio) =>
    Math.floor(complete.runtime.runnerSamples.length * ratio)
  )
  const runnerSamples = complete.runtime.runnerSamples.map((entry, index) => {
    const growth = steps.filter((step) => index >= step).length * 8 * 1024 * 1024
    return {
      ...entry,
      rssBytes: entry.rssBytes + growth,
      heapUsedBytes: entry.heapUsedBytes + growth
    }
  })

  expect(
    evaluateSoakResult({
      ...complete,
      runtime: { ...complete.runtime, runnerSamples }
    }).issues
  ).toEqual(
    expect.arrayContaining([
      "runtime.runnerSamples.rssBytes grows without a stable bound",
      "runtime.runnerSamples.heapUsedBytes grows without a stable bound"
    ])
  )
})

test("requires dense runtime samples and FD evidence on supported platforms", () => {
  const complete = result(3_600_000)
  const sparse = [complete.runtime.runnerSamples[0]!, complete.runtime.runnerSamples.at(-1)!]
  const missingFd = complete.runtime.webHostSamples.map((entry) => ({ ...entry, fdCount: null }))
  expect(
    evaluateSoakResult({
      ...complete,
      environment: { ...complete.environment, platform: "linux" },
      runtime: { ...complete.runtime, runnerSamples: sparse, webHostSamples: missingFd }
    }).issues
  ).toEqual(
    expect.arrayContaining([
      "runtime.runnerSamples must sample the requested load interval at least every 15 seconds",
      "runtime.webHostSamples.fdCount is required on linux"
    ])
  )
})

test("check CLI returns zero for valid evidence and nonzero for invalid evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-soak-check-"))
  Roots.push(root)
  const valid = join(root, "valid.json")
  const invalid = join(root, "invalid.json")
  await writeFile(valid, JSON.stringify(result()))
  await writeFile(invalid, JSON.stringify({ ...result(), command: [] }))
  const validRun = Bun.spawn([process.execPath, CliPath, "--check", valid], {
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(await validRun.exited).toBe(0)
  const invalidRun = Bun.spawn([process.execPath, CliPath, "--check", invalid], {
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(await invalidRun.exited).toBe(1)
})

test("root scripts expose the exact 60 minute runner and evidence-only checker", async () => {
  const manifest: { readonly scripts?: Readonly<Record<string, string>> } = await Bun.file(
    new URL("../package.json", import.meta.url)
  ).json()
  expect(manifest.scripts?.["soak:http"]).toBe(
    "bun scripts/soak.cli.ts --duration 60m --output .artifacts/soak/http.json"
  )
  expect(manifest.scripts?.["soak:check"]).toBe(
    "bun scripts/soak.cli.ts --check .artifacts/soak/http.json"
  )
})

test("k6 holds arrival rate with production keep-alive semantics", async () => {
  const source = await Bun.file(new URL("../e2e/load/k6-http.js", import.meta.url)).text()
  expect(source).toContain('dropped_iterations: ["count==0"]')
  expect(source).toContain("preAllocatedVUs: 32")
  expect(source).not.toContain("noConnectionReuse")
  expect(source).not.toContain("noVUConnectionReuse")
  expect(source).not.toContain('Connection: "close"')
})

test("soak persists raw k6 diagnostics before enforcing thresholds", async () => {
  const source = await Bun.file(new URL("./soak.cli.ts", import.meta.url)).text()
  const writeLog = source.indexOf('join(artifactRoot, "k6.log")')
  const writeRuntime = source.indexOf('join(artifactRoot, "runtime.json")')
  const checkThresholds = source.indexOf('checked(k6, "k6 HTTP soak")')
  expect(source).toContain('"--quiet"')
  expect(writeLog).toBeGreaterThan(0)
  expect(writeLog).toBeLessThan(checkThresholds)
  expect(writeRuntime).toBeLessThan(checkThresholds)
})

test("soak persists runtime samples before provider gates", async () => {
  const source = await Bun.file(new URL("./soak.cli.ts", import.meta.url)).text()
  const writeRuntime = source.indexOf('join(artifactRoot, "runtime.json")')
  const runProviders = source.indexOf('providerGate("@likego/broker-rabbitmq"')
  expect(writeRuntime).toBeGreaterThan(0)
  expect(writeRuntime).toBeLessThan(runProviders)
})

test("soak emits live machine-readable load and provider progress", async () => {
  const source = await Bun.file(new URL("./soak.cli.ts", import.meta.url)).text()
  const sampling = source.slice(
    source.indexOf("samplerStop = Promise.withResolvers<void>()"),
    source.indexOf("const k6Duration")
  )
  const provider = source.slice(
    source.indexOf("async function providerGate("),
    source.indexOf("/** Runs one real standard-Web")
  )
  expect(source).toContain("LIKEGO_SOAK_PROGRESS=")
  expect(source).toContain('progress({ phase: "load", status: "started"')
  expect(source).toContain('progress({ phase: "load", status: "completed"')
  expect(sampling.indexOf('progress({ phase: "load", status: "running"')).toBeGreaterThan(
    sampling.indexOf("webHostSamples.push(webHostSample)")
  )
  expect(sampling).toContain("nextProgressAtMs += 60_000")
  expect(source).not.toContain("setInterval(")
  expect(provider.indexOf('progress({ phase: "provider", status: "started"')).toBeLessThan(
    provider.indexOf("const result = await runCommand")
  )
  expect(provider.indexOf('progress({ phase: "provider", status: "completed"')).toBeGreaterThan(
    provider.indexOf("checked(result")
  )
})

test("soak runs Node-only internal service hosts in the Node process", async () => {
  const runner = await Bun.file(new URL("./soak.cli.ts", import.meta.url)).text()
  const host = await Bun.file(new URL("../e2e/load/web-host.ts", import.meta.url)).text()
  expect(runner).not.toContain('from "@likego/transport-http/node"')
  expect(host).toContain('from "@likego/transport-http/node"')
  expect(host).toContain("serviceEndpoints")
})

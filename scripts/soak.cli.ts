import { newClient, poolSize, poolTtl, withAddress, withTransport } from "@likego/client"
import { background, type Context } from "@likego/context"
import {
  type Client as TransportClient,
  type DialOption,
  type ListenOption,
  type Listener,
  type Message,
  type Option,
  type Options,
  type Transport
} from "@likego/transport"
import { newHTTPTransport } from "@likego/transport-http"
import { createServer as createHTTPServer } from "node:http"
import { mkdir, readdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { newDockerOwner, runCommand, verifyDockerOwnerCleanup } from "../e2e/suites"

const ReleaseDurationMs = 60 * 60 * 1_000
const BunVersion = "1.3.14"
const NodeVersion = "26.5.0"
const ConcurrentShutdownRequests = 8
const SampleCoverageToleranceMs = 5_000
const SampleDensityLimitMs = 15_000
const K6Image =
  "grafana/k6:2.1.0@sha256:65c920dc067d5e2e00befbf982af6ad6ad0117034e8b1c65817c7975c52d4669"
const Decoder = new TextDecoder()
const Root = resolve(import.meta.dir, "..")

export interface SoakSample {
  readonly atMs: number
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly activeHandles: number
  readonly fdCount: number | null
}

export interface SoakResult {
  readonly schemaVersion: 3
  readonly command: readonly string[]
  readonly startedAt: string
  readonly finishedAt: string
  readonly requestedDurationMs: number
  readonly durationMs: number
  readonly environment: {
    readonly arch: string
    readonly bunVersion: string
    readonly dockerVersion: string
    readonly gitCleanAtFinish: boolean
    readonly gitCleanAtStart: boolean
    readonly gitHead: string
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
  readonly releaseCandidate: boolean
}

interface CommandOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

interface WebHostResult {
  readonly admittedRequests: number
  readonly drainedRequests: number
  readonly serverTerminal: boolean
  readonly unhandledRejections: number
}

interface WebHost {
  readonly endpoint: string
  readonly serviceEndpoints: readonly [string, string]
  readonly result: Promise<WebHostResult>
  readonly send: (command: "release" | "stop") => Promise<void>
  readonly terminate: () => Promise<void>
  readonly waitForAdmissions: (count: number) => Promise<void>
}

const WebAdmittedMarker = "LIKEGO_SOAK_WEB_DRAIN_ADMITTED="
const WebReadyMarker = "LIKEGO_SOAK_WEB_READY="
const WebResultMarker = "LIKEGO_SOAK_WEB_RESULT="

function progress(event: Readonly<Record<string, unknown>>): void {
  process.stderr.write(`LIKEGO_SOAK_PROGRESS=${JSON.stringify(event)}\n`)
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function finite(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function median(values: readonly number[]): number {
  const ordered = values.toSorted((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0)
}

function sustainedGrowth(
  samples: readonly Readonly<Record<string, unknown>>[],
  field: keyof SoakSample,
  minimumGrowth: number,
  minimumRecentGrowth: number
): boolean {
  const firstAt = samples[0]?.atMs
  const lastAt = samples.at(-1)?.atMs
  if (!finite(firstAt) || !finite(lastAt) || lastAt - firstAt < 60_000) return false
  const values = samples.map((sample) => sample[field])
  if (values.some((value) => !finite(value))) return false
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
  raw: unknown,
  label: string,
  requestedDurationMs: unknown,
  durationMs: unknown,
  platform: unknown,
  issues: string[]
): readonly Readonly<Record<string, unknown>>[] {
  const rawSamples = Array.isArray(raw) ? raw : []
  const samples = rawSamples.map(record).filter((sample) => sample !== null)
  const validSamples = samples.every(
    (entry) =>
      finite(entry.atMs) &&
      finite(entry.rssBytes) &&
      finite(entry.heapUsedBytes) &&
      finite(entry.activeHandles) &&
      (entry.fdCount === null || finite(entry.fdCount))
  )
  if (samples.length === 0 || samples.length !== rawSamples.length || !validSamples) {
    issues.push(`${label} must contain valid objects`)
  }

  if (
    (platform === "linux" || platform === "darwin") &&
    samples.some((sample) => !finite(sample.fdCount))
  ) {
    issues.push(`${label}.fdCount is required on ${platform}`)
  }

  const times = samples.map((entry) => entry.atMs as number)
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
    finite(requestedDurationMs, ReleaseDurationMs) &&
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
  return samples
}

/** Evaluates persisted soak evidence without trusting its TypeScript annotation. */
export function evaluateSoakResult(value: unknown): SoakEvaluation {
  const issues: string[] = []
  const result = record(value)
  if (result === null) return { issues: ["result must be an object"], releaseCandidate: false }
  if (result.schemaVersion !== 3) issues.push("schemaVersion must equal 3")
  const command = Array.isArray(result.command) ? result.command : []
  let commandDuration: number | null = null
  try {
    commandDuration = nonempty(command[3]) ? duration(command[3]) : null
  } catch {}
  if (
    command.length !== 6 ||
    command.some((entry) => !nonempty(entry)) ||
    basename(String(command[0])) !== "bun" ||
    resolve(String(command[1])) !== resolve(Root, "scripts/soak.cli.ts") ||
    command[2] !== "--duration" ||
    command[4] !== "--output" ||
    commandDuration !== result.requestedDurationMs
  ) {
    issues.push("command must match the pinned soak runner and requested duration")
  }

  const startedAt = Date.parse(nonempty(result.startedAt) ? result.startedAt : "")
  const finishedAt = Date.parse(nonempty(result.finishedAt) ? result.finishedAt : "")
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    issues.push("startedAt and finishedAt must describe an ordered interval")
  }
  if (!finite(result.requestedDurationMs, 1)) issues.push("requestedDurationMs must be positive")
  if (!finite(result.durationMs, 1)) issues.push("durationMs must be positive")
  if (
    Number.isFinite(startedAt) &&
    Number.isFinite(finishedAt) &&
    finite(result.durationMs, 1) &&
    Math.abs(finishedAt - startedAt - result.durationMs) > 5_000
  ) {
    issues.push("durationMs must match the persisted UTC interval")
  }
  if (
    finite(result.requestedDurationMs, 1) &&
    finite(result.durationMs, 1) &&
    result.durationMs < result.requestedDurationMs
  ) {
    issues.push("durationMs must cover requestedDurationMs")
  }

  const environment = record(result.environment)
  const environmentFields = [
    "arch",
    "bunVersion",
    "dockerVersion",
    "gitHead",
    "k6Image",
    "k6Version",
    "nodeVersion",
    "platform"
  ] as const
  if (environment === null || environmentFields.some((field) => !nonempty(environment[field]))) {
    issues.push("environment provenance is incomplete")
  }
  if (
    environment === null ||
    typeof environment.gitCleanAtStart !== "boolean" ||
    typeof environment.gitCleanAtFinish !== "boolean"
  ) {
    issues.push("environment git provenance is incomplete")
  }
  if (
    environment !== null &&
    (environment.k6Image !== K6Image ||
      environment.k6Version !== "2.1.0" ||
      environment.bunVersion !== BunVersion ||
      environment.nodeVersion !== NodeVersion ||
      !/^[0-9a-f]{40,64}$/u.test(String(environment.gitHead)))
  ) {
    issues.push("environment provenance does not match the pinned soak runner")
  }

  const load = record(result.load)
  if (load === null || !finite(load.requests, 1)) issues.push("load.requests must be positive")
  if (load === null || load.failedRequests !== 0) issues.push("load.failedRequests must equal 0")
  if (load === null || load.checksFailed !== 0) issues.push("load.checksFailed must equal 0")
  if (load === null || load.droppedIterations !== 0) {
    issues.push("load.droppedIterations must equal 0")
  }
  if (
    load === null ||
    !finite(load.p50Ms) ||
    !finite(load.p95Ms) ||
    !finite(load.p99Ms) ||
    load.p50Ms > load.p95Ms ||
    load.p95Ms > load.p99Ms
  ) {
    issues.push("load latency quantiles must satisfy p50 <= p95 <= p99")
  }

  const runtime = record(result.runtime)
  if (runtime === null || !finite(runtime.calls, 1)) issues.push("runtime.calls must be positive")
  if (runtime === null || !finite(runtime.dials, 1)) issues.push("runtime.dials must be positive")
  if (
    runtime !== null &&
    finite(runtime.calls, 1) &&
    finite(runtime.dials, 1) &&
    runtime.calls <= runtime.dials
  ) {
    issues.push("runtime.calls must exceed runtime.dials")
  }
  if (runtime === null || runtime.unexpectedErrors !== 0) {
    issues.push("runtime.unexpectedErrors must equal 0")
  }
  if (runtime === null || runtime.unhandledRejections !== 0) {
    issues.push("runtime.unhandledRejections must equal 0")
  }
  evaluateSamples(
    runtime?.runnerSamples,
    "runtime.runnerSamples",
    result.requestedDurationMs,
    result.durationMs,
    environment?.platform,
    issues
  )
  evaluateSamples(
    runtime?.webHostSamples,
    "runtime.webHostSamples",
    result.requestedDurationMs,
    result.durationMs,
    environment?.platform,
    issues
  )

  const scenarios = record(result.scenarios)
  for (const field of ["standardFetchHttp", "clientPoolReuse", "endpointChurn"] as const) {
    if (scenarios?.[field] !== true) issues.push(`scenarios.${field} must equal true`)
  }
  const shutdown = record(scenarios?.shutdownUnderLoad)
  if (
    shutdown === null ||
    !finite(shutdown.admittedRequests, ConcurrentShutdownRequests) ||
    shutdown.drainedRequests !== shutdown.admittedRequests ||
    shutdown.rejectedAfterStop !== true
  ) {
    issues.push("scenarios.shutdownUnderLoad must prove concurrent drain and rejected admission")
  }
  const fullDuration =
    finite(result.requestedDurationMs) &&
    finite(result.durationMs) &&
    result.requestedDurationMs >= ReleaseDurationMs &&
    result.durationMs >= ReleaseDurationMs
  if (fullDuration) {
    if (scenarios?.rabbitConfirmInterruption !== true) {
      issues.push("scenarios.rabbitConfirmInterruption must equal true")
    }
    if (scenarios?.redisFailover !== true) issues.push("scenarios.redisFailover must equal true")
  }

  const cleanup = record(result.cleanup)
  for (const field of ["serverTerminal", "clientClosed", "portRebind"] as const) {
    if (cleanup?.[field] !== true) issues.push(`cleanup.${field} must equal true`)
  }
  for (const field of ["residualContainers", "residualNetworks", "residualVolumes"] as const) {
    if (cleanup?.[field] !== 0) issues.push(`cleanup.${field} must equal 0`)
  }

  return Object.freeze({
    issues: Object.freeze(issues),
    releaseCandidate:
      issues.length === 0 &&
      fullDuration &&
      environment?.gitCleanAtStart === true &&
      environment.gitCleanAtFinish === true &&
      scenarios?.rabbitConfirmInterruption === true &&
      scenarios.redisFailover === true
  })
}

function duration(value: string): number {
  const match = /^(\d+)(ms|s|m)$/u.exec(value)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new TypeError("--duration must use ms, s, or m")
  }
  const amount = Number(match[1])
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000
  const milliseconds = amount * multiplier
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new RangeError("--duration must be a positive safe duration")
  }
  return milliseconds
}

function errorValue(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`${label} exceeded ${milliseconds}ms`)),
      milliseconds
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      }
    )
  })
}

function checked(result: CommandOutput, label: string): CommandOutput {
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).slice(-4_000)}`)
  }
  return result
}

async function commandOutput(command: readonly string[], signal: AbortSignal): Promise<string> {
  return checked(
    await runCommand(Root, { command, cwd: ".", signal, timeoutMs: 30_000 }),
    command[0] ?? "command"
  ).stdout.trim()
}

async function version(command: readonly string[], signal: AbortSignal): Promise<string> {
  return (await commandOutput(command, signal)).replace(/^v/u, "")
}

async function environment(owner: string, signal: AbortSignal): Promise<SoakResult["environment"]> {
  const [dockerVersion, gitHead, gitStatus, k6Output, nodeVersion] = await Promise.all([
    version(["docker", "version", "--format", "{{.Server.Version}}"], signal),
    version(["git", "rev-parse", "HEAD"], signal),
    commandOutput(["git", "status", "--porcelain=v1", "--untracked-files=all"], signal),
    version(
      ["docker", "run", "--rm", "--label", `io.likego.e2e.owner=${owner}`, K6Image, "version"],
      signal
    ),
    version(["node", "--version"], signal)
  ])
  const k6Version = /k6 v?([0-9]+\.[0-9]+\.[0-9]+)/u.exec(k6Output)?.[1]
  if (k6Version === undefined) throw new Error(`cannot parse k6 version: ${k6Output}`)
  return Object.freeze({
    arch: process.arch,
    bunVersion: Bun.version,
    dockerVersion,
    gitCleanAtFinish: false,
    gitCleanAtStart: gitStatus.length === 0,
    gitHead,
    k6Image: K6Image,
    k6Version,
    nodeVersion,
    platform: process.platform
  })
}

function countingTransport(onDial: () => void): Transport {
  const subject = newHTTPTransport()
  return Object.freeze({
    kind(): string {
      return subject.kind?.() ?? "http"
    },
    init(...options: readonly Option[]): void {
      subject.init(...options)
    },
    options(): Options {
      return subject.options()
    },
    dial(
      ctx: Context,
      address: string,
      ...options: readonly DialOption[]
    ): Promise<TransportClient> {
      onDial()
      return subject.dial(ctx, address, ...options)
    },
    listen(ctx: Context, address: string, ...options: readonly ListenOption[]): Promise<Listener> {
      return subject.listen(ctx, address, ...options)
    },
    string(): string {
      return subject.string()
    }
  })
}

async function fdCount(): Promise<number | null> {
  const directory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"
  try {
    return (await readdir(directory)).length
  } catch {
    return null
  }
}

async function sampleRunner(atMs: number): Promise<SoakSample> {
  const memory = process.memoryUsage()
  return Object.freeze({
    atMs,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    activeHandles: process.getActiveResourcesInfo().length,
    fdCount: await fdCount()
  })
}

async function sampleWebHost(endpoint: URL, atMs: number): Promise<SoakSample> {
  const response = await fetch(new URL("/__likego/soak/runtime", endpoint), {
    signal: AbortSignal.timeout(2_000)
  })
  if (!response.ok) throw new Error(`Node Web host sample failed with HTTP ${response.status}`)
  const value = record(await response.json())
  if (
    value === null ||
    !finite(value.rssBytes) ||
    !finite(value.heapUsedBytes) ||
    !finite(value.activeHandles) ||
    (value.fdCount !== null && !finite(value.fdCount))
  ) {
    throw new Error("Node Web host returned an invalid runtime sample")
  }
  return Object.freeze({
    atMs,
    rssBytes: value.rssBytes,
    heapUsedBytes: value.heapUsedBytes,
    activeHandles: value.activeHandles,
    fdCount: value.fdCount
  })
}

function localURL(value: string): URL {
  const endpoint = new URL(value)
  endpoint.hostname = "127.0.0.1"
  return endpoint
}

async function startWebHost(): Promise<WebHost> {
  const ready = Promise.withResolvers<{
    readonly endpoint: string
    readonly serviceEndpoints: readonly [string, string]
  }>()
  const result = Promise.withResolvers<WebHostResult>()
  let admittedRequests = 0
  let admissionChanged = Promise.withResolvers<void>()
  const lines: string[] = []
  const child = Bun.spawn(["node", "--import", "tsx", "e2e/load/web-host.ts"], {
    cwd: Root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  })
  const readOutput = (async function readHostOutput(): Promise<void> {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    while (true) {
      const next = await reader.read()
      pending += decoder.decode(next.value, { stream: !next.done })
      const complete = pending.split(/\r?\n/u)
      pending = complete.pop() ?? ""
      for (const line of complete) {
        lines.push(line)
        if (line.startsWith(WebReadyMarker)) {
          const value = record(JSON.parse(line.slice(WebReadyMarker.length)))
          const serviceEndpoints = value?.serviceEndpoints
          const firstServiceEndpoint = Array.isArray(serviceEndpoints)
            ? serviceEndpoints[0]
            : undefined
          const secondServiceEndpoint = Array.isArray(serviceEndpoints)
            ? serviceEndpoints[1]
            : undefined
          if (
            !nonempty(value?.endpoint) ||
            !Array.isArray(serviceEndpoints) ||
            serviceEndpoints.length !== 2 ||
            !nonempty(firstServiceEndpoint) ||
            !nonempty(secondServiceEndpoint)
          ) {
            throw new Error("Node Web host omitted service endpoints")
          }
          ready.resolve({
            endpoint: value.endpoint,
            serviceEndpoints: [firstServiceEndpoint, secondServiceEndpoint]
          })
        } else if (line.startsWith(WebAdmittedMarker)) {
          const value = record(JSON.parse(line.slice(WebAdmittedMarker.length)))
          if (!finite(value?.admittedRequests, 1)) {
            throw new Error("Node Web host returned invalid admission evidence")
          }
          admittedRequests = value.admittedRequests
          admissionChanged.resolve()
          admissionChanged = Promise.withResolvers<void>()
        } else if (line.startsWith(WebResultMarker)) {
          const value = record(JSON.parse(line.slice(WebResultMarker.length)))
          if (
            value?.serverTerminal !== true ||
            !finite(value.admittedRequests, ConcurrentShutdownRequests) ||
            value.drainedRequests !== value.admittedRequests ||
            !finite(value.unhandledRejections)
          ) {
            throw new Error("Node Web host returned invalid terminal evidence")
          }
          result.resolve({
            admittedRequests: value.admittedRequests,
            drainedRequests: value.drainedRequests,
            serverTerminal: true,
            unhandledRejections: value.unhandledRejections
          })
        }
      }
      if (next.done) return
    }
  })()
  void readOutput.catch((error) => {
    ready.reject(error)
    result.reject(error)
  })
  const stderr = new Response(child.stderr).text()
  const terminal = (async function webHostTerminal(): Promise<WebHostResult> {
    const code = await child.exited
    await readOutput
    const diagnostics = await stderr
    if (code !== 0) {
      throw new Error(
        `Node Web host exited ${code}: ${(diagnostics || lines.join("\n")).slice(-4_000)}`
      )
    }
    return await within(result.promise, 1_000, "Node Web host result")
  })()
  void terminal.catch(() => {})
  const readyState = await within(
    Promise.race([
      ready.promise,
      terminal.then(() => {
        throw new Error("Node Web host exited before readiness")
      })
    ]),
    30_000,
    "Node Web host readiness"
  )

  return Object.freeze({
    endpoint: readyState.endpoint,
    serviceEndpoints: readyState.serviceEndpoints,
    result: terminal,
    async send(command: "release" | "stop"): Promise<void> {
      child.stdin.write(`${command}\n`)
      await child.stdin.flush()
    },
    async terminate(): Promise<void> {
      try {
        child.kill("SIGTERM")
      } catch {}
      await within(
        child.exited.then(() => undefined),
        10_000,
        "Node Web host termination"
      )
    },
    async waitForAdmissions(count: number): Promise<void> {
      while (admittedRequests < count) {
        const changed = admissionChanged.promise
        await changed
      }
    }
  })
}

async function rejectsAdmissionAfterStop(endpoint: URL): Promise<boolean> {
  const deadline = performance.now() + 5_000
  while (performance.now() < deadline) {
    try {
      const response = await fetch(endpoint, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(500)
      })
      await response.body?.cancel()
      if (!response.ok) return true
    } catch {
      return true
    }
    await Bun.sleep(10)
  }
  return false
}

async function rebind(endpoint: URL): Promise<boolean> {
  const server = createHTTPServer()
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(Number(endpoint.port), endpoint.hostname, resolvePromise)
    })
    return true
  } finally {
    if (server.listening) {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)))
      })
    }
  }
}

function metric(summary: unknown, name: string, field: string): number {
  const selected = record(record(record(summary)?.metrics)?.[name])?.[field]
  if (!finite(selected)) throw new Error(`k6 summary missing metrics.${name}.${field}`)
  return selected
}

function optionalMetric(summary: unknown, name: string, field: string): number {
  const selected = record(record(record(summary)?.metrics)?.[name])?.[field]
  if (selected === undefined) return 0
  if (!finite(selected)) throw new Error(`k6 summary has invalid metrics.${name}.${field}`)
  return selected
}

async function loadEvidence(path: string): Promise<SoakResult["load"]> {
  const summary: unknown = await Bun.file(path).json()
  const requests = metric(summary, "http_reqs", "count")
  return Object.freeze({
    requests,
    failedRequests: Math.round(metric(summary, "http_req_failed", "value") * requests),
    checksFailed: metric(summary, "checks", "fails"),
    droppedIterations: optionalMetric(summary, "dropped_iterations", "count"),
    p50Ms: metric(summary, "http_req_duration", "med"),
    p95Ms: metric(summary, "http_req_duration", "p(95)"),
    p99Ms: metric(summary, "http_req_duration", "p(99)")
  })
}

async function providerGate(
  packageName: string,
  owner: string,
  artifactRoot: string,
  signal: AbortSignal
): Promise<void> {
  progress({ phase: "provider", status: "started", packageName })
  const result = await runCommand(Root, {
    cwd: ".",
    command: ["bun", "run", "--filter", packageName, "test:docker"],
    timeoutMs: 10 * 60_000,
    environment: { LIKEGO_E2E_OWNER: owner },
    signal
  })
  const logName = packageName.endsWith("rabbitmq") ? "rabbitmq.log" : "redis.log"
  await Bun.write(
    join(artifactRoot, logName),
    `${result.stdout}${result.stderr.length > 0 ? `\n${result.stderr}` : ""}\n`
  )
  checked(result, `${packageName} Docker gate`)
  const tokens = packageName.endsWith("rabbitmq")
    ? ['"pendingCloseRejected": true', '"unhandledRejections": 0', '"cleanupVerified": true']
    : ["LIKEGO_CACHE_REDIS_E2E_RESULT=", '"replicatedBeforeFailover":true', '"residualVolumes":0']
  for (const token of tokens) {
    if (!result.stdout.includes(token))
      throw new Error(`${packageName} Docker gate omitted ${token}`)
  }
  progress({ phase: "provider", status: "completed", packageName })
}

/** Runs one real standard-Web and internal-Client soak, then persists complete evidence. */
export async function runSoak(requestedDurationMs: number, output: string): Promise<SoakResult> {
  const started = Date.now()
  const monotonicStarted = performance.now()
  const startedAt = new Date(started).toISOString()
  const dockerOwner = newDockerOwner("soak-http")
  const outputPath = resolve(Root, output)
  const artifactRoot = dirname(outputPath)
  const summaryPath = join(artifactRoot, "k6-summary.json")
  const k6Container = `likego-soak-${crypto.randomUUID().slice(0, 12)}`
  const runnerSamples: SoakSample[] = []
  const webHostSamples: SoakSample[] = []
  const unexpected: unknown[] = []
  const unhandled: unknown[] = []
  const recordUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  const interrupted = new AbortController()
  const onSigint = (): void => {
    process.off("SIGTERM", onSigterm)
    process.exitCode = 130
    interrupted.abort(new Error("soak interrupted by SIGINT"))
  }
  const onSigterm = (): void => {
    process.off("SIGINT", onSigint)
    process.exitCode = 143
    interrupted.abort(new Error("soak interrupted by SIGTERM"))
  }
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  process.on("unhandledRejection", recordUnhandled)

  let web: WebHost | null = null
  let client: ReturnType<typeof newClient> | null = null
  let calls = 0
  let dials = 0
  let clientClosed = false
  let serverTerminal = false
  let portRebind = false
  let shutdownUnderLoad: SoakResult["scenarios"]["shutdownUnderLoad"] = Object.freeze({
    admittedRequests: 0,
    drainedRequests: 0,
    rejectedAfterStop: false
  })
  let rabbitConfirmInterruption = false
  let redisFailover = false
  let webUnhandledRejections = 0
  let samplerStop: ReturnType<typeof Promise.withResolvers<void>> | null = null
  let sampling: Promise<void> | null = null
  let probeStop = false
  let probeRunning: Promise<void> | null = null
  let probeEndpoints = new Set<string>()

  try {
    await mkdir(artifactRoot, { recursive: true })
    const runtimeEnvironment = await environment(dockerOwner, interrupted.signal)
    web = await startWebHost()
    const endpoint = localURL(web.endpoint)
    const preflight = await fetch(endpoint)
    if (!preflight.ok || (await preflight.text()) !== "likego") {
      throw new Error("standard Fetch HTTP preflight failed")
    }

    client = newClient(
      poolSize(2),
      poolTtl(0),
      withTransport(
        countingTransport(() => {
          dials += 1
        })
      )
    )

    const loadStarted = performance.now()
    probeRunning = (async function probeClientPool(): Promise<void> {
      while (!probeStop) {
        const selected =
          performance.now() - loadStarted < requestedDurationMs / 2
            ? web.serviceEndpoints[0]
            : web.serviceEndpoints[1]
        probeEndpoints.add(selected)
        try {
          const response = await client?.call(
            background(),
            {
              service: "soak",
              endpoint: "Ping",
              message: { header: {}, body: new Uint8Array() }
            },
            withAddress(selected)
          )
          if (response === undefined || Decoder.decode(response.body).length !== 1) {
            throw new Error("internal Client returned an invalid response")
          }
          calls += 1
        } catch (error) {
          unexpected.push(error)
        }
        await Bun.sleep(100)
      }
    })()
    void probeRunning.catch((error) => unexpected.push(error))

    samplerStop = Promise.withResolvers<void>()
    const sampleInterval = requestedDurationMs >= ReleaseDurationMs ? 5_000 : 1_000
    let nextProgressAtMs = 60_000
    progress({ phase: "load", status: "started", elapsedMs: 0, requestedDurationMs })
    sampling = (async function collectSamples(): Promise<void> {
      try {
        while (true) {
          const atMs = Math.round(performance.now() - loadStarted)
          const [runnerSample, webHostSample] = await Promise.all([
            sampleRunner(atMs),
            sampleWebHost(endpoint, atMs)
          ])
          runnerSamples.push(runnerSample)
          webHostSamples.push(webHostSample)
          if (atMs >= nextProgressAtMs) {
            progress({ phase: "load", status: "running", elapsedMs: atMs, calls })
            nextProgressAtMs += 60_000
          }
          const stopped = await Promise.race([
            Bun.sleep(sampleInterval).then(() => false),
            samplerStop?.promise.then(() => true) ?? Promise.resolve(true)
          ])
          if (stopped) return
        }
      } catch (error) {
        unexpected.push(error)
        interrupted.abort(error)
      }
    })()

    const k6Duration = `${requestedDurationMs}ms`
    const k6 = await runCommand(Root, {
      cwd: ".",
      command: [
        "docker",
        "run",
        "--rm",
        "--name",
        k6Container,
        "--label",
        `io.likego.e2e.owner=${dockerOwner}`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `LIKEGO_SOAK_DURATION=${k6Duration}`,
        "--env",
        `LIKEGO_SOAK_URL=http://host.docker.internal:${endpoint.port}/`,
        "--volume",
        `${join(Root, "e2e/load/k6-http.js")}:/scripts/k6-http.js:ro`,
        "--volume",
        `${artifactRoot}:/results`,
        K6Image,
        "run",
        "--quiet",
        "--summary-export=/results/k6-summary.json",
        "/scripts/k6-http.js"
      ],
      signal: interrupted.signal,
      timeoutMs: requestedDurationMs + 2 * 60_000
    })
    await Bun.write(
      join(artifactRoot, "k6.log"),
      `${k6.stdout}${k6.stderr.length > 0 ? `\n${k6.stderr}` : ""}\n`
    )
    probeStop = true
    samplerStop.resolve()
    await Promise.all([probeRunning, sampling])
    const finalSampleAt = Math.round(performance.now() - loadStarted)
    const [finalRunnerSample, finalWebHostSample] = await Promise.all([
      sampleRunner(finalSampleAt),
      sampleWebHost(endpoint, finalSampleAt)
    ])
    runnerSamples.push(finalRunnerSample)
    webHostSamples.push(finalWebHostSample)
    progress({ phase: "load", status: "completed", elapsedMs: finalSampleAt, calls })

    const drainURL = new URL("/drain", endpoint)
    const draining = Array.from({ length: ConcurrentShutdownRequests }, () =>
      fetch(drainURL, { headers: { connection: "close" } })
    )
    await within(
      web.waitForAdmissions(ConcurrentShutdownRequests),
      5_000,
      "concurrent drain request admission"
    )
    await web.send("stop")
    const rejectedAfterStop = await rejectsAdmissionAfterStop(endpoint)
    await web.send("release")
    const drainResponses = await Promise.all(draining)
    const drainedBodies = await Promise.all(drainResponses.map((response) => response.text()))
    if (
      drainResponses.some((response) => !response.ok) ||
      drainedBodies.some((body) => body !== "drained")
    ) {
      throw new Error("in-flight HTTP request did not drain")
    }
    const webResult = await within(web.result, 15_000, "web server terminal")
    serverTerminal = webResult.serverTerminal
    shutdownUnderLoad = Object.freeze({
      admittedRequests: webResult.admittedRequests,
      drainedRequests: webResult.drainedRequests,
      rejectedAfterStop
    })
    webUnhandledRejections = webResult.unhandledRejections
    portRebind = await rebind(endpoint)

    await client.close(background())
    clientClosed = true
    const runtimeEvidence: SoakResult["runtime"] = Object.freeze({
      calls,
      dials,
      unexpectedErrors: unexpected.length,
      unhandledRejections: unhandled.length + webUnhandledRejections,
      runnerSamples: Object.freeze(runnerSamples),
      webHostSamples: Object.freeze(webHostSamples)
    })
    await Bun.write(
      join(artifactRoot, "runtime.json"),
      `${JSON.stringify(runtimeEvidence, null, 2)}\n`
    )
    checked(k6, "k6 HTTP soak")

    if (requestedDurationMs >= ReleaseDurationMs) {
      await providerGate("@likego/broker-rabbitmq", dockerOwner, artifactRoot, interrupted.signal)
      rabbitConfirmInterruption = true
      await providerGate("@likego/cache-redis", dockerOwner, artifactRoot, interrupted.signal)
      redisFailover = true
    }

    await verifyDockerOwnerCleanup(Root, dockerOwner, performance.now() + 60_000)
    const [finishedGitHead, finishedGitStatus] = await Promise.all([
      version(["git", "rev-parse", "HEAD"], interrupted.signal),
      commandOutput(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        interrupted.signal
      )
    ])
    const finalEnvironment: SoakResult["environment"] = Object.freeze({
      ...runtimeEnvironment,
      gitCleanAtFinish:
        finishedGitHead === runtimeEnvironment.gitHead && finishedGitStatus.length === 0
    })
    const durationMs = Math.round(performance.now() - monotonicStarted)
    const result: SoakResult = Object.freeze({
      schemaVersion: 3,
      command: Object.freeze(process.argv.slice()),
      startedAt,
      finishedAt: new Date().toISOString(),
      requestedDurationMs,
      durationMs,
      environment: finalEnvironment,
      load: await loadEvidence(summaryPath),
      runtime: runtimeEvidence,
      scenarios: Object.freeze({
        standardFetchHttp: true,
        clientPoolReuse: calls > dials && dials === 2,
        endpointChurn: probeEndpoints.size === 2,
        shutdownUnderLoad,
        rabbitConfirmInterruption,
        redisFailover
      }),
      cleanup: Object.freeze({
        serverTerminal,
        clientClosed,
        portRebind,
        residualContainers: 0,
        residualNetworks: 0,
        residualVolumes: 0
      })
    })
    const evaluation = evaluateSoakResult(result)
    await Bun.write(outputPath, `${JSON.stringify(result, null, 2)}\n`)
    if (evaluation.issues.length > 0) {
      throw new Error(`soak evidence failed: ${evaluation.issues.join("; ")}`)
    }
    return result
  } finally {
    probeStop = true
    samplerStop?.resolve()
    if (probeRunning !== null) {
      try {
        await within(probeRunning, 5_000, "client probe cleanup")
      } catch {}
    }
    if (sampling !== null) {
      try {
        await within(sampling, 5_000, "resource sampler cleanup")
      } catch {}
    }
    if (!clientClosed && client !== null) {
      try {
        await client.close(background())
      } catch {}
    }
    if (!serverTerminal && web !== null) {
      try {
        await web.send("release")
        await web.send("stop")
        await within(web.result, 15_000, "Node Web host cleanup")
      } catch {
        try {
          await web.terminate()
        } catch {}
      }
    }
    try {
      await verifyDockerOwnerCleanup(Root, dockerOwner, performance.now() + 60_000)
    } catch {}
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
    process.off("unhandledRejection", recordUnhandled)
  }
}

async function check(path: string): Promise<void> {
  const result: unknown = await Bun.file(resolve(Root, path)).json()
  const evaluation = evaluateSoakResult(result)
  console.log(
    `LIKEGO_SOAK_CHECK_RESULT=${JSON.stringify({ ...evaluation, path: resolve(Root, path) })}`
  )
  if (evaluation.issues.length > 0) process.exitCode = 1
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === "--check" && args.length === 2 && args[1] !== undefined) {
    await check(args[1])
    return
  }
  if (
    args[0] !== "--duration" ||
    args[1] === undefined ||
    args[2] !== "--output" ||
    args[3] === undefined ||
    args.length !== 4
  ) {
    throw new TypeError("usage: soak.cli.ts --duration <Nms|Ns|Nm> --output <path>")
  }
  const result = await runSoak(duration(args[1]), args[3])
  console.log(
    `LIKEGO_SOAK_RESULT=${JSON.stringify({
      output: resolve(Root, args[3]),
      releaseCandidate: evaluateSoakResult(result).releaseCandidate,
      result
    })}`
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    if (process.exitCode === 130 || process.exitCode === 143) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    } else {
      throw error
    }
  }
}

import { newClient, poolSize, poolTtl, withAddress, withTransport } from "@go-like/client"
import { background, type Context } from "@go-like/context"
import {
  type Client as TransportClient,
  type DialOption,
  type ListenOption,
  type Listener,
  type Message,
  type Option,
  type Options,
  type Transport
} from "@go-like/transport"
import { newHTTPTransport } from "@go-like/transport-http"
import { createServer as createHTTPServer } from "node:http"
import { mkdir, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { collectCleanupFailure, type CleanupFailure, finalizeWithCleanup } from "./harness/cleanup"
import { boundedTail, errorSummary, redactText } from "./harness/diagnostics"
import { newDockerOwner, verifyDockerOwnerCleanup } from "./harness/docker-owner"
import { runCommand, type CommandResult } from "./harness/process"
import {
  createTempDirectory,
  createTempSubdirectory,
  removeTempDirectory,
  verifyTempDirectory,
  type TempDirectory
} from "./harness/temp"
import {
  ConcurrentShutdownRequests,
  evaluateSoakResult,
  LongSoakDurationMs,
  parseSoakResultJson,
  type SoakResult,
  type SoakSample
} from "./soak-evaluator"

export {
  evaluateSoakResult,
  parseSoakResult,
  parseSoakResultJson,
  SoakResultShapeError
} from "./soak-evaluator"
export type { SoakEvaluation, SoakResult, SoakSample } from "./soak-evaluator"

export const K6Image =
  "grafana/k6:2.1.0@sha256:65c920dc067d5e2e00befbf982af6ad6ad0117034e8b1c65817c7975c52d4669"
export const K6Version = "2.1.0"
export const K6Workload = "/scripts/k6-http.ts"
const Decoder = new TextDecoder()
const Root = resolve(import.meta.dir, "..")

interface CommandOutput {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly termination: "exit" | "signal" | "timeout" | "abort" | "supervisor-error"
  readonly cleanupFailures?: CommandResult["cleanupFailures"] | undefined
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
  readonly terminate: () => void
  readonly waitForTermination: () => Promise<void>
  readonly waitForAdmissions: (count: number) => Promise<void>
}

export interface SoakCleanupActions {
  readonly probeStop: (() => void | Promise<void>) | null
  readonly probeWait: (() => void | Promise<void>) | null
  readonly samplerStop: (() => void | Promise<void>) | null
  readonly samplerWait: (() => void | Promise<void>) | null
  readonly client: (() => void | Promise<void>) | null
  readonly webRelease: (() => void | Promise<void>) | null
  readonly webStop: (() => void | Promise<void>) | null
  readonly webResult: (() => void | Promise<void>) | null
  readonly webTerminate: (() => void | Promise<void>) | null
  readonly webTerminateWait: (() => void | Promise<void>) | null
  readonly docker: () => void | Promise<void>
  readonly temp: (() => void | Promise<void>) | null
  readonly listeners: () => void | Promise<void>
  readonly observer: () => void | Promise<void>
}

/** Runs short-lifecycle cleanup in dependency order without hiding later failures. */
export async function collectSoakCleanupFailures(
  actions: SoakCleanupActions
): Promise<readonly CleanupFailure[]> {
  const failures: CleanupFailure[] = []
  if (actions.probeStop !== null)
    await collectCleanupFailure(failures, "client probe stop", actions.probeStop)
  if (actions.probeWait !== null)
    await collectCleanupFailure(failures, "client probe wait", actions.probeWait)
  if (actions.samplerStop !== null)
    await collectCleanupFailure(failures, "resource sampler stop", actions.samplerStop)
  if (actions.samplerWait !== null)
    await collectCleanupFailure(failures, "resource sampler wait", actions.samplerWait)
  if (actions.client !== null) {
    await collectCleanupFailure(failures, "client cleanup", actions.client)
  }
  const failuresBeforeWeb = failures.length
  let gracefulWebAction = false
  if (actions.webRelease !== null) {
    gracefulWebAction = true
    await collectCleanupFailure(failures, "Node Web host release", actions.webRelease)
  }
  if (actions.webStop !== null) {
    gracefulWebAction = true
    await collectCleanupFailure(failures, "Node Web host stop", actions.webStop)
  }
  if (actions.webResult !== null) {
    gracefulWebAction = true
    await collectCleanupFailure(failures, "Node Web host terminal wait", actions.webResult)
  }
  if (!gracefulWebAction || failures.length > failuresBeforeWeb) {
    if (actions.webTerminate !== null) {
      await collectCleanupFailure(failures, "Node Web host force terminate", actions.webTerminate)
    }
    if (actions.webTerminateWait !== null) {
      await collectCleanupFailure(
        failures,
        "Node Web host force termination wait",
        actions.webTerminateWait
      )
    }
  }
  await collectCleanupFailure(failures, "Docker owner cleanup", actions.docker)
  if (actions.temp !== null) {
    await collectCleanupFailure(failures, "soak stage cleanup", actions.temp)
  }
  await collectCleanupFailure(failures, "signal listener cleanup", actions.listeners)
  await collectCleanupFailure(failures, "unhandled rejection observer cleanup", actions.observer)
  return Object.freeze(failures)
}

const WebAdmittedMarker = "GO_LIKE_SOAK_WEB_DRAIN_ADMITTED="
const WebReadyMarker = "GO_LIKE_SOAK_WEB_READY="
const WebResultMarker = "GO_LIKE_SOAK_WEB_RESULT="

function progress(event: Readonly<Record<string, unknown>>): void {
  process.stderr.write(`GO_LIKE_SOAK_PROGRESS=${JSON.stringify(event)}\n`)
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

export function checked(
  result: CommandOutput,
  label: string,
  knownSecrets: readonly string[] = []
): CommandOutput {
  if (
    result.timedOut ||
    result.termination !== "exit" ||
    result.exitCode !== 0 ||
    (result.cleanupFailures?.length ?? 0) > 0
  ) {
    const output = boundedTail(redactText(result.stderr || result.stdout, { knownSecrets }), 4_000)
    const cleanup = redactText(
      result.cleanupFailures?.map((failure) => failure.summary).join("; ") ?? "",
      { knownSecrets }
    )
    const diagnostics = [output, cleanup].filter((value) => value.length > 0).join("; ")
    throw new Error(
      `${label} failed: termination=${result.termination} exit=${String(result.exitCode)}${diagnostics.length > 0 ? `: ${diagnostics}` : ""}`
    )
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

export function parseK6Version(output: string): string {
  const match = /^k6 v([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/u.exec(output.trim())
  if (match?.[1] === undefined) {
    throw new Error(`cannot parse k6 version: ${boundedTail(redactText(output), 1_000)}`)
  }
  if (match[1] !== K6Version) {
    throw new Error(`expected k6 ${K6Version}, received ${match[1]}`)
  }
  return match[1]
}

export function k6VersionCommand(owner: string): readonly string[] {
  return Object.freeze([
    "docker",
    "run",
    "--rm",
    "--label",
    `io.go-like.e2e.owner=${owner}`,
    K6Image,
    "version"
  ])
}

export function k6RunCommand(
  root: string,
  owner: string,
  container: string,
  requestedDurationMs: number,
  endpointPort: string,
  resultsPath: string
): readonly string[] {
  return Object.freeze([
    "docker",
    "run",
    "--rm",
    "--name",
    container,
    "--label",
    `io.go-like.e2e.owner=${owner}`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--env",
    `GO_LIKE_SOAK_DURATION=${requestedDurationMs}ms`,
    "--env",
    `GO_LIKE_SOAK_URL=http://host.docker.internal:${endpointPort}/`,
    "--volume",
    `${join(root, "e2e/load/k6-http.ts")}:${K6Workload}:ro`,
    "--volume",
    `${resultsPath}:/results`,
    K6Image,
    "run",
    "--quiet",
    "--summary-export=/results/k6-summary.json",
    K6Workload
  ])
}

export async function preflightK6(
  owner: string,
  signal: AbortSignal,
  runner: typeof runCommand = runCommand
): Promise<string> {
  const output = checked(
    await runner(Root, {
      command: k6VersionCommand(owner),
      cwd: ".",
      signal,
      timeoutMs: 30_000
    }),
    "k6 version"
  ).stdout
  return parseK6Version(output)
}

async function environment(owner: string, signal: AbortSignal): Promise<SoakResult["environment"]> {
  const k6Version = await preflightK6(owner, signal)
  const [dockerVersion, nodeVersion] = await Promise.all([
    version(["docker", "version", "--format", "{{.Server.Version}}"], signal),
    version(["node", "--version"], signal)
  ])
  return Object.freeze({
    arch: process.arch,
    bunVersion: Bun.version,
    dockerVersion,
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
  const response = await fetch(new URL("/__go-like/soak/runtime", endpoint), {
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
    env: { ...process.env, TSX_TSCONFIG_PATH: "e2e/tsconfig.json" },
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
            throw new Error("Node Web host returned invalid admission result")
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
            throw new Error("Node Web host returned invalid terminal result")
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
  void terminal.catch((error) => {
    ready.reject(error)
    result.reject(error)
  })
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
    terminate(): void {
      if (child.exitCode === null) {
        try {
          child.kill("SIGTERM")
        } catch (error) {
          if (child.exitCode === null) throw error
        }
      }
    },
    async waitForTermination(): Promise<void> {
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

export async function loadMetrics(path: string): Promise<SoakResult["load"]> {
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

async function runProviderScenario(
  packageName: string,
  owner: string,
  artifactRoot: string,
  signal: AbortSignal
): Promise<void> {
  progress({ phase: "provider", status: "started", packageName })
  const result = await runCommand(Root, {
    cwd: ".",
    command: ["bun", "run", "--filter", packageName, "test:e2e"],
    timeoutMs: 10 * 60_000,
    environment: { GO_LIKE_E2E_OWNER: owner },
    signal
  })
  const logName = packageName.endsWith("rabbitmq") ? "rabbitmq.log" : "redis.log"
  await Bun.write(
    join(artifactRoot, logName),
    `${result.stdout}${result.stderr.length > 0 ? `\n${result.stderr}` : ""}\n`
  )
  checked(result, `${packageName} Docker scenario`)
  progress({ phase: "provider", status: "completed", packageName })
}

/** Runs one real standard-Web and internal-Client soak, then writes its diagnostics. */
export async function runSoak(requestedDurationMs: number, output: string): Promise<SoakResult> {
  const started = Date.now()
  const monotonicStarted = performance.now()
  const startedAt = new Date(started).toISOString()
  const dockerOwner = newDockerOwner("soak-http")
  const outputPath = resolve(Root, output)
  const artifactRoot = dirname(outputPath)
  const summaryArtifactPath = join(artifactRoot, "k6-summary.json")
  const k6Container = `go-like-soak-${crypto.randomUUID().slice(0, 12)}`
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
  let stageDirectory: TempDirectory | null = null
  let stageRoot: string | null = null
  let completed: SoakResult | null = null
  let primary: unknown | null = null

  try {
    await mkdir(artifactRoot, { recursive: true })
    stageDirectory = await createTempDirectory("go-like-soak-")
    stageRoot = await createTempSubdirectory(stageDirectory, ["results"])
    await verifyTempDirectory(stageDirectory)
    const summaryPath = join(stageRoot, "k6-summary.json")
    const runtimeEnvironment = await environment(dockerOwner, interrupted.signal)
    web = await startWebHost()
    const endpoint = localURL(web.endpoint)
    const preflight = await fetch(endpoint)
    if (!preflight.ok || (await preflight.text()) !== "go-like") {
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
    const sampleInterval = requestedDurationMs >= LongSoakDurationMs ? 5_000 : 1_000
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

    const k6 = await runCommand(Root, {
      cwd: ".",
      command: k6RunCommand(
        Root,
        dockerOwner,
        k6Container,
        requestedDurationMs,
        endpoint.port,
        stageRoot
      ),
      signal: interrupted.signal,
      timeoutMs: requestedDurationMs + 2 * 60_000
    })
    await Bun.write(
      join(artifactRoot, "k6.log"),
      `${k6.stdout}${k6.stderr.length > 0 ? `\n${k6.stderr}` : ""}\n`
    )
    checked(k6, "k6 HTTP short lifecycle")
    probeStop = true
    samplerStop.resolve()
    await Promise.all([probeRunning, sampling])
    probeRunning = null
    sampling = null
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
    const runtime: SoakResult["runtime"] = Object.freeze({
      calls,
      dials,
      unexpectedErrors: unexpected.length,
      unhandledRejections: unhandled.length + webUnhandledRejections,
      runnerSamples: Object.freeze(runnerSamples),
      webHostSamples: Object.freeze(webHostSamples)
    })
    await Bun.write(join(artifactRoot, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`)

    if (requestedDurationMs >= LongSoakDurationMs) {
      await runProviderScenario(
        "@go-like/broker-rabbitmq",
        dockerOwner,
        artifactRoot,
        interrupted.signal
      )
      rabbitConfirmInterruption = true
      await runProviderScenario(
        "@go-like/cache-redis",
        dockerOwner,
        artifactRoot,
        interrupted.signal
      )
      redisFailover = true
    }

    await verifyDockerOwnerCleanup(Root, dockerOwner, performance.now() + 60_000)
    const load = await loadMetrics(summaryPath)
    await Bun.write(summaryArtifactPath, await Bun.file(summaryPath).text())
    const durationMs = Math.round(performance.now() - monotonicStarted)
    const result: SoakResult = Object.freeze({
      startedAt,
      finishedAt: new Date().toISOString(),
      requestedDurationMs,
      durationMs,
      environment: runtimeEnvironment,
      load,
      runtime,
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
    const resultJson = `${JSON.stringify(result, null, 2)}\n`
    await Bun.write(outputPath, resultJson)
    const evaluation = evaluateSoakResult(parseSoakResultJson(resultJson))
    if (evaluation.issues.length > 0) {
      throw new Error(`soak thresholds failed: ${evaluation.issues.join("; ")}`)
    }
    completed = result
  } catch (error) {
    primary = error
  }

  const activeProbe = probeRunning
  const activeSampling = sampling
  const activeSamplerStop = samplerStop
  const activeClient = clientClosed ? null : client
  const activeWeb = serverTerminal ? null : web
  const activeStage = stageDirectory
  const cleanupFailures = await collectSoakCleanupFailures({
    probeStop:
      activeProbe === null
        ? null
        : () => {
            probeStop = true
          },
    probeWait:
      activeProbe === null ? null : () => within(activeProbe, 5_000, "client probe cleanup"),
    samplerStop:
      activeSampling === null || activeSamplerStop === null
        ? null
        : () => activeSamplerStop.resolve(),
    samplerWait:
      activeSampling === null
        ? null
        : () => within(activeSampling, 5_000, "resource sampler cleanup"),
    client:
      activeClient === null
        ? null
        : async () => {
            await activeClient.close(background())
            clientClosed = true
          },
    webRelease: activeWeb === null ? null : () => activeWeb.send("release"),
    webStop: activeWeb === null ? null : () => activeWeb.send("stop"),
    webResult:
      activeWeb === null
        ? null
        : async () => {
            const result = await within(activeWeb.result, 15_000, "Node Web host cleanup")
            serverTerminal = result.serverTerminal
          },
    webTerminate: activeWeb === null ? null : () => activeWeb.terminate(),
    webTerminateWait: activeWeb === null ? null : () => activeWeb.waitForTermination(),
    docker: () => verifyDockerOwnerCleanup(Root, dockerOwner, performance.now() + 60_000),
    temp: activeStage === null ? null : () => removeTempDirectory(activeStage),
    listeners: () => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
    },
    observer: () => {
      process.off("unhandledRejection", recordUnhandled)
    }
  })
  finalizeWithCleanup(
    primary,
    cleanupFailures,
    "go-like short lifecycle failed and cleanup also failed"
  )
  if (completed === null) throw new Error("go-like short lifecycle completed without a result")
  return completed
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (
    args[0] !== "--duration" ||
    args[1] === undefined ||
    args[2] !== "--output" ||
    args[3] === undefined ||
    args.length !== 4
  ) {
    throw new TypeError("usage: e2e/soak.ts --duration <Nms|Ns|Nm> --output <path>")
  }
  await runSoak(duration(args[1]), args[3])
  console.log(`GO_LIKE_SOAK_RESULT=${JSON.stringify({ output: resolve(Root, args[3]) })}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    if (process.exitCode === 130 || process.exitCode === 143) {
      process.stderr.write(`${errorSummary(error)}\n`)
    } else {
      process.stderr.write(`${errorSummary(error)}\n`)
      process.exitCode = 1
    }
  }
}

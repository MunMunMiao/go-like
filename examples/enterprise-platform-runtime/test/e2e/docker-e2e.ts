import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { newClient, withDiscovery, withSelector, withTransport, type Client } from "@go-like/client"
import { newConfig, schema, source } from "@go-like/config"
import { vaultSource } from "@go-like/config-vault"
import { background, withoutCancel } from "@go-like/context"
import {
  afterStop,
  beforeStart,
  endpoint,
  id,
  metadata,
  name,
  newApp,
  registrar,
  server,
  stopTimeout,
  version,
  type App
} from "@go-like/core"
import { newProbeRegistry } from "@go-like/health"
import { newOtelServer, traceClient, traceUnaryMiddleware } from "@go-like/otel"
import { newPinoServer } from "@go-like/pino"
import { createPrometheusHandler } from "@go-like/prometheus"
import { newRoundRobinSelector } from "@go-like/registry"
import { newConsulRegistry } from "@go-like/registry-consul"
import {
  address,
  handler as serviceHandler,
  middleware,
  newServer,
  transport as serverTransport
} from "@go-like/server"
import { newHTTPTransport } from "@go-like/transport-http"
import { newNodeHTTPTransport } from "@go-like/transport-http/node"
import { createHealthHandler } from "@go-like/web/health"
import { hostname, newNodeServer, port } from "@go-like/web/node"
import { context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics
} from "@opentelemetry/sdk-metrics"
import {
  BatchSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter
} from "@opentelemetry/sdk-trace"
import pino from "pino"
import { Counter, Registry } from "prom-client"

import {
  boundedTail,
  createStreamingRedactor,
  errorSummary,
  sanitizeArgv
} from "../../../../e2e/harness/diagnostics"
import {
  closeOwnedDockerContext,
  createContainer,
  ownedDockerContextFromEnvironment,
  scenarioDockerEnvironment,
  type OwnedDockerContext
} from "../../../../e2e/harness/owned-docker"
import type {
  CommandDefinition as SupervisedCommandDefinition,
  CommandResult as SupervisedCommandResult,
  ProcessSupervisor
} from "../../../../e2e/harness/process"
import { runtimeConfigSchema } from "#src/config"
import { echoEndpointName, echoServiceName, newEchoHandler } from "#src/echo"
import { newManagementHandler } from "#src/management"
import { registerRuntimeProbes } from "#src/probes"
import { newPlatformRuntimeState } from "#src/runtime-state"

const ConsulImage =
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
const VaultImage =
  "hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54"
const CollectorImage =
  "otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6"
const Here = dirname(fileURLToPath(import.meta.url))

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

type SupervisedFailure = SupervisedCommandResult["cleanupFailures"][number]

/** Builds the child environment without exposing its values to diagnostics. */
function inheritedEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = Object.freeze({})
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name]
    else environment[name] = value
  }
  return environment
}

/** Runs Docker CLI children inside the scenario's already-supervised process boundary. */
const inheritedBoundaryRunner: ProcessSupervisor["run"] = async function runInheritedCommand(
  root: string,
  definition: SupervisedCommandDefinition
): Promise<SupervisedCommandResult> {
  const startedAt = performance.now()
  const knownSecrets = Object.freeze([...(definition.knownSecrets ?? [])])
  const sanitizer = Object.freeze({ knownSecrets })
  const operation = "Owned Docker inherited-boundary subprocess"
  const cleanupFailures: SupervisedFailure[] = []
  const result = (values: {
    readonly exitCode: number | null
    readonly signal: string | null
    readonly termination: SupervisedCommandResult["termination"]
    readonly timedOut: boolean
    readonly abortReason: string | null
    readonly stdout?: string | undefined
    readonly stderr?: string | undefined
  }): SupervisedCommandResult =>
    Object.freeze({
      exitCode: values.exitCode,
      signal: values.signal,
      termination: values.termination,
      timedOut: values.timedOut,
      abortReason: values.abortReason,
      durationMs: Math.round(performance.now() - startedAt),
      stdout: values.stdout ?? "",
      stderr: values.stderr ?? "",
      cleanupFailures: Object.freeze(cleanupFailures.slice()),
      containment: "not-claimed",
      residual: cleanupFailures.length === 0 ? "zero-observed" : "inconclusive"
    })
  const safeSummary = (value: unknown, fallback: string): string =>
    errorSummary(value, sanitizer) || fallback
  const appendOutput = (current: string, value: string): string =>
    boundedTail(`${current}${value}`, 64 * 1024)
  const cleanupFailure = (value: unknown): void => {
    cleanupFailures.push(
      Object.freeze({
        code: "inherited-boundary-termination-failed",
        category: "process-cleanup",
        summary: `${operation}: ${safeSummary(value, "termination failed")}`
      })
    )
  }

  const command = Object.freeze(definition.command.slice())
  const environment = Object.freeze({ ...definition.environment })
  const executable = command[0]
  if (executable === undefined || executable.length === 0) {
    return result({
      exitCode: null,
      signal: null,
      termination: "supervisor-error",
      timedOut: false,
      abortReason: `${operation}: command argv is empty`
    })
  }
  if (definition.signal?.aborted === true) {
    return result({
      exitCode: null,
      signal: null,
      termination: "abort",
      timedOut: false,
      abortReason: safeSummary(definition.signal.reason, "command was aborted before spawn")
    })
  }

  const stdoutRedactor = createStreamingRedactor(sanitizer)
  const stderrRedactor = createStreamingRedactor(sanitizer)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(executable, command.slice(1), {
      cwd: resolve(root, definition.cwd),
      env: inheritedEnvironment(environment),
      detached: false,
      stdio: ["ignore", "pipe", "pipe"]
    })
  } catch (value) {
    return result({
      exitCode: null,
      signal: null,
      termination: "supervisor-error",
      timedOut: false,
      abortReason: `${operation}: ${safeSummary(value, "spawn failed")}`
    })
  }

  let stdout = ""
  let stderr = ""
  let processFailure: unknown = null
  let outputFailure: unknown = null
  let requestedTermination: "abort" | "supervisor-error" | "timeout" | null = null
  let escalation: ReturnType<typeof setTimeout> | null = null
  let terminationFailure: unknown = null

  const requestTermination = (termination: "abort" | "supervisor-error" | "timeout"): void => {
    if (requestedTermination !== null) return
    requestedTermination = termination
    try {
      child.kill("SIGTERM")
    } catch (value) {
      terminationFailure ??= value
    }
    escalation = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill("SIGKILL")
      } catch (value) {
        terminationFailure ??= value
      }
    }, 2_000)
  }
  const forward = (stream: "stdout" | "stderr", value: string): void => {
    if (value.length === 0) return
    try {
      if (stream === "stdout") {
        stdout = appendOutput(stdout, value)
        definition.onStdout?.(value)
        if (definition.forwardOutput === true) process.stdout.write(value)
      } else {
        stderr = appendOutput(stderr, value)
        definition.onStderr?.(value)
        if (definition.forwardOutput === true) process.stderr.write(value)
      }
    } catch (value) {
      outputFailure ??= value
      requestTermination("supervisor-error")
    }
  }
  if (child.stdout === null || child.stderr === null) {
    requestTermination("supervisor-error")
    await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()))
    if (escalation !== null) clearTimeout(escalation)
    if (terminationFailure !== null) cleanupFailure(terminationFailure)
    return result({
      exitCode: null,
      signal: null,
      termination: "supervisor-error",
      timedOut: false,
      abortReason: `${operation}: subprocess pipes were unavailable`
    })
  }
  child.stdout.on("data", (value: Buffer) => {
    try {
      forward("stdout", stdoutRedactor.write(value))
    } catch (failure) {
      outputFailure ??= failure
      requestTermination("supervisor-error")
    }
  })
  child.stderr.on("data", (value: Buffer) => {
    try {
      forward("stderr", stderrRedactor.write(value))
    } catch (failure) {
      outputFailure ??= failure
      requestTermination("supervisor-error")
    }
  })
  const closed = new Promise<{
    readonly code: number | null
    readonly signal: string | null
  }>((resolvePromise) => {
    child.once("error", (value) => {
      processFailure = value
    })
    child.once("close", (code, signal) => resolvePromise({ code, signal }))
  })
  const timeout = setTimeout(() => requestTermination("timeout"), definition.timeoutMs)
  const onAbort = (): void => requestTermination("abort")
  definition.signal?.addEventListener("abort", onAbort, { once: true })
  const abortState = (): boolean => definition.signal?.aborted === true
  if (abortState()) onAbort()
  const closedResult = await closed
  clearTimeout(timeout)
  if (escalation !== null) clearTimeout(escalation)
  definition.signal?.removeEventListener("abort", onAbort)
  if (terminationFailure !== null) cleanupFailure(terminationFailure)
  try {
    forward("stdout", stdoutRedactor.end())
    forward("stderr", stderrRedactor.end())
  } catch (value) {
    outputFailure ??= value
  }

  const supervisorFailure = outputFailure ?? processFailure
  const terminationRequest = (): "abort" | "supervisor-error" | "timeout" | null =>
    requestedTermination
  const requested = terminationRequest()
  const termination: SupervisedCommandResult["termination"] =
    requested === "abort" || requested === "timeout"
      ? requested
      : supervisorFailure !== null || requested === "supervisor-error"
        ? "supervisor-error"
        : closedResult.signal === null
          ? "exit"
          : "signal"
  const cleanupRecorded = cleanupFailures.length > 0
  const abortReason =
    termination === "abort"
      ? safeSummary(definition.signal?.reason, "command was aborted")
      : termination === "supervisor-error"
        ? `${operation}: ${safeSummary(supervisorFailure, "subprocess supervision failed")}`
        : null
  return result({
    exitCode: termination === "exit" && !cleanupRecorded ? closedResult.code : null,
    signal: termination === "signal" && !cleanupRecorded ? closedResult.signal : null,
    termination: cleanupRecorded ? "supervisor-error" : termination,
    timedOut: termination === "timeout",
    abortReason:
      cleanupRecorded && abortReason === null
        ? `${operation}: subprocess cleanup failed`
        : abortReason,
    stdout,
    stderr
  })
}

/** Throws when one real integration invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Converts unknown cleanup failures without reflecting credentials. */
function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Runs one argv-only command and captures complete output. */
async function command(
  ownedDocker: OwnedDockerContext,
  args: readonly string[],
  allowFailure = false
): Promise<CommandResult> {
  const commandArgs = args.slice()
  const executable = commandArgs[0]
  if (executable === undefined) throw new TypeError("command requires an executable")
  const operation = sanitizeArgv(commandArgs).join(" ")
  let result: CommandResult
  try {
    const child = spawn(executable, commandArgs.slice(1), {
      env: inheritedEnvironment(scenarioDockerEnvironment(ownedDocker)),
      stdio: ["ignore", "pipe", "pipe"]
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (value: string) => {
      stdout += value
    })
    child.stderr.on("data", (value: string) => {
      stderr += value
    })
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolvePromise(code ?? -1))
    })
    result = Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode })
  } catch (value) {
    throw new Error(`${operation} failed: ${errorSummary(value)}`)
  }
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      `${operation} failed (${result.exitCode}): ${errorSummary(result.stderr || result.stdout)}`
    )
  }
  return result
}

/** Allocates one unique loopback port outside all other reservations. */
async function allocatePort(used: Set<number>): Promise<number> {
  for (;;) {
    const reservation = createServer()
    reservation.listen({ host: "127.0.0.1", port: 0, exclusive: true })
    await once(reservation, "listening")
    const address = reservation.address()
    const selected = address === null || typeof address === "string" ? undefined : address.port
    await new Promise<void>((resolvePromise, reject) => {
      reservation.close((error) => {
        if (error === undefined) resolvePromise()
        else reject(error)
      })
    })
    if (selected !== undefined && !used.has(selected)) {
      used.add(selected)
      return selected
    }
  }
}

/** Waits without retaining any runtime-specific scheduler. */
function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs))
}

/** Waits for one fresh observable state with bounded polling. */
async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }
  throw new Error(`timed out waiting for ${label}`, { cause: lastError })
}

/** Reads one container's exact pinned image ID. */
async function verifyImage(
  ownedDocker: OwnedDockerContext,
  container: string,
  reference: string
): Promise<string> {
  const actual = (
    await command(ownedDocker, ["docker", "inspect", "--format", "{{.Image}}", container])
  ).stdout
  const expected = (
    await command(ownedDocker, ["docker", "image", "inspect", "--format", "{{.Id}}", reference])
  ).stdout
  assert(actual === expected, `${container} did not use its pinned digest`)
  return actual
}

/** Writes one complete KV v2 configuration document. */
async function writeVaultConfig(address: string, token: string, release: number): Promise<void> {
  const response = await fetch(`${address}/v1/secret/data/applications/platform/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Vault-Token": token },
    body: JSON.stringify({ data: { release, feature: { enabled: release > 1 } } })
  })
  await response.arrayBuffer()
  assert(response.ok, `Vault KV v2 write returned ${response.status}`)
}

/** Returns whether Consul currently exposes one passing service declaration. */
async function consulServiceCount(registry: ReturnType<typeof newConsulRegistry>): Promise<number> {
  return (await registry.getService(background(), echoServiceName)).length
}

/** Stops and joins one Core App. */
async function stopApp(app: App, running: Promise<void>): Promise<void> {
  await app.stop()
  await running
}

interface TelemetryEvidence {
  readonly spanNames: Set<string>
  readonly metricNames: Set<string>
}

/** Records only successful Collector acknowledgements, without reading container logs. */
function observedTraceExporter(
  exporter: OTLPTraceExporter,
  evidence: TelemetryEvidence
): SpanExporter {
  return Object.freeze({
    export(spans: ReadableSpan[], complete: (result: ExportResult) => void): void {
      exporter.export(spans, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          for (const span of spans) evidence.spanNames.add(span.name)
        }
        complete(result)
      })
    },
    forceFlush(): Promise<void> {
      return exporter.forceFlush()
    },
    shutdown(): Promise<void> {
      return exporter.shutdown()
    }
  })
}

/** Records metric names only after the Collector acknowledges the corresponding OTLP batch. */
function observedMetricExporter(
  exporter: OTLPMetricExporter,
  evidence: TelemetryEvidence
): PushMetricExporter {
  return Object.freeze({
    export(metrics: ResourceMetrics, complete: (result: ExportResult) => void): void {
      exporter.export(metrics, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          for (const scope of metrics.scopeMetrics) {
            for (const metric of scope.metrics) evidence.metricNames.add(metric.descriptor.name)
          }
        }
        complete(result)
      })
    },
    forceFlush(): Promise<void> {
      return exporter.forceFlush()
    },
    shutdown(): Promise<void> {
      return exporter.shutdown()
    },
    selectAggregation(instrumentType: InstrumentType) {
      return exporter.selectAggregation(instrumentType)
    },
    selectAggregationTemporality(instrumentType: InstrumentType) {
      return exporter.selectAggregationTemporality(instrumentType)
    }
  })
}

/** Executes the real Consul, Vault, Collector, transport, and operations scenario. */
async function run(): Promise<void> {
  const runId = crypto.randomUUID()
  const consulContainer = `go-like-enterprise-consul-${runId}`
  const vaultContainer = `go-like-enterprise-vault-${runId}`
  const collectorContainer = `go-like-enterprise-otel-${runId}`
  const usedPorts = new Set<number>()
  const consulPort = await allocatePort(usedPorts)
  const vaultPort = await allocatePort(usedPorts)
  const collectorPort = await allocatePort(usedPorts)
  const consulAddress = `http://127.0.0.1:${consulPort}`
  const vaultAddress = `http://127.0.0.1:${vaultPort}`
  const collectorAddress = `http://127.0.0.1:${collectorPort}`
  const vaultToken = `enterprise-root-${runId}`
  const temporary = await mkdtemp(resolve(tmpdir(), "go-like-enterprise-platform-"))
  const logPath = resolve(temporary, "runtime.log")
  const collectorConfig = resolve(Here, "../../../../packages/otel/test/e2e/collector.yaml")
  const cleanupErrors: Error[] = []
  let primary: Error | null = null
  let app: App | null = null
  let appRun: Promise<void> | null = null
  let client: Client | null = null

  const ownedDocker = await ownedDockerContextFromEnvironment(process.env, {
    runner: inheritedBoundaryRunner
  })
  let contextManager: AsyncLocalStorageContextManager | null = null
  try {
    contextManager = new AsyncLocalStorageContextManager().enable()
    context.disable()
    assert(
      context.setGlobalContextManager(contextManager),
      "OpenTelemetry context manager was rejected"
    )
    await createContainer(ownedDocker, [
      "--name",
      consulContainer,
      "--tmpfs",
      "/consul/data:rw,noexec,nosuid,size=64m",
      "--publish",
      `127.0.0.1:${consulPort}:8500`,
      ConsulImage,
      "agent",
      "-dev",
      "-client=0.0.0.0",
      "-log-level=warn"
    ])
    await Promise.all([
      createContainer(
        ownedDocker,
        [
          "--name",
          vaultContainer,
          "--env",
          `VAULT_DEV_ROOT_TOKEN_ID=${vaultToken}`,
          "--publish",
          `127.0.0.1:${vaultPort}:8200`,
          VaultImage,
          "server",
          "-dev",
          "-dev-listen-address=0.0.0.0:8200"
        ],
        { knownSecrets: [vaultToken] }
      ),
      createContainer(ownedDocker, [
        "--name",
        collectorContainer,
        "--publish",
        `127.0.0.1:${collectorPort}:4318`,
        "--volume",
        `${collectorConfig}:/etc/otelcol-contrib/config.yaml:ro`,
        CollectorImage,
        "--config=/etc/otelcol-contrib/config.yaml"
      ])
    ])
    await Promise.all([
      waitUntil("Consul readiness", async () => (await fetch(`${consulAddress}/v1/agent/self`)).ok),
      waitUntil("Vault readiness", async () => (await fetch(`${vaultAddress}/v1/sys/health`)).ok),
      waitUntil("Collector OTLP HTTP listener", async () => {
        const response = await fetch(collectorAddress)
        await response.arrayBuffer()
        return true
      })
    ])

    await Promise.all([
      verifyImage(ownedDocker, consulContainer, ConsulImage),
      verifyImage(ownedDocker, vaultContainer, VaultImage),
      verifyImage(ownedDocker, collectorContainer, CollectorImage)
    ])
    const consulVersion = (
      await command(ownedDocker, ["docker", "exec", consulContainer, "consul", "version"])
    ).stdout
    const vaultVersion = (
      await command(ownedDocker, ["docker", "exec", vaultContainer, "vault", "version"])
    ).stdout
    const collectorVersion = (
      await command(ownedDocker, [
        "docker",
        "exec",
        collectorContainer,
        "/otelcol-contrib",
        "--version"
      ])
    ).stdout
    assert(consulVersion.includes("v2.0.2"), `unexpected Consul version: ${consulVersion}`)
    assert(vaultVersion.includes("v2.0.3"), `unexpected Vault version: ${vaultVersion}`)
    assert(collectorVersion.includes("0.157.0"), `unexpected Collector: ${collectorVersion}`)
    await writeVaultConfig(vaultAddress, vaultToken, 1)

    const destination = pino.destination({ dest: logPath, mkdir: true, sync: false })
    const logger = pino({ base: null, timestamp: false, redact: ["secret", "token"] }, destination)
    const logging = newPinoServer(logger, destination)
    logger.info({ component: "enterprise", secret: vaultToken }, "runtime starting")

    const resource = resourceFromAttributes({
      "service.name": "go-like-enterprise-platform",
      "deployment.environment.name": "e2e"
    })
    const telemetryEvidence: TelemetryEvidence = {
      spanNames: new Set<string>(),
      metricNames: new Set<string>()
    }
    const tracerProvider = new TracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: observedTraceExporter(
            new OTLPTraceExporter({
              url: `${collectorAddress}/v1/traces`,
              timeoutMillis: 2_000,
              keepAlive: false
            }),
            telemetryEvidence
          ),
          scheduledDelayMillis: 100,
          exportTimeoutMillis: 2_000,
          maxQueueSize: 64,
          maxExportBatchSize: 32
        })
      ]
    })
    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: observedMetricExporter(
            new OTLPMetricExporter({
              url: `${collectorAddress}/v1/metrics`,
              timeoutMillis: 2_000,
              keepAlive: false
            }),
            telemetryEvidence
          ),
          exportIntervalMillis: 500,
          exportTimeoutMillis: 500
        })
      ]
    })
    const telemetry = newOtelServer({ tracerProvider, meterProvider })
    const tracer = tracerProvider.getTracer("enterprise-platform")
    const otelCalls = meterProvider
      .getMeter("enterprise-platform")
      .createCounter("enterprise.calls")
    const propagator = new W3CTraceContextPropagator()

    const runtimeConfig = newConfig(
      source(
        vaultSource({
          fetch,
          address: vaultAddress,
          mount: "secret",
          path: "applications/platform/config",
          token: vaultToken,
          pollIntervalMs: 50,
          retryInitialMs: 25,
          retryMaximumMs: 100
        })
      ),
      schema(runtimeConfigSchema)
    )
    const runtimeState = newPlatformRuntimeState(vaultAddress, vaultToken, `platform-${runId}`)
    const registry = newConsulRegistry({
      fetch,
      address: consulAddress,
      waitMs: 1_000,
      minimumQueryIntervalMs: 10,
      retryInitialMs: 25,
      retryMaximumMs: 100,
      deregisterCriticalServiceAfterMs: 60_000
    })
    let handlerCalls = 0
    const prometheus = new Registry()
    const requests = new Counter({
      name: "enterprise_requests_total",
      help: "Enterprise unary requests by bounded result.",
      labelNames: ["result"],
      registers: [prometheus]
    })
    const echoServer = newServer(
      serverTransport(newNodeHTTPTransport()),
      address("127.0.0.1:0"),
      serviceHandler(
        echoServiceName,
        echoEndpointName,
        newEchoHandler(runtimeConfig, function recordCall(): void {
          handlerCalls += 1
          requests.inc({ result: "ok" })
          otelCalls.add(1, { result: "ok" })
        })
      ),
      middleware(traceUnaryMiddleware(tracer, propagator))
    )
    const serviceEndpoint = await echoServer.endpoint(background())
    const activeClient = traceClient(
      newClient(
        withDiscovery(registry),
        withSelector(newRoundRobinSelector()),
        withTransport(newHTTPTransport())
      ),
      tracer,
      propagator
    )
    client = activeClient
    const probes = newProbeRegistry()
    registerRuntimeProbes(probes, () => runtimeConfig.value("release").load() !== null)
    const managementHandler = newManagementHandler(
      createHealthHandler(probes),
      createPrometheusHandler(prometheus),
      activeClient
    )
    const managementServer = newNodeServer(managementHandler, hostname("127.0.0.1"), port(0))
    const managementAddress = await managementServer.endpoint(background())

    app = newApp(
      id(`platform-${runId}`),
      name(echoServiceName),
      version("v1"),
      metadata({ application: "enterprise-platform-runtime", environment: "e2e" }),
      endpoint(serviceEndpoint),
      registrar(registry),
      stopTimeout(10_000),
      beforeStart(async function loadRuntime(ctx): Promise<void> {
        await runtimeConfig.load(ctx)
        await runtimeState.publish(ctx)
      }),
      server(logging, telemetry, echoServer, managementServer),
      afterStop(async function closeRuntime(ctx): Promise<void> {
        const cleanup = withoutCancel(ctx)
        try {
          await runtimeState.remove(cleanup)
        } finally {
          await runtimeConfig.close(cleanup)
        }
      })
    )
    appRun = app.run()
    void appRun.catch(() => {})
    await Promise.all([
      waitUntil("Vault revision 1", () => runtimeConfig.value("release").load() === 1),
      waitUntil("Consul passing service", async () => (await consulServiceCount(registry)) === 1)
    ])

    const liveStatus = (await fetch(new URL("/livez", managementAddress))).status
    const readyStatus = (await fetch(new URL("/readyz", managementAddress))).status
    assert(liveStatus === 200 && readyStatus === 200, "management health was not ready")
    const firstResponse = await fetch(new URL("/call", managementAddress))
    const firstPayload: unknown = await firstResponse.json()
    assert(
      firstResponse.ok &&
        typeof firstPayload === "object" &&
        firstPayload !== null &&
        "response" in firstPayload &&
        firstPayload.response === "pong:1",
      "Consul-discovered call did not return Vault release 1"
    )
    const metricsBody = await (await fetch(new URL("/metrics", managementAddress))).text()
    assert(metricsBody.includes("enterprise_requests_total"), "Prometheus metric was absent")

    await writeVaultConfig(vaultAddress, vaultToken, 2)
    await waitUntil("Vault revision 2", () => runtimeConfig.value("release").load() === 2)
    const secondResponse = await fetch(new URL("/call", managementAddress))
    const secondPayload: unknown = await secondResponse.json()
    assert(
      secondResponse.ok &&
        typeof secondPayload === "object" &&
        secondPayload !== null &&
        "response" in secondPayload &&
        secondPayload.response === "pong:2",
      "Consul-discovered call did not use Vault release 2"
    )
    assert(handlerCalls === 2, `business handler ran ${handlerCalls} times instead of twice`)

    await waitUntil("Collector trace and metric acknowledgements", () =>
      Boolean(
        telemetryEvidence.spanNames.has(`go-like.client ${echoServiceName}/${echoEndpointName}`) &&
        telemetryEvidence.spanNames.has(`go-like.server ${echoServiceName}/${echoEndpointName}`) &&
        telemetryEvidence.metricNames.has("enterprise.calls")
      )
    )

    await stopApp(app, appRun)
    app = null
    appRun = null
    await waitUntil(
      "Consul deregistration readback",
      async () => (await consulServiceCount(registry)) === 0
    )
    const logText = await readFile(logPath, "utf8")
    assert(logText.includes('"secret":"[Redacted]"'), "Pino did not redact the bootstrap secret")
    assert(!logText.includes(vaultToken), "bootstrap token leaked into structured logs")

    const programPort = await allocatePort(usedPorts)
    const programKnownSecrets = Object.freeze([vaultToken])
    const programStdoutRedactor = createStreamingRedactor({ knownSecrets: programKnownSecrets })
    const programStderrRedactor = createStreamingRedactor({ knownSecrets: programKnownSecrets })
    const program = spawn("bun", ["run", "start:prepared"], {
      cwd: resolve(Here, "../.."),
      env: {
        ...scenarioDockerEnvironment(ownedDocker),
        HOST: "127.0.0.1",
        PORT: String(programPort),
        CONSUL_HTTP_ADDR: consulAddress,
        VAULT_ADDR: vaultAddress,
        VAULT_TOKEN: vaultToken,
        OTEL_EXPORTER_OTLP_ENDPOINT: collectorAddress,
        LOG_PATH: resolve(temporary, "entry.log")
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
    assert(program.pid !== undefined, "start:prepared process has no pid")
    const programPid = program.pid
    program.stdout.setEncoding("utf8")
    program.stderr.setEncoding("utf8")
    let programOutput = ""
    let programError = ""
    program.stdout.on("data", (value: string) => {
      programOutput = boundedTail(
        `${programOutput}${programStdoutRedactor.write(value)}`,
        64 * 1024
      )
    })
    program.stderr.on("data", (value: string) => {
      programError = boundedTail(`${programError}${programStderrRedactor.write(value)}`, 64 * 1024)
    })
    const programExited = new Promise<number>((resolvePromise, reject) => {
      program.once("error", reject)
      program.once("close", (code) => resolvePromise(code ?? -1))
    })
    let programJoined = false
    let forced = false
    let terminationTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      await waitUntil(
        "start:prepared readiness",
        () =>
          programOutput.includes('GO_LIKE_EXAMPLE_READY={"example":"enterprise-platform-runtime"'),
        30_000
      )
      let programPayload: unknown = null
      await waitUntil("start:prepared internal call", async () => {
        const response = await fetch(`http://127.0.0.1:${programPort}/call`)
        programPayload = await response.json()
        return (
          response.ok &&
          programPayload !== null &&
          typeof programPayload === "object" &&
          "response" in programPayload &&
          programPayload.response === "pong:2"
        )
      })
      process.kill(-programPid, "SIGTERM")
      terminationTimeout = setTimeout(() => {
        forced = true
        try {
          process.kill(-programPid, "SIGKILL")
        } catch {
          // The process group can finish between the timeout and signal delivery.
        }
      }, 10_000)
      const exitCode = await programExited
      programJoined = true
      clearTimeout(terminationTimeout)
      programOutput += programStdoutRedactor.end()
      programError += programStderrRedactor.end()
      if (forced) throw new Error("start:prepared did not stop after SIGTERM")
      assert(
        exitCode === 0 || exitCode === 143,
        `start:prepared exited ${exitCode}: ${errorSummary(programError, {
          knownSecrets: programKnownSecrets
        })}`
      )
    } finally {
      if (terminationTimeout !== null) clearTimeout(terminationTimeout)
      if (!programJoined) {
        try {
          process.kill(-programPid, "SIGKILL")
        } catch {
          // The process group already exited.
        }
        await programExited.catch(() => {})
        programOutput += programStdoutRedactor.end()
        programError += programStderrRedactor.end()
      }
    }
    await waitUntil(
      "start:prepared Consul deregistration",
      async () => (await consulServiceCount(registry)) === 0
    )
    const released = createServer()
    released.listen({ host: "127.0.0.1", port: programPort, exclusive: true })
    await once(released, "listening")
    await new Promise<void>((resolvePromise, reject) => {
      released.close((error) => {
        if (error === undefined) resolvePromise()
        else reject(error)
      })
    })
  } catch (value) {
    primary = asError(value, "enterprise E2E failed")
  } finally {
    if (client !== null) {
      try {
        await client.close(background())
      } catch (value) {
        cleanupErrors.push(asError(value, "Client cleanup failed"))
      }
    }
    if (app !== null && appRun !== null) {
      try {
        await stopApp(app, appRun)
      } catch (value) {
        cleanupErrors.push(asError(value, "Core App cleanup failed"))
      }
    }
    context.disable()
    contextManager?.disable()
    try {
      await closeOwnedDockerContext(ownedDocker)
    } catch (value) {
      cleanupErrors.push(asError(value, "Owned Docker context cleanup failed"))
    }
    try {
      await rm(temporary, { recursive: true, force: true })
    } catch (value) {
      cleanupErrors.push(asError(value, "temporary directory cleanup failed"))
    }
  }

  if (primary !== null || cleanupErrors.length > 0) {
    const failures = primary === null ? cleanupErrors : [primary, ...cleanupErrors]
    throw failures.length === 1
      ? failures[0]!
      : new AggregateError(failures, "enterprise E2E and cleanup failed")
  }
}

await run()

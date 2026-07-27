import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { newClient, withDiscovery, withSelector, withTransport, type Client } from "@likego/client"
import { newConfig, schema, source } from "@likego/config"
import { vaultSource } from "@likego/config-vault"
import { background, withoutCancel } from "@likego/context"
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
} from "@likego/core"
import { newProbeRegistry } from "@likego/health"
import { newOtelServer, traceClient, traceUnaryMiddleware } from "@likego/otel"
import { newPinoServer } from "@likego/pino"
import { createPrometheusHandler } from "@likego/prometheus"
import { newRoundRobinSelector } from "@likego/registry"
import { newConsulRegistry } from "@likego/registry-consul"
import {
  address,
  handler as serviceHandler,
  middleware,
  newServer,
  transport as serverTransport
} from "@likego/server"
import { newHTTPTransport } from "@likego/transport-http"
import { newNodeHTTPTransport } from "@likego/transport-http/node"
import { createHealthHandler } from "@likego/web/health"
import { hostname, newNodeServer, port } from "@likego/web/node"
import { context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"
import pino from "pino"
import { Counter, Registry } from "prom-client"

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

/** Throws when one real integration invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Converts unknown cleanup failures without reflecting credentials. */
function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Runs one argv-only command and captures complete output. */
async function command(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  const executable = args[0]
  if (executable === undefined) throw new TypeError("command requires an executable")
  const child = spawn(executable, args.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
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
  const result = Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode })
  if (!allowFailure && exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (${exitCode}): ${result.stderr}`)
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
async function verifyImage(container: string, reference: string): Promise<string> {
  const actual = (await command(["docker", "inspect", "--format", "{{.Image}}", container])).stdout
  const expected = (await command(["docker", "image", "inspect", "--format", "{{.Id}}", reference]))
    .stdout
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

/** Executes the real Consul, Vault, Collector, transport, and operations scenario. */
async function run(): Promise<Record<string, unknown>> {
  const runId = crypto.randomUUID()
  const ownerLabel = `io.likego.e2e.owner=enterprise-platform-${runId}`
  const consulContainer = `likego-enterprise-consul-${runId}`
  const vaultContainer = `likego-enterprise-vault-${runId}`
  const collectorContainer = `likego-enterprise-otel-${runId}`
  const containers = [consulContainer, vaultContainer, collectorContainer]
  const usedPorts = new Set<number>()
  const consulPort = await allocatePort(usedPorts)
  const vaultPort = await allocatePort(usedPorts)
  const collectorPort = await allocatePort(usedPorts)
  const consulAddress = `http://127.0.0.1:${consulPort}`
  const vaultAddress = `http://127.0.0.1:${vaultPort}`
  const collectorAddress = `http://127.0.0.1:${collectorPort}`
  const vaultToken = `enterprise-root-${runId}`
  const temporary = await mkdtemp(resolve(tmpdir(), "likego-enterprise-platform-"))
  const logPath = resolve(temporary, "runtime.log")
  const collectorConfig = resolve(Here, "../../../../packages/otel/test/e2e/collector.yaml")
  const cleanupErrors: Error[] = []
  let primary: Error | null = null
  let app: App | null = null
  let appRun: Promise<void> | null = null
  let client: Client | null = null
  const contextManager = new AsyncLocalStorageContextManager().enable()
  let output: Record<string, unknown> = {}

  try {
    context.disable()
    assert(
      context.setGlobalContextManager(contextManager),
      "OpenTelemetry context manager was rejected"
    )
    await Promise.all([
      command([
        "docker",
        "run",
        "--detach",
        "--name",
        consulContainer,
        "--label",
        ownerLabel,
        "--tmpfs",
        "/consul/data:rw,noexec,nosuid,size=64m",
        "--publish",
        `127.0.0.1:${consulPort}:8500`,
        ConsulImage,
        "agent",
        "-dev",
        "-client=0.0.0.0",
        "-log-level=warn"
      ]),
      command([
        "docker",
        "run",
        "--detach",
        "--name",
        vaultContainer,
        "--label",
        ownerLabel,
        "--env",
        `VAULT_DEV_ROOT_TOKEN_ID=${vaultToken}`,
        "--publish",
        `127.0.0.1:${vaultPort}:8200`,
        VaultImage,
        "server",
        "-dev",
        "-dev-listen-address=0.0.0.0:8200"
      ]),
      command([
        "docker",
        "run",
        "--detach",
        "--name",
        collectorContainer,
        "--label",
        ownerLabel,
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
      waitUntil("Collector readiness", async () => {
        const logs = await command(["docker", "logs", collectorContainer], true)
        return `${logs.stdout}\n${logs.stderr}`.includes("Everything is ready")
      })
    ])

    const imageIds = await Promise.all([
      verifyImage(consulContainer, ConsulImage),
      verifyImage(vaultContainer, VaultImage),
      verifyImage(collectorContainer, CollectorImage)
    ])
    const consulVersion = (await command(["docker", "exec", consulContainer, "consul", "version"]))
      .stdout
    const vaultVersion = (await command(["docker", "exec", vaultContainer, "vault", "version"]))
      .stdout
    const collectorVersion = (
      await command(["docker", "exec", collectorContainer, "/otelcol-contrib", "--version"])
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
      "service.name": "likego-enterprise-platform",
      "deployment.environment.name": "e2e"
    })
    const tracerProvider = new TracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({
            url: `${collectorAddress}/v1/traces`,
            timeoutMillis: 2_000,
            keepAlive: false
          }),
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
          exporter: new OTLPMetricExporter({
            url: `${collectorAddress}/v1/metrics`,
            timeoutMillis: 2_000,
            keepAlive: false
          }),
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

    await waitUntil("Collector trace and metric", async () => {
      const logs = await command(["docker", "logs", collectorContainer], true)
      const combined = `${logs.stdout}\n${logs.stderr}`
      return (
        combined.includes(`likego.client ${echoServiceName}/${echoEndpointName}`) &&
        combined.includes(`likego.server ${echoServiceName}/${echoEndpointName}`) &&
        combined.includes("enterprise.calls")
      )
    })

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
    const program = spawn("bun", ["run", "start:prepared"], {
      cwd: resolve(Here, "../.."),
      env: {
        ...process.env,
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
      programOutput += value
    })
    program.stderr.on("data", (value: string) => {
      programError += value
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
          programOutput.includes('LIKEGO_EXAMPLE_READY={"example":"enterprise-platform-runtime"'),
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
      if (forced) throw new Error("start:prepared did not stop after SIGTERM")
      assert(
        exitCode === 0 || exitCode === 143,
        `start:prepared exited ${exitCode}: ${programError.trim()}`
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

    output = Object.freeze({
      versions: Object.freeze({
        consul: "2.0.2",
        vault: "2.0.3",
        collector: "0.157.0"
      }),
      imageIds: Object.freeze(imageIds),
      vaultRelease: runtimeConfig.value("release").load(),
      vaultStoreRuntimeState: true,
      responses: Object.freeze(["pong:1", "pong:2"]),
      handlerCalls,
      health: Object.freeze({ live: liveStatus, ready: readyStatus }),
      metricsObserved: true,
      collectorTraceObserved: true,
      collectorMetricObserved: true,
      consulRegistrationsAfterStop: 0,
      pinoRedacted: true,
      startPreparedEntrypoint: true
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
    contextManager.disable()
    for (const container of containers) {
      const removed = await command(["docker", "rm", "--force", "--volumes", container], true)
      if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) {
        cleanupErrors.push(new Error(`${container} cleanup failed`))
      }
    }
    const residual = await command([
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${ownerLabel}`
    ])
    if (residual.stdout !== "") cleanupErrors.push(new Error("owner-labeled containers remain"))
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
  return Object.freeze({ ...output, residualContainers: 0 })
}

try {
  const evidence = await run()
  process.stdout.write(
    `LIKEGO_ENTERPRISE_PLATFORM_E2E_RESULT=${JSON.stringify({ valid: true, evidence })}\n`
  )
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `LIKEGO_ENTERPRISE_PLATFORM_E2E_RESULT=${JSON.stringify({ valid: false, error: message })}\n`
  )
  throw error
}

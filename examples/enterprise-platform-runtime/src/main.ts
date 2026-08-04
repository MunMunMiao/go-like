import process from "node:process"

import { newClient, withDiscovery, withSelector, withTransport } from "@go-like/client"
import { newConfig, schema, source } from "@go-like/config"
import { vaultSource } from "@go-like/config-vault"
import { background, withoutCancel } from "@go-like/context"
import {
  afterStart,
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
  version
} from "@go-like/core"
import { signal } from "@go-like/core/node"
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
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"
import pino from "pino"
import { Counter, Registry } from "prom-client"

import { runtimeConfigSchema } from "./config"
import { echoEndpointName, echoServiceName, newEchoHandler } from "./echo"
import { newManagementHandler } from "./management"
import { registerRuntimeProbes } from "./probes"
import { newPlatformRuntimeState } from "./runtime-state"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}
const consulAddress = process.env.CONSUL_HTTP_ADDR ?? "http://127.0.0.1:58500"
const vaultAddress = process.env.VAULT_ADDR ?? "http://127.0.0.1:58200"
const vaultToken = process.env.VAULT_TOKEN ?? "go-like-enterprise-dev"
if (vaultToken === "") {
  throw new TypeError("VAULT_TOKEN is required")
}
const collectorAddress = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:54318"
const logPath = process.env.LOG_PATH ?? ".artifacts/runtime.log"
const instanceId = `platform-${crypto.randomUUID()}`

const contextManager = new AsyncLocalStorageContextManager().enable()
if (!context.setGlobalContextManager(contextManager)) {
  contextManager.disable()
  throw new Error("OpenTelemetry context manager is already installed")
}

try {
  const destination = pino.destination({ dest: logPath, mkdir: true, sync: false })
  const logger = pino({ base: null, redact: ["secret", "token"] }, destination)
  const logging = newPinoServer(logger, destination)
  const resource = resourceFromAttributes({
    "service.name": "go-like-enterprise-platform",
    "deployment.environment.name": "local"
  })
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: `${collectorAddress}/v1/traces`,
          timeoutMillis: 1_000,
          keepAlive: false
        }),
        scheduledDelayMillis: 100,
        exportTimeoutMillis: 1_000,
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
          timeoutMillis: 1_000,
          keepAlive: false
        }),
        exportIntervalMillis: 500,
        exportTimeoutMillis: 500
      })
    ]
  })
  const telemetry = newOtelServer({ tracerProvider, meterProvider })
  const tracer = tracerProvider.getTracer("enterprise-platform")
  const callCounter = meterProvider
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
        pollIntervalMs: 1_000,
        retryInitialMs: 50,
        retryMaximumMs: 500
      })
    ),
    schema(runtimeConfigSchema)
  )
  const runtimeState = newPlatformRuntimeState(vaultAddress, vaultToken, instanceId)
  const registry = newConsulRegistry({
    fetch,
    address: consulAddress,
    waitMs: 1_000,
    minimumQueryIntervalMs: 20,
    retryInitialMs: 50,
    retryMaximumMs: 500,
    deregisterCriticalServiceAfterMs: 60_000
  })
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
        requests.inc({ result: "ok" })
        callCounter.add(1, { result: "ok" })
      })
    ),
    middleware(traceUnaryMiddleware(tracer, propagator))
  )
  // Only the unary service endpoint belongs in discovery; the management server stays private.
  const serviceEndpoint = await echoServer.endpoint(background())
  const traced = traceClient(
    newClient(
      withDiscovery(registry),
      withSelector(newRoundRobinSelector()),
      withTransport(newHTTPTransport())
    ),
    tracer,
    propagator
  )
  const probes = newProbeRegistry()
  registerRuntimeProbes(probes, () => runtimeConfig.value("release").load() !== null)
  const health = createHealthHandler(probes)
  const metrics = createPrometheusHandler(prometheus)
  const management = newManagementHandler(health, metrics, traced, function logCallError(error) {
    logger.error({ error }, "internal call failed")
  })
  const origin = `http://${host}:${portNumber}`
  const managementServer = newNodeServer(management, hostname(host), port(portNumber))
  const app = newApp(
    signal(),
    id(instanceId),
    name(echoServiceName),
    version("v1"),
    metadata({ application: "enterprise-platform-runtime", environment: "local" }),
    endpoint(serviceEndpoint),
    registrar(registry),
    stopTimeout(5_000),
    beforeStart(async function loadRuntime(ctx): Promise<void> {
      await runtimeConfig.load(ctx)
      await runtimeState.publish(ctx)
    }),
    server(logging, telemetry, echoServer, managementServer),
    afterStart(async function announceReady(ctx): Promise<void> {
      await managementServer.endpoint(ctx)
      logger.info({ service: echoServiceName }, "application started")
      process.stdout.write(
        `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "enterprise-platform-runtime", origin })}\n`
      )
    }),
    afterStop(async function closeRuntime(ctx): Promise<void> {
      const cleanup = withoutCancel(ctx)
      try {
        await runtimeState.remove(cleanup)
      } finally {
        await runtimeConfig.close(cleanup)
      }
    })
  )
  try {
    await app.run()
  } finally {
    await traced.close(background())
  }
} finally {
  context.disable()
  contextManager.disable()
}

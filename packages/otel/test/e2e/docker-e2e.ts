import { resolve } from "node:path"

import { background } from "@go-like/context"
import { otelShutdownTimeout, newOtelServer } from "@go-like/otel"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter
} from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, TracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace"

const CollectorImage =
  "otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6"
const CollectorVersion = "0.157.0"
const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid GO_LIKE_E2E_OWNER")
const DockerOwnerLabel = `io.go-like.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly exitCode: number
  readonly output: string
}

async function command(arguments_: readonly string[]): Promise<CommandResult> {
  const process = Bun.spawn(Array.from(arguments_), { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])
  return { exitCode, output: `${stdout}${stderr}` }
}

async function commandOk(arguments_: readonly string[]): Promise<string> {
  const result = await command(arguments_)
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${arguments_.join(" ")}):\n${result.output}`)
  }
  return result.output
}

async function waitUntil(
  operation: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await operation())) {
    if (Date.now() >= deadline)
      throw new Error(`${label} did not become observable before deadline`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}

async function collectorLogs(container: string): Promise<string> {
  return (await command(["docker", "logs", container])).output
}

function occurrences(value: string, marker: string): number {
  return value.split(marker).length - 1
}

/** Adds one cleanup failure once without replacing the primary scenario failure. */
function addFailure(failures: unknown[], failure: unknown): void {
  if (!failures.includes(failure)) failures.push(failure)
}

/** Observes official trace export results without changing exporter configuration. */
function observedTraceExporter(exporter: OTLPTraceExporter, failures: Error[]): SpanExporter {
  return Object.freeze<SpanExporter>({
    export(spans, complete): void {
      exporter.export(spans, (result) => {
        if (result.error instanceof Error) failures.push(result.error)
        complete(result)
      })
    },
    shutdown(): Promise<void> {
      return exporter.shutdown()
    }
  })
}

/** Observes official metric export results without changing exporter configuration. */
function observedMetricExporter(
  exporter: OTLPMetricExporter,
  failures: Error[]
): PushMetricExporter {
  return Object.freeze<PushMetricExporter>({
    export(metrics, complete): void {
      exporter.export(metrics, (result) => {
        if (result.error instanceof Error) failures.push(result.error)
        complete(result)
      })
    },
    forceFlush(): Promise<void> {
      return exporter.forceFlush()
    },
    shutdown(): Promise<void> {
      return exporter.shutdown()
    },
    selectAggregation(instrumentType) {
      return exporter.selectAggregation(instrumentType)
    },
    selectAggregationTemporality(instrumentType) {
      return exporter.selectAggregationTemporality(instrumentType)
    }
  })
}

const container = `go-like-otel-${crypto.randomUUID()}`
const config = resolve(import.meta.dir, "collector.yaml")
const portReservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(): Response {
    return new Response(null, { status: 503 })
  }
})
const port = portReservation.port
await portReservation.stop(true)
let runtimeServer: ReturnType<typeof newOtelServer> | null = null
let runtimeRunning: Promise<void> | null = null
let collectorExists = false
let residualContainers = -1
let shutdownSpanCount = -1
let evidenceReady = false
let primaryFailure: unknown | null = null
const cleanupFailures: unknown[] = []
const traceExportFailures: Error[] = []
const metricExportFailures: Error[] = []
try {
  await commandOk([
    "docker",
    "run",
    "--detach",
    "--name",
    container,
    "--label",
    DockerOwnerLabel,
    "--publish",
    `127.0.0.1:${port}:4318`,
    "--volume",
    `${config}:/etc/otelcol-contrib/config.yaml:ro`,
    CollectorImage,
    "--config=/etc/otelcol-contrib/config.yaml"
  ])
  collectorExists = true
  await waitUntil(
    async () => (await collectorLogs(container)).includes("Everything is ready"),
    "collector readiness"
  )
  const versionOutput = await commandOk([
    "docker",
    "exec",
    container,
    "/otelcol-contrib",
    "--version"
  ])
  const versionMatch = /version\s+(\d+\.\d+\.\d+)/.exec(versionOutput)
  if (versionMatch?.[1] !== CollectorVersion) {
    throw new Error(`unexpected Collector binary version: ${versionOutput}`)
  }
  const endpoint = `http://127.0.0.1:${port}`
  const resource = resourceFromAttributes({
    "service.name": "go-like-otel-docker",
    "deployment.environment.name": "e2e"
  })
  const traceExporter = observedTraceExporter(
    new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      timeoutMillis: 500,
      keepAlive: false
    }),
    traceExportFailures
  )
  const metricExporter = observedMetricExporter(
    new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
      timeoutMillis: 500,
      keepAlive: false
    }),
    metricExportFailures
  )
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: traceExporter,
        exportTimeoutMillis: 500,
        scheduledDelayMillis: 100,
        maxQueueSize: 64,
        maxExportBatchSize: 32
      })
    ]
  })
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportTimeoutMillis: 500,
        exportIntervalMillis: 500
      })
    ]
  })
  runtimeServer = newOtelServer({ tracerProvider, meterProvider }, otelShutdownTimeout(5_000))
  runtimeRunning = runtimeServer.start(background())
  await Promise.resolve()
  const tracer = tracerProvider.getTracer("docker-e2e")
  const meter = meterProvider.getMeter("docker-e2e")

  tracer.startSpan("initial-span").end()
  meter.createCounter("initial.counter").add(1)
  await waitUntil(async () => {
    const logs = await collectorLogs(container)
    return logs.includes("initial-span") && logs.includes("initial.counter")
  }, "initial traces and metrics")

  await commandOk(["docker", "stop", "--time", "1", container])
  let businessProgress = 0
  tracer.startSpan("outage-span").end()
  businessProgress += 1
  meter.createCounter("outage.counter").add(1)
  businessProgress += 1
  await waitUntil(
    async () => traceExportFailures.length > 0 && metricExportFailures.length > 0,
    "native outage observations"
  )
  if (businessProgress !== 2)
    throw new Error("business work did not continue during collector outage")

  const readyBeforeRestart = occurrences(await collectorLogs(container), "Everything is ready")
  await commandOk(["docker", "start", container])
  await waitUntil(
    async () =>
      occurrences(await collectorLogs(container), "Everything is ready") > readyBeforeRestart,
    "collector restart"
  )
  tracer.startSpan("recovered-span").end()
  meter.createCounter("recovered.counter").add(1)
  await waitUntil(
    async () => (await collectorLogs(container)).includes("recovered-span"),
    "post-recovery traces"
  )
  await waitUntil(
    async () => (await collectorLogs(container)).includes("recovered.counter"),
    "post-recovery metrics"
  )

  tracer.startSpan("shutdown-flush-span").end()
  meter.createCounter("shutdown.flush.counter").add(1)
  await runtimeServer.stop(background())
  await runtimeRunning
  runtimeServer = null
  runtimeRunning = null
  const finalLogs = await collectorLogs(container)
  if (!finalLogs.includes("shutdown-flush-span") || !finalLogs.includes("shutdown.flush.counter")) {
    throw new Error("provider shutdown did not naturally flush both signals")
  }
  shutdownSpanCount = occurrences(finalLogs, "shutdown-flush-span")
  if (shutdownSpanCount !== 1) {
    throw new Error(`shutdown trace was exported ${shutdownSpanCount} times`)
  }
  if (!finalLogs.includes("go-like-otel-docker")) {
    throw new Error("collector did not receive the application-configured service Resource")
  }

  evidenceReady = true
} catch (error) {
  primaryFailure = error
} finally {
  if (runtimeServer !== null && runtimeRunning !== null) {
    try {
      await runtimeServer.stop(background())
    } catch (error) {
      addFailure(cleanupFailures, error)
    }
    try {
      await runtimeRunning
    } catch (error) {
      addFailure(cleanupFailures, error)
    }
  }
  if (collectorExists) {
    const cleanup = await command(["docker", "rm", "--force", container])
    if (cleanup.exitCode !== 0) {
      addFailure(cleanupFailures, new Error(`collector cleanup failed: ${cleanup.output}`))
    }
  }
  const residual = await command([
    "docker",
    "ps",
    "--all",
    "--filter",
    `name=${container}`,
    "--format",
    "{{.Names}}"
  ])
  if (residual.exitCode !== 0) {
    addFailure(cleanupFailures, new Error(`collector residual query failed: ${residual.output}`))
  } else {
    residualContainers = residual.output
      .split("\n")
      .filter((name) => name.trim() === container).length
    if (residualContainers !== 0) {
      addFailure(cleanupFailures, new Error(`residual collector container remains: ${container}`))
    }
  }
}

if (primaryFailure !== null) {
  if (cleanupFailures.length === 0) throw primaryFailure
  throw new AggregateError(
    [primaryFailure, ...cleanupFailures],
    "OTel integration and cleanup failed"
  )
}
if (cleanupFailures.length === 1) throw cleanupFailures[0]
if (cleanupFailures.length > 1)
  throw new AggregateError(cleanupFailures, "OTel integration cleanup failed")
if (!evidenceReady) throw new Error("OTel integration completed without scenario evidence")

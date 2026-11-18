import { resolve } from "node:path"

import { background } from "@go-like/core/context"
import { withRemoteSpanContext } from "@go-like/core/telemetry/provider"
import { newOtelPropagator, newOtelTracerProvider, type OtelTracerProvider } from "@go-like/otel"
import { propagation } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"

/**
 * Collector export of a plug span, plus the two propagator configurations from D37.
 * `@opentelemetry/instrumentation-undici` is not a dependency, so this does not open a second
 * HTTP client. Config A leaves the global propagator unset. Config B registers W3C globally.
 * In both cases the plug starts and `inject` writes one `traceparent`.
 */
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

function addFailure(failures: unknown[], failure: unknown): void {
  if (!failures.includes(failure)) failures.push(failure)
}

function traceparentCount(carrier: { readonly values: Readonly<Record<string, string>> }): number {
  return Object.keys(carrier.values).filter((key) => key.toLowerCase() === "traceparent").length
}

function injectOnce(spanContext: {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: number
  readonly traceState: string
  readonly isRemote: boolean
}): number {
  const carrier = {
    values: {} as Record<string, string>,
    set(key: string, value: string) {
      this.values[key] = value
    }
  }
  newOtelPropagator(new W3CTraceContextPropagator()).inject(
    withRemoteSpanContext(background(), spanContext),
    carrier
  )
  return traceparentCount(carrier)
}

const container = `go-like-otel-bridge-${crypto.randomUUID()}`
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
let traces: OtelTracerProvider | null = null
let running: Promise<void> | null = null
let collectorExists = false
let evidenceReady = false
let primaryFailure: unknown | null = null
const cleanupFailures: unknown[] = []

try {
  propagation.disable()
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
    async () =>
      (await command(["docker", "logs", container])).output.includes("Everything is ready"),
    "collector readiness"
  )
  const versionOutput = await commandOk([
    "docker",
    "exec",
    container,
    "/otelcol-contrib",
    "--version"
  ])
  if (!versionOutput.includes(CollectorVersion)) {
    throw new Error(`unexpected Collector binary version: ${versionOutput}`)
  }
  const tracerProvider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "go-like-otel-bridge" }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: `http://127.0.0.1:${port}/v1/traces`,
          timeoutMillis: 2_000,
          keepAlive: false
        }),
        scheduledDelayMillis: 100,
        exportTimeoutMillis: 2_000
      })
    ]
  })
  traces = newOtelTracerProvider(tracerProvider)
  running = traces.lifecycle.start(background())
  await Promise.resolve()
  const span = traces.startSpan(background(), { name: "bridge" }, "plug-only", {
    kind: "client",
    attributes: {},
    links: [],
    root: true
  })
  if (injectOnce(span.spanContext()) !== 1)
    throw new Error("config A inject did not write one traceparent")
  span.end()
  await traces.lifecycle.stop(background())
  await running
  traces = null
  running = null
  await waitUntil(
    async () => (await command(["docker", "logs", container])).output.includes("plug-only"),
    "plug-only span"
  )

  if (!propagation.setGlobalPropagator(new W3CTraceContextPropagator())) {
    throw new Error("global W3C propagator was not installed")
  }
  const secondProvider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "go-like-otel-bridge" }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: `http://127.0.0.1:${port}/v1/traces`,
          timeoutMillis: 2_000,
          keepAlive: false
        }),
        scheduledDelayMillis: 100,
        exportTimeoutMillis: 2_000
      })
    ]
  })
  traces = newOtelTracerProvider(secondProvider)
  running = traces.lifecycle.start(background())
  await Promise.resolve()
  const second = traces.startSpan(background(), { name: "bridge" }, "global-present", {
    kind: "client",
    attributes: {},
    links: [],
    root: true
  })
  if (injectOnce(second.spanContext()) !== 1)
    throw new Error("config B inject did not write one traceparent")
  second.end()
  await traces.lifecycle.stop(background())
  await running
  traces = null
  running = null
  await waitUntil(
    async () => (await command(["docker", "logs", container])).output.includes("global-present"),
    "global-present span"
  )
  evidenceReady = true
} catch (error) {
  primaryFailure = error
} finally {
  propagation.disable()
  if (traces !== null && running !== null) {
    try {
      await traces.lifecycle.stop(background())
    } catch (error) {
      addFailure(cleanupFailures, error)
    }
    try {
      await running
    } catch (error) {
      addFailure(cleanupFailures, error)
    }
  }
  if (collectorExists) {
    const cleanup = await command(["docker", "rm", "--force", container])
    if (cleanup.exitCode !== 0)
      addFailure(cleanupFailures, new Error(`collector cleanup failed: ${cleanup.output}`))
  }
}

if (primaryFailure !== null) {
  if (cleanupFailures.length === 0) throw primaryFailure
  throw new AggregateError([primaryFailure, ...cleanupFailures], "otel bridge integration failed")
}
if (cleanupFailures.length === 1) throw cleanupFailures[0]
if (cleanupFailures.length > 1)
  throw new AggregateError(cleanupFailures, "otel bridge cleanup failed")
if (!evidenceReady) throw new Error("otel bridge integration completed without scenario evidence")

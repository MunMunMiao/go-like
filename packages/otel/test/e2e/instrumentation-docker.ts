import {
  newClient,
  withDiscovery,
  withSelector,
  withTransport,
  type CallRequest,
  type Client
} from "@go-like/client"
import { background, type Context } from "@go-like/context"
import type { Server as LifecycleServer } from "@go-like/core"
import { traceClient, traceUnaryMiddleware, traceWebHandler } from "@go-like/otel"
import { newRandomSelector, type Discovery, type ServiceInstance } from "@go-like/registry"
import {
  address as serverAddress,
  handler,
  middleware,
  newServer,
  transport
} from "@go-like/server"
import type { Message } from "@go-like/transport"
import { newHTTPTransport } from "@go-like/transport-http"
import { newNodeHTTPTransport } from "@go-like/transport-http/node"
import { context, propagation, SpanStatusCode, type TextMapSetter } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan
} from "@opentelemetry/sdk-trace"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const CollectorImage =
  "otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6"
const Encoder = new TextEncoder()
const Decoder = new TextDecoder()
const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid GO_LIKE_E2E_OWNER")
const DockerOwnerLabel = `io.go-like.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly exitCode: number
  readonly output: string
}

interface CleanupEvidence {
  unaryHttpTerminal: boolean
  webHttpTerminal: boolean
  providersTerminal: boolean
  residualContainers: number
}

interface WebRequestState {
  bodyUsedAtHandlerEntry: boolean
  bodyLockedAtHandlerEntry: boolean
  body: string
  callerHeader: string
}

const webHeaderSetter: TextMapSetter<Headers> = Object.freeze({
  /** Sets one propagated field on the standard Web request headers. */
  set(carrier: Headers, key: string, value: string): void {
    carrier.set(key, value)
  }
})

/** Throws when one real-service invariant is false. */
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs one Docker command without a shell. */
async function command(arguments_: readonly string[]): Promise<CommandResult> {
  const process = Bun.spawn(Array.from(arguments_), { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])
  return { exitCode, output: `${stdout}${stderr}` }
}

/** Runs one required Docker command. */
async function commandOk(arguments_: readonly string[]): Promise<string> {
  const result = await command(arguments_)
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${arguments_.join(" ")}):\n${result.output}`)
  }
  return result.output
}

/** Allocates and immediately releases one loopback TCP port. */
function allocatePort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(): Response {
      return new Response(null, { status: 503 })
    }
  })
  const port = reservation.port
  void reservation.stop(true)
  if (port === undefined) throw new Error("Bun did not allocate a loopback port")
  return port
}

/** Reads the installed OpenTelemetry SDK version from validated package metadata. */
async function installedOtelVersion(): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(
      new URL("../../package.json", import.meta.resolve("@opentelemetry/sdk-trace")),
      "utf8"
    )
  )
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("installed OpenTelemetry SDK package has no version")
  }
  return value.version
}

/** Waits for one externally observable condition. */
async function waitUntil(
  operation: () => Promise<boolean>,
  label: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await operation())) {
    if (Date.now() >= deadline)
      throw new Error(`${label} did not become observable before deadline`)
    await Bun.sleep(100)
  }
}

/** Finds one unique finished span. */
function spanNamed(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const matching = spans.filter((span) => span.name === name)
  ensure(matching.length === 1, `expected exactly one span named ${name}, got ${matching.length}`)
  const span = matching[0]
  ensure(span !== undefined, `span is missing: ${name}`)
  return span
}

/** Stops one go-like Server and waits for its real running terminal. */
async function stopServer(server: LifecycleServer, running: Promise<void>): Promise<void> {
  await server.stop(background())
  await running
}

const session = crypto.randomUUID().replaceAll("-", "")
const collector = `go-like-otel-instrumentation-collector-${session}`
const collectorPort = allocatePort()
const config = resolve(import.meta.dir, "collector.yaml")
const serviceName = `go-like.otel.${session}`
const endpointName = "Trace"
const rootSpanName = `go-like.e2e.root.${session}`
const webRootSpanName = `go-like.e2e.web.root.${session}`
const otelVersion = await installedOtelVersion()
ensure(otelVersion === "2.10.0", `unexpected OpenTelemetry SDK version: ${otelVersion}`)
const manager = new AsyncLocalStorageContextManager().enable()
let collectorExists = false
let provider: TracerProvider | null = null
let httpServer: ReturnType<typeof newServer> | null = null
let httpRunning: Promise<void> | null = null
let webServer: ReturnType<typeof Bun.serve> | null = null
let client: Client | null = null
let primaryFailure: unknown | null = null
const cleanupFailures: unknown[] = []
const cleanupEvidence: CleanupEvidence = {
  unaryHttpTerminal: false,
  webHttpTerminal: false,
  providersTerminal: false,
  residualContainers: 0
}
let scenarioComplete = false

try {
  context.disable()
  propagation.disable()
  ensure(context.setGlobalContextManager(manager), "official Context Manager was not installed")
  ensure(
    propagation.setGlobalPropagator(new W3CTraceContextPropagator()),
    "official W3C propagator was not installed"
  )
  await commandOk([
    "docker",
    "run",
    "--detach",
    "--name",
    collector,
    "--label",
    DockerOwnerLabel,
    "--publish",
    `127.0.0.1:${collectorPort}:4318`,
    "--volume",
    `${config}:/etc/otelcol-contrib/config.yaml:ro`,
    CollectorImage,
    "--config=/etc/otelcol-contrib/config.yaml"
  ])
  collectorExists = true
  await waitUntil(
    async () =>
      (await command(["docker", "logs", collector])).output.includes("Everything is ready"),
    "Collector readiness"
  )
  const collectorVersion = await commandOk([
    "docker",
    "exec",
    collector,
    "/otelcol-contrib",
    "--version"
  ])
  ensure(collectorVersion.includes("0.157.0"), `unexpected Collector version: ${collectorVersion}`)

  const memoryExporter = new InMemorySpanExporter()
  const resource = resourceFromAttributes({ "service.name": "go-like-otel-instrumentation-e2e" })
  provider = new TracerProvider({
    resource,
    spanProcessors: [
      new SimpleSpanProcessor({ exporter: memoryExporter }),
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: `http://127.0.0.1:${collectorPort}/v1/traces`,
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
  const tracer = provider.getTracer("go-like-e2e")

  const endpointHandler = async (_ctx: Context, request: Message): Promise<Message> => {
    ensure(request.header["x-go-like-e2e"] === "kept", "HTTP request lost the caller header")
    return {
      header: { "x-go-like-e2e-response": "ok" },
      body: Encoder.encode("response")
    }
  }
  httpServer = newServer(
    transport(newNodeHTTPTransport()),
    serverAddress("127.0.0.1:0"),
    handler(serviceName, endpointName, endpointHandler),
    middleware(traceUnaryMiddleware(tracer))
  )
  const boundHTTPEndpoint = await httpServer.endpoint(background())
  httpRunning = httpServer.start(background())
  const instance: ServiceInstance = {
    id: "node-1",
    name: serviceName,
    version: "1.0.0",
    endpoints: [boundHTTPEndpoint],
    metadata: {}
  }
  const discovery: Discovery = {
    async getService(_ctx, name) {
      ensure(name === serviceName, `unexpected discovered service: ${name}`)
      return [instance]
    },
    async watch(_ctx, name) {
      ensure(name === serviceName, `unexpected watched service: ${name}`)
      let initialSnapshot = true
      let stopWatcher: (() => void) | null = null
      const watcherStopped = new Promise<void>((resolve) => {
        stopWatcher = resolve
      })
      return Object.freeze({
        async next(): Promise<readonly ServiceInstance[]> {
          if (initialSnapshot) {
            initialSnapshot = false
            return Object.freeze([instance])
          }
          await watcherStopped
          throw new Error("test discovery watcher stopped")
        },
        async stop(): Promise<void> {
          stopWatcher?.()
        }
      })
    }
  }
  const activeClient = traceClient(
    newClient(
      withDiscovery(discovery),
      withSelector(newRandomSelector(() => 0)),
      withTransport(newHTTPTransport())
    ),
    tracer
  )
  client = activeClient
  const request: CallRequest = {
    service: serviceName,
    endpoint: endpointName,
    message: { header: { "x-go-like-e2e": "kept" }, body: Encoder.encode("request") }
  }
  const captured: { response: Message | null } = { response: null }
  await tracer.startActiveSpan(rootSpanName, async (rootSpan) => {
    try {
      captured.response = await activeClient.call(background(), request)
    } finally {
      rootSpan.end()
    }
  })
  ensure(captured.response !== null, "HTTP Client returned no response")
  ensure(
    Decoder.decode(captured.response.body) === "response",
    "HTTP response body was not preserved"
  )
  ensure(
    captured.response.header["x-go-like-e2e-response"] === "ok",
    "HTTP response header was not preserved"
  )

  const webRequestState: WebRequestState = {
    bodyUsedAtHandlerEntry: true,
    bodyLockedAtHandlerEntry: true,
    body: "",
    callerHeader: ""
  }
  const webHandler = traceWebHandler(async (webRequest) => {
    webRequestState.bodyUsedAtHandlerEntry = webRequest.bodyUsed
    webRequestState.bodyLockedAtHandlerEntry = webRequest.body?.locked === true
    webRequestState.callerHeader = webRequest.headers.get("x-go-like-e2e-web") ?? ""
    webRequestState.body = await webRequest.text()
    return new Response("web-response", {
      headers: { "x-go-like-e2e-web-response": "ok" }
    })
  }, tracer)
  webServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: webHandler
  })
  const webPort = webServer.port
  ensure(webPort !== undefined, "Bun Web server did not publish a bound port")
  const webCaptured: { response: Response | null } = { response: null }
  await tracer.startActiveSpan(webRootSpanName, async (rootSpan) => {
    try {
      const headers = new Headers({ "x-go-like-e2e-web": "kept" })
      propagation.inject(context.active(), headers, webHeaderSetter)
      webCaptured.response = await fetch(`http://127.0.0.1:${webPort}/orders`, {
        method: "POST",
        headers,
        body: "web-request"
      })
    } finally {
      rootSpan.end()
    }
  })
  ensure(webCaptured.response !== null, "standard Web request returned no response")
  const webResponseBodyUsedBeforeOwnerRead = webCaptured.response.bodyUsed
  const webResponseBodyLockedBeforeOwnerRead = webCaptured.response.body?.locked === true
  ensure(!webResponseBodyUsedBeforeOwnerRead, "Web response body was consumed before owner read")
  ensure(!webResponseBodyLockedBeforeOwnerRead, "Web response body was locked before owner read")
  ensure(
    webCaptured.response.headers.get("x-go-like-e2e-web-response") === "ok",
    "Web response header was not preserved"
  )
  const webResponse = await webCaptured.response.text()
  ensure(webResponse === "web-response", "Web response body was not preserved")
  ensure(!webRequestState.bodyUsedAtHandlerEntry, "Web request body was consumed before handler")
  ensure(!webRequestState.bodyLockedAtHandlerEntry, "Web request body was locked before handler")
  ensure(webRequestState.body === "web-request", "Web request body was not preserved")
  ensure(webRequestState.callerHeader === "kept", "Web request lost the caller header")

  await provider.forceFlush()
  const clientSpanName = `go-like.client ${serviceName}/${endpointName}`
  const serverSpanName = `go-like.server ${serviceName}/${endpointName}`
  const webSpanName = "POST"
  const names = [rootSpanName, clientSpanName, serverSpanName, webRootSpanName, webSpanName]
  await waitUntil(async () => {
    const logs = (await command(["docker", "logs", collector])).output
    return names.every((name) => logs.includes(name))
  }, "Collector trace export")

  const spans = memoryExporter.getFinishedSpans()
  ensure(
    spans.length === names.length,
    `expected ${names.length} finished spans, got ${spans.length}`
  )
  const rootSpan = spanNamed(spans, rootSpanName)
  const clientSpan = spanNamed(spans, clientSpanName)
  const serverSpan = spanNamed(spans, serverSpanName)
  const webRootSpan = spanNamed(spans, webRootSpanName)
  const webSpan = spanNamed(spans, webSpanName)
  ensure(
    clientSpan.parentSpanContext?.spanId === rootSpan.spanContext().spanId,
    "Client parent mismatch"
  )
  ensure(
    serverSpan.parentSpanContext?.spanId === clientSpan.spanContext().spanId,
    "Server parent mismatch"
  )
  ensure(
    webSpan.parentSpanContext?.spanId === webRootSpan.spanContext().spanId,
    "Web Handler parent mismatch"
  )
  const traceId = rootSpan.spanContext().traceId
  ensure(
    [rootSpan, clientSpan, serverSpan].every((span) => span.spanContext().traceId === traceId),
    "unary spans crossed trace IDs"
  )
  const webTraceId = webRootSpan.spanContext().traceId
  ensure(webTraceId !== traceId, "independent Web request reused the unary trace ID")
  ensure(
    [webRootSpan, webSpan].every((span) => span.spanContext().traceId === webTraceId),
    "Web spans crossed trace IDs"
  )
  ensure(
    [clientSpan, serverSpan, webSpan].every(
      (span) =>
        span.status.code !== SpanStatusCode.ERROR && span.attributes["go-like.outcome"] === "ok"
    ),
    "one instrumented span did not complete successfully"
  )
  scenarioComplete = true
} catch (value) {
  primaryFailure = value
} finally {
  if (client !== null) {
    try {
      await client.close(background())
    } catch (value) {
      cleanupFailures.push(value)
    }
  }
  if (webServer !== null) {
    try {
      await webServer.stop(true)
      cleanupEvidence.webHttpTerminal = true
    } catch (value) {
      cleanupFailures.push(value)
    }
  }
  if (httpServer !== null && httpRunning !== null) {
    try {
      await stopServer(httpServer, httpRunning)
      cleanupEvidence.unaryHttpTerminal = true
    } catch (value) {
      cleanupFailures.push(value)
    }
  }
  if (provider !== null) {
    try {
      await provider.shutdown()
      cleanupEvidence.providersTerminal = true
    } catch (value) {
      cleanupFailures.push(value)
    }
  }
  context.disable()
  propagation.disable()
  manager.disable()
  if (collectorExists) {
    const removed = await command(["docker", "rm", "--force", collector])
    if (removed.exitCode !== 0) cleanupFailures.push(new Error(removed.output))
  }
  const residual = await command([
    "docker",
    "ps",
    "--all",
    "--filter",
    `name=${collector}`,
    "--format",
    "{{.Names}}"
  ])
  if (residual.exitCode !== 0) {
    cleanupFailures.push(new Error(`could not query residual Docker container: ${collector}`))
  } else if (residual.output.split("\n").includes(collector)) {
    cleanupEvidence.residualContainers = 1
    cleanupFailures.push(new Error(`residual Docker container remains: ${collector}`))
  }
}

if (primaryFailure !== null) {
  if (cleanupFailures.length === 0) throw primaryFailure
  throw new AggregateError(
    [primaryFailure, ...cleanupFailures],
    "instrumentation E2E and cleanup failed"
  )
}
if (cleanupFailures.length === 1) throw cleanupFailures[0]
if (cleanupFailures.length > 1)
  throw new AggregateError(cleanupFailures, "instrumentation cleanup failed")
ensure(scenarioComplete, "instrumentation E2E did not complete")
ensure(cleanupEvidence.unaryHttpTerminal, "unary HTTP server did not reach terminal state")
ensure(cleanupEvidence.webHttpTerminal, "Web HTTP server did not reach terminal state")
ensure(cleanupEvidence.providersTerminal, "telemetry provider did not reach terminal state")
ensure(cleanupEvidence.residualContainers === 0, "Docker containers remain after cleanup")

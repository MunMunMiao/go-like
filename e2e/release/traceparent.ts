/**
 * D37 / D40 release gate.
 *
 * Configuration A registers an AsyncLocalStorage context manager and no global propagator.
 * Configuration B adds NodeSDK's default composite W3C propagator and enables
 * `@opentelemetry/instrumentation-undici`. Each configuration runs in its own process,
 * on Bun and on Node. Config A fails on a duplicate or broken `traceparent`, or when a
 * socket-level hook misses that call's go-like CLIENT span. Config B records a duplicate
 * as OQ6 evidence and does not fail for it. The ConnectRPC lane watches the HTTP/2 client
 * stream channels, because those writes never reach `net.Socket.prototype.write`.
 */
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from "node:fs"
import { basename, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import diagnosticsChannel from "node:diagnostics_channel"
import http from "node:http"
import http2 from "node:http2"
import { Socket } from "node:net"

const releaseDir = fileURLToPath(new URL(".", import.meta.url))
const repoDir = fileURLToPath(new URL("../..", import.meta.url))
const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const traceparentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
const rpcName = "release.trace/Echo"
const http2CreatedChannel = "http2.client.stream.created"
const http2StartChannel = "http2.client.stream.start"

/**
 * A: no global OTel propagator. B: NodeSDK-style global W3C propagator plus undici instrumentation.
 * C: B plus an undici `ignoreRequestHook` that skips requests already carrying `traceparent`.
 */
type ReleaseConfig = "A" | "B" | "C"

/** Reports whether an undici request already carries a `traceparent` header (string or flat array form). */
function carriesTraceparent(request: { readonly headers?: unknown }): boolean {
  const headers = request.headers
  if (typeof headers === "string") return /(^|\r\n)traceparent:/iu.test(headers)
  if (!Array.isArray(headers)) return false
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index]
    if (typeof name === "string" && name.toLowerCase() === "traceparent") return true
  }
  return false
}

interface CommandOutput {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface SpanNote {
  readonly name: string
  readonly kind: number
  readonly spanId: string
  readonly traceId: string
  parentSpanId: string
  parentTraceId: string
}

interface HookHit {
  readonly source: string
  readonly spanId: string
  readonly spanName: string
  readonly socketId: number
  readonly localPort: number
  readonly remotePort: number
}

interface CallReport {
  readonly traceparents: readonly string[]
  readonly count: number
  readonly joined: boolean
  readonly clientSpanId: string
  readonly serverSpanId: string
  readonly spans: readonly SpanNote[]
  readonly hits: readonly HookHit[]
}

interface LaneReport {
  readonly transport: string
  readonly calls: readonly [CallReport, CallReport]
  readonly pooled: "true" | "false" | "unobserved"
  readonly connection: "true" | "false" | "unobserved"
  readonly foreign: boolean
}

/** Returns the process runtime without depending on the Bun global. */
function runtimeName(): "bun" | "node" {
  return typeof Reflect.get(process.versions, "bun") === "string" ? "bun" : "node"
}

/** Keeps loopback calls off the session proxy. */
function loopbackBypass(current: string | undefined, alternate: string | undefined): string {
  const parts = `${current ?? ""},${alternate ?? ""},127.0.0.1,localhost,::1`
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return [...new Set(parts)].join(",")
}

/** Points every release-fixture OpenTelemetry API copy at the plug's copy. */
function linkSharedApi(plugApi: string): void {
  const root = join(releaseDir, "node_modules")
  const readEntries = (directory: string) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
    } catch {
      return null
    }
  }
  const visit = (directory: string): void => {
    const entries = readEntries(directory)
    if (entries === null) return
    for (const entry of entries) {
      if (entry.name === ".bin") continue
      const path = join(directory, entry.name)
      const apiPackage = entry.name === "api" && basename(directory) === "@opentelemetry"
      if (entry.isSymbolicLink()) {
        if (!apiPackage) continue
        if (realpathSync(path) === plugApi) continue
        unlinkSync(path)
        symlinkSync(plugApi, path, "dir")
        continue
      }
      if (!entry.isDirectory()) continue
      if (!apiPackage) {
        visit(path)
        continue
      }
      if (realpathSync(path) === plugApi) continue
      rmSync(path, { recursive: true, force: true })
      symlinkSync(plugApi, path, "dir")
    }
  }
  visit(root)
}

/** Lets the Node child resolve workspace packages from this fixture. */
function linkWorkspacePackages(): void {
  const scope = join(releaseDir, "node_modules/@go-like")
  mkdirSync(scope, { recursive: true })
  for (const name of ["core", "otel", "connectrpc", "etcd"]) {
    const link = join(scope, name)
    const desired = relative(scope, join(repoDir, "packages", name))
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      if (readlinkSync(link) === desired) continue
      unlinkSync(link)
    } else if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
      rmSync(link, { recursive: true, force: true })
    }
    symlinkSync(desired, link, "dir")
  }
}

/** Installs the module-identity links before either process imports OpenTelemetry. */
function prepareReleaseModules(): void {
  const plugApi = realpathSync(join(repoDir, "packages/otel/node_modules/@opentelemetry/api"))
  linkSharedApi(plugApi)
  linkWorkspacePackages()
}

/** Fails closed when a fixture package still sees a second OpenTelemetry API. */
function assertSharedApi(): void {
  const plug = realpathSync(
    createRequire(join(repoDir, "packages/otel/package.json")).resolve("@opentelemetry/api")
  )
  const copies = [
    require.resolve("@opentelemetry/api"),
    createRequire(
      join(releaseDir, "node_modules/@opentelemetry/instrumentation-undici/package.json")
    ).resolve("@opentelemetry/api"),
    createRequire(
      join(releaseDir, "node_modules/@opentelemetry/context-async-hooks/package.json")
    ).resolve("@opentelemetry/api")
  ].map((path) => realpathSync(path))
  for (const copy of copies) {
    if (copy !== plug) {
      throw new Error(`OpenTelemetry API copies diverged plug=${plug} copy=${copy}`)
    }
  }
}

/** Runs one child with stdin closed. */
function runProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repoDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk)
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 60_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    })
  })
}

/** Spawns Bun and Node for each propagator configuration. */
async function runParent(): Promise<void> {
  const tsx = join(repoDir, "node_modules/tsx/dist/cli.mjs")
  const bun = runtimeName() === "bun" ? process.execPath : "bun"
  const bypass = loopbackBypass(process.env.NO_PROXY, process.env.no_proxy)
  const runs = [
    ["node", "A"],
    ["node", "B"],
    ["node", "C"],
    ["bun", "A"],
    ["bun", "B"],
    ["bun", "C"]
  ] as const
  let failed = false
  for (const [runtime, config] of runs) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GO_LIKE_RELEASE_TRACEPARENT: "1",
      GO_LIKE_RELEASE_TRACEPARENT_CONFIG: config,
      NO_PROXY: bypass,
      no_proxy: bypass
    }
    const command = runtime === "bun" ? bun : "node"
    const args = runtime === "bun" ? [scriptPath] : [tsx, scriptPath]
    const result = await runProcess(command, args, env)
    process.stderr.write(`child runtime=${runtime} config=${config} exit=${result.code}\n`)
    process.stdout.write(result.stdout)
    if (result.stderr.length > 0) process.stderr.write(result.stderr)
    if (result.code !== 0) failed = true
  }
  if (failed) process.exitCode = 1
}

/** Bounds one call so a stuck socket cannot hold the gate open. */
function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out`))
    }, 10_000)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Counts raw fields, splitting a comma-joined Node header into its members. */
function traceparentCount(values: readonly string[]): number {
  let count = 0
  for (const value of values) {
    const parts = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    count += Math.max(parts.length, 1)
  }
  return count
}

/** Accepts one raw W3C traceparent field. */
function validSingle(values: readonly string[]): boolean {
  return values.length === 1 && values[0] !== undefined && traceparentPattern.test(values[0])
}

/** Reads repeated traceparent fields from a Node request. */
function extractTraceparents(message: unknown): string[] {
  if (message === null || typeof message !== "object") return []
  if ("rawHeaders" in message && Array.isArray(message.rawHeaders)) {
    const pairs = message.rawHeaders.filter((item): item is string => typeof item === "string")
    const values: string[] = []
    for (let index = 0; index + 1 < pairs.length; index += 2) {
      const name = pairs[index]
      const value = pairs[index + 1]
      if (name !== undefined && value !== undefined && name.toLowerCase() === "traceparent") {
        values.push(value)
      }
    }
    if (values.length > 0) return values
  }
  if (!("headers" in message) || message.headers === null || typeof message.headers !== "object") {
    return []
  }
  const values: string[] = []
  for (const [name, value] of Object.entries(message.headers)) {
    if (name.toLowerCase() !== "traceparent") continue
    if (typeof value === "string") values.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") values.push(item)
      }
    }
  }
  return values
}

/** Reads the active OpenTelemetry span without assuming the SDK name field. */
function activeSpan(api: typeof import("@opentelemetry/api")): {
  readonly spanId: string
  readonly name: string
} {
  const span = api.trace.getSpan(api.context.active())
  if (span === undefined) return { spanId: "", name: "" }
  const name = "name" in span && typeof span.name === "string" ? span.name : ""
  return { spanId: span.spanContext().spanId, name }
}

/** Reads socket ports when the hook payload carries a net.Socket. */
function socketPorts(socket: object | null): {
  readonly localPort: number
  readonly remotePort: number
} {
  if (socket === null) return { localPort: 0, remotePort: 0 }
  const localPort =
    "localPort" in socket && typeof socket.localPort === "number" ? socket.localPort : 0
  const remotePort =
    "remotePort" in socket && typeof socket.remotePort === "number" ? socket.remotePort : 0
  return { localPort, remotePort }
}

/** Finds the go-like CLIENT span started for one call. */
function selectClient(spans: readonly SpanNote[], transport: string): SpanNote | undefined {
  const clients = spans.filter((span) => span.kind === 2)
  if (transport === "connectrpc") {
    return clients.find(
      (span) =>
        span.name !== "POST" && span.name !== "GET" && span.name !== "PUT" && span.name !== "HTTP"
    )
  }
  return clients.find((span) => span.name === rpcName)
}

/** Finds the SERVER span that joined one CLIENT span. */
function selectServer(
  spans: readonly SpanNote[],
  client: SpanNote,
  transport: string
): SpanNote | undefined {
  return spans.find(
    (span) =>
      span.kind === 1 &&
      span.parentSpanId === client.spanId &&
      span.traceId === client.traceId &&
      (transport === "connectrpc" || span.name === rpcName)
  )
}

/** A hit from a socket, undici send, or the HTTP/2 client stream channels. */
function isSessionHook(source: string): boolean {
  return (
    source === "undici:client:sendHeaders" ||
    source === "socket.write" ||
    source === http2CreatedChannel ||
    source === http2StartChannel
  )
}

/** Reads the HTTP/2 session carried by a client stream diagnostic. */
function http2Session(message: unknown): object | null {
  if (message === null || typeof message !== "object" || !("stream" in message)) return null
  const stream: unknown = message.stream
  if (stream === null || typeof stream !== "object" || !("session" in stream)) return null
  const session: unknown = stream.session
  return session !== null && typeof session === "object" ? session : null
}

/** Bun types the server stream event as Http2Stream, which omits `respond`. */
function canRespond(stream: object): stream is {
  respond(headers: { readonly ":status": number }): void
  end(payload?: string): void
} {
  return (
    "respond" in stream &&
    typeof stream.respond === "function" &&
    "end" in stream &&
    typeof stream.end === "function"
  )
}

/**
 * Asks this runtime to publish the Node HTTP/2 client stream channels once.
 * `created` and `start` stay false when the runtime accepts the subscription and never publishes.
 */
async function probeHttp2StreamChannels(): Promise<{
  readonly created: boolean
  readonly start: boolean
  readonly error: string
}> {
  let created = false
  let start = false
  const onCreated = (): void => {
    created = true
  }
  const onStart = (): void => {
    start = true
  }
  diagnosticsChannel.subscribe(http2CreatedChannel, onCreated)
  diagnosticsChannel.subscribe(http2StartChannel, onStart)
  let client: ReturnType<typeof http2.connect> | undefined
  let server: ReturnType<typeof http2.createServer> | undefined
  const fail = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  try {
    server = http2.createServer()
    server.on("stream", (stream) => {
      if (!canRespond(stream)) throw new Error("http2 probe stream cannot respond")
      stream.respond({ ":status": 200 })
      stream.end("ok")
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("http2 probe listen timeout")), 2000)
      server?.listen(0, "127.0.0.1", () => {
        clearTimeout(timer)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new Error("http2 probe did not bind a port")
    }
    client = http2.connect(`http://127.0.0.1:${address.port}`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("http2 probe connect timeout")), 2000)
      client?.once("connect", () => {
        clearTimeout(timer)
        resolve()
      })
      client?.once("error", (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(fail(error)))
      })
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("http2 probe request timeout")), 2000)
      const request = client?.request({ ":method": "POST", ":path": "/probe" })
      if (request === undefined) {
        clearTimeout(timer)
        reject(new Error("http2 probe request was not created"))
        return
      }
      request.resume()
      request.on("end", () => {
        clearTimeout(timer)
        resolve()
      })
      request.on("error", (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(fail(error)))
      })
      request.end("probe")
    })
    return { created, start, error: "" }
  } catch (error) {
    return { created, start, error: fail(error) }
  } finally {
    diagnosticsChannel.unsubscribe(http2CreatedChannel, onCreated)
    diagnosticsChannel.unsubscribe(http2StartChannel, onStart)
    client?.close()
    const listening = server
    if (listening !== undefined) {
      await new Promise<void>((resolve) => {
        listening.close(() => resolve())
      })
    }
  }
}

/** Reports whether call 2 saw its own CLIENT span on a socket-level hook. */
function pooledOwn(
  hits: readonly HookHit[],
  clientSpanId: string
): "true" | "false" | "unobserved" {
  const socketHits = hits.filter((hit) => isSessionHook(hit.source))
  if (socketHits.length === 0) return "unobserved"
  if (clientSpanId === "") return "false"
  return socketHits.some((hit) => hit.spanId === clientSpanId) ? "true" : "false"
}

/** Reports whether the two calls wrote the same socket. */
function pooledConnection(
  first: readonly HookHit[],
  second: readonly HookHit[]
): "true" | "false" | "unobserved" {
  const ids = (hits: readonly HookHit[]): Set<number> => {
    const found = new Set<number>()
    for (const hit of hits) {
      if (hit.socketId !== 0) found.add(hit.socketId)
    }
    return found
  }
  const left = ids(first)
  const right = ids(second)
  if (left.size === 0 || right.size === 0) return "unobserved"
  for (const id of right) {
    if (left.has(id)) return "true"
  }
  return "false"
}

/**
 * Upstream failures this gate tolerates for now. Only the duplicate-header and broken-join reasons of
 * the listed lane are tolerated; any other failure on that lane still fails the gate. When the lane
 * stops reproducing (the upstream fix shipped), the gate fails so the entry is removed.
 * `@opentelemetry/instrumentation-undici` appends a second `traceparent` to a Node `fetch` request that
 * already carries one; receivers fold the two fields and W3C parsing rejects the result.
 */
const knownUpstreamFailures: readonly {
  readonly config: ReleaseConfig
  readonly runtime: "node" | "bun"
  readonly transport: string
  readonly links: readonly string[]
}[] = [
  {
    config: "B",
    runtime: "node",
    transport: "http",
    links: [
      "https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2796",
      "https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3711",
      "https://github.com/open-telemetry/opentelemetry-js-contrib/pull/3713"
    ]
  }
]

/** Reports whether a failure reason is the folded-duplicate symptom of the known upstream bug. */
function upstreamSymptom(reason: string): boolean {
  return / call \d+ (traceparent_count=|joined=false)/u.test(reason)
}

/** Applies the known-upstream-failure table to one lane's strict result. */
function applyKnownUpstream(
  config: ReleaseConfig,
  runtime: string,
  transport: string,
  reasons: readonly string[]
): readonly string[] {
  const known = knownUpstreamFailures.find(
    (entry) => entry.config === config && entry.runtime === runtime && entry.transport === transport
  )
  if (known === undefined) return reasons
  const symptoms = reasons.filter(upstreamSymptom)
  if (symptoms.length === 0) {
    return [
      `${transport} known upstream failure no longer reproduces; remove its entry (${known.links.join(" ")})`,
      ...reasons
    ]
  }
  for (const symptom of symptoms) {
    console.log(
      `known_upstream_failure config=${config} runtime=${runtime} ${symptom} see=${known.links.join(",")}`
    )
  }
  return reasons.filter((reason) => !upstreamSymptom(reason))
}

/** Every configuration expects one valid `traceparent` per call and a joined server span. */
function evaluate(
  config: ReleaseConfig,
  runtime: string,
  report: LaneReport,
  http2Hook: boolean
): readonly string[] {
  const reasons: string[] = []
  const bunFetch = report.transport === "http" && runtime === "bun"
  const bunConnectWithoutHook = report.transport === "connectrpc" && runtime === "bun" && !http2Hook
  const hookRequired = !bunFetch && !bunConnectWithoutHook
  report.calls.forEach((call, index) => {
    if (!validSingle(call.traceparents)) {
      reasons.push(
        `${report.transport} call ${index + 1} traceparent_count=${call.count} values=${JSON.stringify(call.traceparents)}`
      )
      return
    }
    if (!call.joined) reasons.push(`${report.transport} call ${index + 1} joined=false`)
  })
  if (report.pooled === "false" || (hookRequired && report.pooled !== "true")) {
    reasons.push(`${report.transport} pooled_own_span=${report.pooled}`)
  }
  // Portable fetch opens a new socket per call. The node HTTP transport and, when the
  // HTTP/2 stream channels publish, ConnectRPC must reuse one session for call 2.
  const connectionRequired =
    report.transport === "http-node" || (report.transport === "connectrpc" && hookRequired)
  if (connectionRequired && report.connection !== "true") {
    reasons.push(`${report.transport} pooled_connection=${report.connection}`)
  }
  return applyKnownUpstream(config, runtime, report.transport, reasons)
}

/** Prints the one-line OQ6 / D40 summary for the pooled call. */
function summaryLine(config: ReleaseConfig, runtime: string, report: LaneReport): string {
  const call = report.calls[1]
  return `config=${config} runtime=${runtime} transport=${report.transport} traceparent_count=${call.count} joined=${call.joined} pooled_own_span=${report.pooled} pooled_connection=${report.connection} traceparents=${JSON.stringify(call.traceparents)}`
}

/** Prints the raw per-call evidence used to decide OQ6. */
function detailLine(config: ReleaseConfig, runtime: string, report: LaneReport): string {
  return `detail ${JSON.stringify({
    config,
    runtime,
    transport: report.transport,
    pooled_own_span: report.pooled,
    pooled_connection: report.connection,
    foreign_client_span: report.foreign,
    calls: report.calls.map((call) => ({
      traceparents: call.traceparents,
      traceparent_count: call.count,
      joined: call.joined,
      client_span_id: call.clientSpanId,
      server_span_id: call.serverSpanId,
      spans: call.spans.map((span) => ({
        name: span.name,
        kind: span.kind,
        span_id: span.spanId,
        parent_span_id: span.parentSpanId
      })),
      hooks: call.hits
    }))
  })}`
}

/** Observes one configuration inside this process. */
async function runChild(): Promise<void> {
  const configValue = process.env.GO_LIKE_RELEASE_TRACEPARENT_CONFIG
  if (configValue !== "A" && configValue !== "B" && configValue !== "C") {
    throw new Error("GO_LIKE_RELEASE_TRACEPARENT_CONFIG must be A, B or C")
  }
  const config = configValue
  const runtime = runtimeName()
  const bypass = loopbackBypass(process.env.NO_PROXY, process.env.no_proxy)
  process.env.NO_PROXY = bypass
  process.env.no_proxy = bypass
  assertSharedApi()

  const api = await import("@opentelemetry/api")
  const asyncHooks = await import("@opentelemetry/context-async-hooks")
  const otelCore = await import("@opentelemetry/core")
  const sdk = await import("@opentelemetry/sdk-trace")
  const contextApi = await import("@go-like/core/context")
  const telemetryApi = await import("@go-like/core/telemetry")
  const serverApi = await import("@go-like/core/server")
  const clientApi = await import("@go-like/core/client")
  const structApi = await import("@go-like/core/struct")
  const transportApi = await import("@go-like/core/transport")
  const httpApi = await import("@go-like/core/transport/http")
  const nodeHttpApi = await import("@go-like/core/transport/http/node")
  const otelApi = await import("@go-like/otel")
  const connectApi = await import("@go-like/connectrpc/node")
  const generated = await import("../../packages/connectrpc/.artifacts/gen/order/v1/order_like.js")

  const manager = new asyncHooks.AsyncLocalStorageContextManager().enable()
  if (!api.context.setGlobalContextManager(manager)) {
    manager.disable()
    throw new Error("OpenTelemetry context manager was already installed")
  }
  if (config === "B" || config === "C") {
    const installed = api.propagation.setGlobalPropagator(
      new otelCore.CompositePropagator({
        propagators: [new otelCore.W3CTraceContextPropagator(), new otelCore.W3CBaggagePropagator()]
      })
    )
    if (!installed) throw new Error("global W3C propagator was not installed")
  }

  let capture: SpanNote[] | null = null
  const processor: import("@opentelemetry/sdk-trace").SpanProcessor = {
    onStart(span) {
      if (capture === null) return
      const parent = span.parentSpanContext
      capture.push({
        name: span.name,
        kind: span.kind,
        spanId: span.spanContext().spanId,
        traceId: span.spanContext().traceId,
        parentSpanId: parent?.spanId ?? "",
        parentTraceId: parent?.traceId ?? ""
      })
    },
    onEnd(span) {
      if (capture === null) return
      const parent = span.parentSpanContext
      if (parent === undefined) return
      const note = capture.find((item) => item.spanId === span.spanContext().spanId)
      if (note === undefined) return
      note.parentSpanId = parent.spanId
      note.parentTraceId = parent.traceId
    },
    forceFlush() {
      return Promise.resolve()
    },
    shutdown() {
      return Promise.resolve()
    }
  }
  const provider = new sdk.TracerProvider({ spanProcessors: [processor] })
  let instrumentation:
    | import("@opentelemetry/instrumentation-undici").UndiciInstrumentation
    | null = null
  if (config === "B" || config === "C") {
    const undici = await import("@opentelemetry/instrumentation-undici")
    instrumentation = new undici.UndiciInstrumentation(
      config === "C" ? { ignoreRequestHook: carriesTraceparent } : {}
    )
    instrumentation.setTracerProvider(provider)
    api.trace.setGlobalTracerProvider(provider)
    instrumentation.enable()
  }
  const plug = otelApi.newOtelTracerProvider(provider)
  const telemetry = telemetryApi.newTelemetry({ tracerProvider: plug })
  const traced = telemetryApi.withTelemetry(contextApi.background(), telemetry)
  const lifecycle = plug.lifecycle.start(contextApi.background())
  void lifecycle.catch(() => undefined)

  const socketIds = new WeakMap<object, number>()
  let nextSocket = 1
  let callHits: HookHit[] | null = null
  let headerSlot: string[] | null = null
  const seen = new Set<string>()
  const restore: Array<() => void> = []

  const rememberSocket = (socket: object | null): number => {
    if (socket === null) return 0
    const existing = socketIds.get(socket)
    if (existing !== undefined) return existing
    const id = nextSocket
    nextSocket += 1
    socketIds.set(socket, id)
    return id
  }
  const note = (source: string, socket: object | null): void => {
    if (callHits === null) return
    const active = activeSpan(api)
    const ports = socketPorts(socket)
    const id = rememberSocket(socket)
    const key = `${source}\0${active.spanId}\0${id}`
    if (seen.has(key)) return
    seen.add(key)
    callHits.push({
      source,
      spanId: active.spanId,
      spanName: active.name,
      socketId: id,
      localPort: ports.localPort,
      remotePort: ports.remotePort
    })
  }
  const onSendHeaders = (message: unknown): void => {
    const socket =
      message !== null &&
      typeof message === "object" &&
      "socket" in message &&
      typeof message.socket === "object" &&
      message.socket !== null
        ? message.socket
        : null
    note("undici:client:sendHeaders", socket)
  }
  const onRequestCreate = (): void => {
    note("undici:request:create", null)
  }
  const onHttp2Created = (message: unknown): void => {
    note(http2CreatedChannel, http2Session(message))
  }
  const onHttp2Start = (message: unknown): void => {
    note(http2StartChannel, http2Session(message))
  }
  diagnosticsChannel.subscribe("undici:client:sendHeaders", onSendHeaders)
  diagnosticsChannel.subscribe("undici:request:create", onRequestCreate)
  diagnosticsChannel.subscribe(http2CreatedChannel, onHttp2Created)
  diagnosticsChannel.subscribe(http2StartChannel, onHttp2Start)
  const originalWrite = Socket.prototype.write
  Socket.prototype.write = function patchedWrite(this: Socket, ...args: never[]): boolean {
    note("socket.write", this)
    return Reflect.apply(originalWrite, this, args) as boolean
  }
  restore.push(() => {
    Socket.prototype.write = originalWrite
  })
  const patchRequest = (prototype: { emit: (...args: never[]) => boolean }): void => {
    const original = prototype.emit
    prototype.emit = function patchedEmit(this: unknown, ...args: never[]): boolean {
      const event = args[0]
      if (event === "request" && headerSlot !== null && headerSlot.length === 0) {
        headerSlot.push(...extractTraceparents(args[1]))
      }
      return Reflect.apply(original, this, args) as boolean
    }
    restore.push(() => {
      prototype.emit = original
    })
  }
  patchRequest(http.Server.prototype as unknown as { emit: (...args: never[]) => boolean })
  const http2Probe = http2.createServer()
  patchRequest(Object.getPrototypeOf(http2Probe) as { emit: (...args: never[]) => boolean })
  http2Probe.close()

  const measure = async (
    operation: () => Promise<void>
  ): Promise<{
    readonly traceparents: readonly string[]
    readonly spans: readonly SpanNote[]
    readonly hits: readonly HookHit[]
  }> => {
    const spans: SpanNote[] = []
    const headers: string[] = []
    const hits: HookHit[] = []
    capture = spans
    headerSlot = headers
    callHits = hits
    seen.clear()
    try {
      await operation()
      return { traceparents: headers, spans, hits }
    } finally {
      capture = null
      headerSlot = null
      callHits = null
    }
  }
  const reportCall = (
    transport: string,
    measured: {
      readonly traceparents: readonly string[]
      readonly spans: readonly SpanNote[]
      readonly hits: readonly HookHit[]
    }
  ): CallReport => {
    const client = selectClient(measured.spans, transport)
    const server =
      client === undefined ? undefined : selectServer(measured.spans, client, transport)
    return {
      traceparents: measured.traceparents,
      count: traceparentCount(measured.traceparents),
      joined: server !== undefined,
      clientSpanId: client?.spanId ?? "",
      serverSpanId: server?.spanId ?? "",
      spans: measured.spans,
      hits: measured.hits
    }
  }

  const lines: string[] = []
  const reasons: string[] = []
  const http2ProbeResult = await probeHttp2StreamChannels()
  const http2Hook =
    runtime === "node" ||
    (http2ProbeResult.error === "" && (http2ProbeResult.created || http2ProbeResult.start))
  const http2ProbeError = http2ProbeResult.error === "" ? "" : ` error=${http2ProbeResult.error}`
  lines.push(
    `http2_hook runtime=${runtime} available=${http2Hook} created=${http2ProbeResult.created} start=${http2ProbeResult.start}${http2ProbeError}`
  )
  const body = structApi.struct.object({ n: structApi.struct.string() })
  const contract = transportApi.endpoint("release.trace", "Echo", body, body)

  const finishServer = async (
    server: { stop(ctx: typeof traced): Promise<void> },
    running: Promise<unknown>
  ): Promise<void> => {
    await Promise.allSettled([server.stop(traced), running])
  }

  try {
    const httpServerTransport = nodeHttpApi.newNodeHTTPTransport()
    const server = serverApi.newServer(
      serverApi.transport(httpServerTransport),
      serverApi.address("127.0.0.1:0")
    )
    server.registerHandler(contract, (_ctx, request) => ({ n: request.n }))
    let serverError: unknown = null
    const running = server.start(traced).catch((error: unknown) => {
      serverError = error
    })
    try {
      const endpoint = await bounded(server.endpoint(traced), "http server bind")
      const lanes = [
        { transport: "http", clientTransport: httpApi.newHTTPTransport() },
        { transport: "http-node", clientTransport: nodeHttpApi.newNodeHTTPTransport() }
      ] as const
      for (const lane of lanes) {
        try {
          const client = clientApi.newClient(
            clientApi.withTransport(lane.clientTransport),
            clientApi.withEndpoint(endpoint)
          )
          try {
            const first = await measure(() =>
              bounded(
                client.call(traced, contract, { n: "1" }).then((response) => {
                  if (response.n !== "1") throw new Error(`echo mismatch ${response.n}`)
                }),
                `${lane.transport} call 1`
              )
            )
            const second = await measure(() =>
              bounded(
                client.call(traced, contract, { n: "2" }).then((response) => {
                  if (response.n !== "2") throw new Error(`echo mismatch ${response.n}`)
                }),
                `${lane.transport} call 2`
              )
            )
            const calls = [
              reportCall(lane.transport, first),
              reportCall(lane.transport, second)
            ] as const
            const firstClient = calls[0].clientSpanId
            const report: LaneReport = {
              transport: lane.transport,
              calls,
              pooled: pooledOwn(second.hits, calls[1].clientSpanId),
              connection: pooledConnection(first.hits, second.hits),
              foreign:
                firstClient !== "" &&
                second.hits.some((hit) => isSessionHook(hit.source) && hit.spanId === firstClient)
            }
            lines.push(summaryLine(config, runtime, report))
            lines.push(detailLine(config, runtime, report))
            reasons.push(...evaluate(config, runtime, report, http2Hook))
          } finally {
            await client.close(traced)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          lines.push(
            `config=${config} runtime=${runtime} transport=${lane.transport} error=${message}`
          )
          reasons.push(`${lane.transport} ${message}`)
        }
      }
      if (serverError !== null) {
        const message = serverError instanceof Error ? serverError.message : String(serverError)
        reasons.push(`http server ${message}`)
      }
    } finally {
      await finishServer(server, running)
    }

    try {
      const connectServer = connectApi.newServer(connectApi.address("127.0.0.1:0"))
      generated.registerOrderServiceHandler(connectServer, {
        getOrder(_ctx, request) {
          return { id: request.id, state: "READY" }
        },
        delete$(_ctx, request) {
          return { id: request.id, state: "DELETED" }
        },
        async *watchOrders() {
          yield { orderId: "unused", type: "CREATED", sequence: 1 }
        },
        async uploadEvents() {
          return { count: 0 }
        },
        async *syncOrders() {
          yield { orderId: "unused", type: "ACK", sequence: 1 }
        }
      })
      let connectError: unknown = null
      const connectRunning = connectServer.start(traced).catch((error: unknown) => {
        connectError = error
      })
      try {
        const endpoint = await bounded(
          Promise.resolve(connectServer.endpoint(traced)),
          "connectrpc bind"
        )
        const client = connectApi.newClient(connectApi.withEndpoint(endpoint))
        const orders = generated.newOrderServiceClient(client)
        try {
          const first = await measure(async () => {
            const response = await bounded(
              orders.getOrder(traced, { id: "1" }),
              "connectrpc call 1"
            )
            if (response.id !== "1") throw new Error(`connectrpc mismatch ${response.id}`)
          })
          const second = await measure(async () => {
            const response = await bounded(
              orders.getOrder(traced, { id: "2" }),
              "connectrpc call 2"
            )
            if (response.id !== "2") throw new Error(`connectrpc mismatch ${response.id}`)
          })
          const calls = [reportCall("connectrpc", first), reportCall("connectrpc", second)] as const
          const firstClient = calls[0].clientSpanId
          const report: LaneReport = {
            transport: "connectrpc",
            calls,
            pooled: pooledOwn(second.hits, calls[1].clientSpanId),
            connection: pooledConnection(first.hits, second.hits),
            foreign:
              firstClient !== "" &&
              second.hits.some((hit) => isSessionHook(hit.source) && hit.spanId === firstClient)
          }
          lines.push(summaryLine(config, runtime, report))
          lines.push(detailLine(config, runtime, report))
          reasons.push(...evaluate(config, runtime, report, http2Hook))
        } finally {
          await client.close(traced)
        }
        if (connectError !== null) {
          const message =
            connectError instanceof Error ? connectError.message : String(connectError)
          lines.push(`config=${config} runtime=${runtime} transport=connectrpc error=${message}`)
          reasons.push(`connectrpc ${message}`)
        }
      } finally {
        await finishServer(connectServer, connectRunning)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lines.push(`config=${config} runtime=${runtime} transport=connectrpc error=${message}`)
      reasons.push(`connectrpc ${message}`)
    }
  } finally {
    for (const undo of restore.reverse()) undo()
    diagnosticsChannel.unsubscribe("undici:client:sendHeaders", onSendHeaders)
    diagnosticsChannel.unsubscribe("undici:request:create", onRequestCreate)
    diagnosticsChannel.unsubscribe(http2CreatedChannel, onHttp2Created)
    diagnosticsChannel.unsubscribe(http2StartChannel, onHttp2Start)
    instrumentation?.disable()
    try {
      await plug.lifecycle.stop(contextApi.background())
    } catch {
      // The following await surfaces the same shutdown failure.
    }
    await lifecycle.catch(() => undefined)
    manager.disable()
  }

  for (const line of lines) console.log(line)
  if (reasons.length > 0) {
    for (const reason of reasons) console.error(reason)
    console.log(`result=fail reasons=${reasons.length}`)
    process.exitCode = 1
    return
  }
  console.log("result=pass")
}

prepareReleaseModules()
if (process.env.GO_LIKE_RELEASE_TRACEPARENT === "1") await runChild()
else await runParent()

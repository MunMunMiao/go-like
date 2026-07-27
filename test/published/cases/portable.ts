import { readFileSync } from "node:fs"

import type { PublishedBusinessCaseRegistry } from "../../../scripts/published/business-cases"
import { webNodeRuntimeModule } from "./node-services"

/** Reuses the reviewed Config public-runtime fixture behind the central published gate. */
function configRuntimeModule(): string {
  return readFileSync(
    new URL("../../../packages/config/test/runtime/published-runtime.fixture", import.meta.url),
    "utf8"
  )
}

/** Wraps one reviewed runtime fixture so multiple fixtures can share one published lane safely. */
function scopedRuntimeFixture(source: string, scopeName: string): string {
  const withoutImports = source.replace(/^import[^\n]*\n/gm, "")
  const marker = "export async function run()"
  const first = withoutImports.indexOf(marker)
  if (first < 0 || withoutImports.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${scopeName} published runtime fixture must expose exactly one run function`)
  }
  const local = withoutImports.replace(marker, "async function runFixture()")
  return `
async function ${scopeName}() {
${local}
  await runFixture()
}
`
}

/** Exercises the single go-micro-style unary Client path from the packed package. */
function alignedClientRuntimeModule(): string {
  return `
import {
  circuitBreakerMiddleware,
  closeTimeout,
  middleware,
  newClient,
  poolSize,
  poolTtl,
  withAddress,
  withDiscovery,
  withFilter,
  withRetry,
  withSelector,
  withTransport
} from "@likego/client"
import { background } from "@likego/context"
import { filterLabel, filterVersion } from "@likego/registry"
import { circuitOpen } from "@likego/resilience"

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

export async function run() {
  const events = []
  const instance = Object.freeze({
    id: "orders-a",
    name: "orders",
    version: "v1",
    metadata: Object.freeze({ zone: "a" }),
    endpoints: Object.freeze(["http://127.0.0.1:8080/"])
  })
  const endpoint = Object.freeze({ instance, url: instance.endpoints[0] })
  let discoveryRecorded = false
  function newWatcher() {
    let initial = true
    let stopped = false
    let rejectPending = null
    return Object.freeze({
      next() {
        if (stopped) return Promise.reject(new Error("watcher stopped"))
        if (initial) {
          initial = false
          return Promise.resolve(Object.freeze([instance]))
        }
        return new Promise((_resolve, reject) => { rejectPending = reject })
      },
      async stop() {
        if (stopped) return
        stopped = true
        if (rejectPending !== null) {
          const reject = rejectPending
          rejectPending = null
          reject(new Error("watcher stopped"))
        }
      }
    })
  }
  const discovery = Object.freeze({
    async getService(_ctx, name) {
      if (!discoveryRecorded) {
        discoveryRecorded = true
        events.push("discover")
      }
      requireValue(name === instance.name, "Client discovery service changed")
      return Object.freeze([instance])
    },
    async watch() { return newWatcher() }
  })
  const selector = Object.freeze({
    select(_ctx, instances) {
      events.push("select")
      requireValue(instances[0] === instance, "Client selection changed")
      return Object.freeze([endpoint, (_ctx, outcome) => {
        events.push("feedback")
        requireValue(outcome.error === null, "Client feedback changed")
      }])
    }
  })
  let sent = null
  const transport = Object.freeze({
    kind() { return "http" },
    async dial(_ctx, address) {
      events.push("dial")
      requireValue(address === endpoint.url, "Client dial address changed")
      return Object.freeze({
        async send(_ctx, message) { events.push("send"); sent = message },
        async recv() {
          events.push("recv")
          return { header: { published: "yes" }, body: new Uint8Array([9]) }
        },
        async close() { events.push("close") },
        local() { return "client" },
        remote() { return address }
      })
    }
  })
  const client = newClient(
    withDiscovery(discovery),
    withSelector(selector),
    withTransport(transport),
    closeTimeout(1_000),
    poolSize(2),
    poolTtl(0),
    middleware((next) => async (ctx, request, ...options) => {
      events.push("middleware.before")
      const response = await next(ctx, request, ...options)
      events.push("middleware.after")
      return response
    })
  )
  const response = await client.call(
    background(),
    {
      service: "orders",
      endpoint: "Orders.Get",
      message: { header: { tenant: "one" }, body: new Uint8Array([1]) }
    },
    withFilter(filterVersion("v1"), filterLabel("zone", "a")),
    withRetry({
      authorization: "idempotent",
      maxAttempts: 1,
      shouldRetry: () => false
    })
  )
  await client.close(background())
  requireValue(
    events.join(",") === "middleware.before,discover,select,dial,send,recv,feedback,middleware.after,close",
    "Client unary call order changed"
  )
  requireValue(
    sent.header["Likego-Service"] === "orders"
      && sent.header["Likego-Endpoint"] === "Orders.Get"
      && response.body[0] === 9,
    "Client unary wire changed"
  )

  const directStart = events.length
  const directClient = newClient(withTransport(transport))
  const directResponse = await directClient.call(
    background(),
    {
      service: "orders",
      endpoint: "Orders.Get",
      message: { header: {}, body: new Uint8Array() }
    },
    withAddress(endpoint.url)
  )
  await directClient.close(background())
  requireValue(
    events.slice(directStart).join(",") === "dial,send,recv,close"
      && directResponse.body[0] === 9,
    "Client direct-address call changed"
  )

  const breakerFailure = new Error("published dependency failed")
  let breakerDials = 0
  const breakerClient = newClient(
    withTransport({
      async dial() {
        breakerDials += 1
        throw breakerFailure
      }
    }),
    middleware(circuitBreakerMiddleware({
      failureThreshold: 1,
      resetTimeoutMs: 60_000
    }))
  )
  const breakerRequest = {
    service: "orders",
    endpoint: "Orders.Breaker",
    message: { header: {}, body: new Uint8Array() }
  }
  let firstBreakerFailure = null
  let secondBreakerFailure = null
  try {
    await breakerClient.call(background(), breakerRequest, withAddress(endpoint.url))
  } catch (error) {
    firstBreakerFailure = error
  }
  try {
    await breakerClient.call(background(), breakerRequest, withAddress(endpoint.url))
  } catch (error) {
    secondBreakerFailure = error
  }
  requireValue(
    firstBreakerFailure === breakerFailure
      && secondBreakerFailure === circuitOpen
      && breakerDials === 1,
    "Client operation circuit breaker changed"
  )
  await breakerClient.close(background())

  const cleanupFailure = new Error("published close failed")
  let observed = null
  const cleanupClient = newClient(
    withDiscovery(discovery),
    withSelector(selector),
    withTransport({
      kind() {
        return "http"
      },
      async dial() {
        return {
          async send() {},
          async recv() { return { header: {}, body: new Uint8Array([1]) } },
          async close() { throw cleanupFailure },
          local() { return "client" },
          remote() { return endpoint.url }
        }
      }
    })
  )
  const cleanupResponse = await cleanupClient.call(background(), {
    service: "orders",
    endpoint: "Orders.Create",
    message: { header: {}, body: new Uint8Array() }
  })
  try {
    await cleanupClient.close(background())
  } catch (error) {
    observed = error
  }
  requireValue(
    observed === cleanupFailure && cleanupResponse.body[0] === 1,
    "Client resident cleanup failure changed"
  )
}
`
}

/** Exercises the current internal unary Server without a declaration or registration DSL. */
function alignedServerRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import {
  address,
  handler,
  middleware,
  newServer,
  rateLimitMiddleware,
  transport,
  use
} from "@likego/server"
import { newTokenBucketLimiter } from "@likego/resilience"
import { decodeServiceError } from "@likego/transport/provider"

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

export async function run() {
  const events = []
  let dispatch = null
  let finish = null
  const terminal = new Promise((resolve) => { finish = resolve })
  const accepting = Promise.withResolvers()
  const listener = Object.freeze({
    addr() { return "127.0.0.1:43123" },
    accept(_ctx, next) { dispatch = next; accepting.resolve(); return terminal },
    async close() { finish() }
  })
  const implementation = Object.freeze({
    kind() { return "http" },
    init() {},
    options() {
      return Object.freeze({
        codec: null,
        logger: null,
        timeoutMs: 0,
        secure: false,
        tlsConfig: null
      })
    },
    async listen(_ctx, value) {
      requireValue(value === "127.0.0.1:0", "Server listen address changed")
      return listener
    },
    async dial() { throw new Error("Server unexpectedly dialed") },
    string() { return "published" }
  })
  const server = newServer(
    address("127.0.0.1:0"),
    transport(implementation),
    handler("orders", "get", async (_ctx, request) => {
      events.push("handler")
      return {
        header: { published: "yes" },
        body: request.body
      }
    }),
    use(
      "orders/*",
      (next) => async (ctx, request) => {
        events.push("operation.before")
        const response = await next(ctx, request)
        events.push("operation.after")
        return response
      },
      rateLimitMiddleware(newTokenBucketLimiter({
        capacity: 1,
        refillTokens: 1,
        refillIntervalMs: 60_000
      }))
    ),
    middleware((next) => async (ctx, request) => {
      events.push("global.before")
      const response = await next(ctx, request)
      events.push("global.after")
      return response
    })
  )
  const endpoint = await server.endpoint(background())
  const running = server.start(background())
  await accepting.promise
  requireValue(endpoint === "http://127.0.0.1:43123/", "Server endpoint changed")
  requireValue(typeof dispatch === "function", "Server did not publish its handler")

  let response = null
  await dispatch(background(), {
    async recv() {
      return {
        header: { "Likego-Service": "orders", "Likego-Endpoint": "get" },
        body: new Uint8Array([7])
      }
    },
    async send(_ctx, value) { response = value },
    async close() {},
    local() { return "client" },
    remote() { return "server" }
  })
  requireValue(
    response.header.published === "yes"
      && response.body[0] === 7
      && events.join(",") === "global.before,operation.before,handler,operation.after,global.after",
    "Server orders.get dispatch changed"
  )
  let denied = null
  await dispatch(background(), {
    async recv() {
      return {
        header: { "Likego-Service": "orders", "Likego-Endpoint": "get" },
        body: new Uint8Array([8])
      }
    },
    async send(_ctx, value) { denied = value },
    async close() {},
    local() { return "client" },
    remote() { return "server" }
  })
  const deniedError = decodeServiceError("unary", 200, denied.header, denied.body)
  requireValue(
    deniedError?.code === "rate_limited"
      && deniedError.status === 429
      && Number(deniedError.metadata.retryAfterMs) > 0
      && events.slice(5).join(",") === "global.before,operation.before",
    "Server rate limiter changed"
  )
  await server.stop(background())
  await running
}
`
}

/** Exercises the current Kratos-style App lifecycle and public options. */
function alignedCoreRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import {
  afterStart,
  afterStop,
  fromContext,
  beforeStart,
  beforeStop,
  endpoint,
  id,
  metadata,
  name,
  newApp,
  registrar,
  server,
  startTimeout,
  stopTimeout,
  version,
  newContext
} from "@likego/core"
import { waitForContext } from "@likego/core/lifecycle"

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

export async function run() {
  const events = []
  const registrations = []
  let stopFirst = null
  let stopSecond = null
  let markStarted = null
  const firstDone = new Promise((resolve) => { stopFirst = resolve })
  const secondDone = new Promise((resolve) => { stopSecond = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  const first = {
    async start(ctx) {
      requireValue(fromContext(ctx)?.name() === "orders", "AppInfo was not propagated")
      events.push("start:first")
      await firstDone
    },
    async stop() { events.push("stop:first"); stopFirst() }
  }
  const second = {
    async start() { events.push("start:second"); await secondDone },
    async stop() { events.push("stop:second"); stopSecond() }
  }
  const registry = {
    async register(_ctx, instance) { events.push("register"); registrations.push(instance) },
    async deregister(_ctx, instance) {
      events.push("deregister")
      requireValue(instance === registrations[0], "App deregister instance changed")
    }
  }
  const app = newApp(
    id("orders-a"),
    name("orders"),
    version("v1"),
    metadata({ zone: "a" }),
    endpoint("http://127.0.0.1:8080/"),
    registrar(registry),
    startTimeout(0),
    stopTimeout(1_000),
    beforeStart(() => { events.push("beforeStart") }),
    afterStart(() => { events.push("afterStart"); markStarted() }),
    beforeStop(() => { events.push("beforeStop") }),
    afterStop(() => { events.push("afterStop") }),
    server(first, second)
  )
  const running = app.run()
  await started
  requireValue(app.id() === "orders-a" && app.endpoint()[0] === "http://127.0.0.1:8080/", "App identity changed")
  await app.stop()
  await running
  requireValue(
    events.join(",") === "beforeStart,start:first,start:second,register,afterStart,beforeStop,deregister,stop:first,stop:second,afterStop",
    "App lifecycle order changed"
  )
  requireValue(registrations.length === 1, "App registration changed")
  requireValue(await waitForContext(background(), Promise.resolve(42)) === 42, "waitForContext changed")

  const info = fromContext(newContext(background(), app))
  requireValue(info?.id() === app.id(), "newContext changed")
}
`
}

/** Compiles the current unary Client declarations without resident or stream concepts. */
function alignedClientTypeConsumer(): string {
  return `
import { background } from "@likego/context"
import { filterLabel, filterVersion, type Discovery, type Selector } from "@likego/registry"
import type { CircuitBreakerOptions } from "@likego/resilience"
import { endpoint, type BodyCodec, type Message, type Transport } from "@likego/transport"
import {
  circuitBreakerMiddleware,
  closeTimeout,
  middleware,
  newClient,
  poolSize,
  poolTtl,
  use,
  withAddress,
  withDiscovery,
  withFilter,
  withRetry,
  withSelector,
  withTransport,
  type Call,
  type CallOption,
  type CallOptions,
  type CallRequest,
  type CallRetryOptions,
  type Client,
  type ClientMiddleware,
  type ClientOption,
  type ClientOptions
} from "@likego/client"

declare const discovery: Discovery
declare const selector: Selector
declare const transport: Transport
declare const message: Message
declare const stringCodec: BodyCodec<string>
const layer: ClientMiddleware = (next) => next
const breakerOptions: CircuitBreakerOptions = {
  failureThreshold: 3,
  resetTimeoutMs: 1_000
}
const breaker: ClientMiddleware = circuitBreakerMiddleware(breakerOptions)
const option: ClientOption = middleware(layer)
const options: ClientOptions = {
  discovery,
  selector,
  transport,
  middleware: [layer, breaker],
  operationMiddleware: new Map(),
  closeTimeoutMs: 1_000,
  poolSize: 100,
  poolTtlMs: 60_000
}
const client: Client = newClient(
  withDiscovery(discovery),
  withSelector(selector),
  withTransport(transport),
  option,
  middleware(breaker),
  use("orders/*", layer),
  closeTimeout(1_000),
  poolSize(100),
  poolTtl(60_000)
)
const request: CallRequest = { service: "orders", endpoint: "Orders.Get", message }
const call: Call = client.call
const response: Promise<Message> = call(background(), request)
const typedContract = endpoint("orders", "Get", stringCodec, stringCodec)
const typedResponse: Promise<string> = client.call(background(), typedContract, "request")
const retry: CallRetryOptions = {
  authorization: "idempotent",
  maxAttempts: 2,
  shouldRetry: (_ctx, _error, attempt) => attempt < 2
}
const callOptions: readonly CallOption[] = [
  withAddress("http://orders.internal/"),
  withFilter(filterVersion("v1"), filterLabel("zone", "a")),
  withRetry(retry)
]
const reduced: CallOptions = callOptions.reduce<CallOptions>(
  (current, option) => option(current),
  { address: null, filters: [], retry: null }
)
void [options, response, typedResponse, reduced, breaker]
`
}

/** Compiles the current internal Server declarations and functional options. */
function alignedServerTypeConsumer(): string {
  return `
import type { Context } from "@likego/context"
import type { Endpointer, Server as CoreServer } from "@likego/core"
import { newTokenBucketLimiter, type RateLimiter } from "@likego/resilience"
import type { Message, Transport } from "@likego/transport"
import {
  address,
  handler,
  listenOption,
  middleware,
  newServer,
  rateLimitMiddleware,
  transport,
  use,
  type Handler,
  type Middleware,
  type Server,
  type ServerOption,
  type ServerOptions
} from "@likego/server"

declare const implementation: Transport
const handle: Handler = async (_ctx: Context, request: Message): Promise<Message> => request
const layer: Middleware = (next) => next
const limiter: RateLimiter = newTokenBucketLimiter({
  capacity: 1,
  refillTokens: 1,
  refillIntervalMs: 1_000
})
const limited: Middleware = rateLimitMiddleware(limiter)
const options: readonly ServerOption[] = [
  address("127.0.0.1:0"),
  transport(implementation),
  handler("orders", "get", handle),
  middleware(layer),
  use("orders/*", layer, limited),
  listenOption()
]
const server: Server = newServer(...options)
const core: CoreServer = server
const endpointer: Endpointer = server
const snapshot: ServerOptions = server.options()
const operationMiddleware: ReadonlyMap<string, readonly Middleware[]> =
  snapshot.operationMiddleware
void [core, endpointer, snapshot, operationMiddleware, limited]
`
}

/** Compiles the current App, lifecycle helper, and Node signal option. */
function alignedCoreTypeConsumer(): string {
  return `
import { background, type Context } from "@likego/context"
import type { Registrar } from "@likego/registry"
import {
  endpoint,
  name,
  newApp,
  registrar,
  server,
  startTimeout,
  stopTimeout,
  type App,
  type AppHook,
  type AppInfo,
  type AppOption,
  type Endpointer,
  type Server
} from "@likego/core"
import { waitForContext } from "@likego/core/lifecycle"
import { signal } from "@likego/core/node"

declare const child: Server
declare const registry: Registrar
declare const endpointer: Endpointer
const hook: AppHook = async (_ctx: Context): Promise<void> => {}
const options: readonly AppOption[] = [
  name("orders"),
  endpoint("http://127.0.0.1:8080/"),
  registrar(registry),
  server(child),
  startTimeout(0),
  stopTimeout(1_000),
  signal()
]
const app: App = newApp(...options)
const info: AppInfo = app
const running: Promise<void> = app.run()
const stopping: Promise<void> = app.stop()
const waiting: Promise<number> = waitForContext(background(), Promise.resolve(1))
const endpointValue: string | PromiseLike<string> = endpointer.endpoint(background())
void [hook, info, running, stopping, waiting, endpointValue]
`
}

/** Exercises only the public Probe Registry API. */
function alignedHealthRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import { newProbeRegistry } from "@likego/health"

export async function run() {
  const registry = newProbeRegistry()
  const unregister = registry.register("ready", "database", async () => {})
  const ready = await registry.check(background(), "ready")
  if (!ready.ok || ready.checks.length !== 1) throw new Error("Health readiness changed")
  if (!unregister()) throw new Error("Health unregister changed")
  const empty = await registry.check(background(), "ready")
  if (empty.ok || empty.checks.length !== 0) throw new Error("empty readiness must fail closed")
}
`
}

/** Compiles the public Probe Registry declarations without App diagnostics coupling. */
function alignedHealthTypeConsumer(): string {
  return `
import { background } from "@likego/context"
import {
  newProbeRegistry,
  type Probe,
  type ProbeKind,
  type ProbeOptions,
  type ProbeRegistry,
  type ProbeReport,
  type ProbeResult
} from "@likego/health"

const kind: ProbeKind = "ready"
const probe: Probe = async (_ctx) => {}
const options: ProbeOptions = { timeoutMs: 100 }
const registry: ProbeRegistry = newProbeRegistry()
const unregister: () => boolean = registry.register(kind, "database", probe, options)
const report: Promise<ProbeReport> = registry.check(background(), kind)
const result: ProbeResult = { name: "database", ok: true, error: null }
void [unregister, report, result]
`
}

/** Runs the complete Config root contract before one independently selected subpath contract. */
function combinedConfigRuntimeModule(kind: "env" | "file" | "yaml", subpathSource: string): string {
  const subpathImports =
    kind === "env"
      ? 'import { envSource } from "@likego/config/env"'
      : kind === "file"
        ? `import * as ConfigFilePackage from "@likego/config/file"
import { fileSource, jsonFileDecoder } from "@likego/config/file"`
        : 'import { decodeYaml } from "@likego/config/yaml"'
  return `
import { background, cause, withCancelCause } from "@likego/context"
import * as ConfigPackage from "@likego/config"
import {
  newConfig,
  objectSource,
  placeholderResolver,
  resolver,
  schema as configSchema,
  source as configSource
} from "@likego/config"
${subpathImports}
${scopedRuntimeFixture(configRuntimeModule(), "runConfigRootFixture")}
${scopedRuntimeFixture(subpathSource, "runConfigSubpathFixture")}
export async function run() {
  await runConfigRootFixture()
  await runConfigSubpathFixture()
}
`
}

/** Loads the reviewed File Config public-runtime fixture for its published subpath. */
function configFileRuntimeModule(): string {
  return readFileSync(
    new URL(
      "../../../packages/config/test/runtime/file-published-runtime.fixture.ts",
      import.meta.url
    ),
    "utf8"
  )
}

/** Reuses the real Node filesystem runtime fixture behind the published subpath. */
function configNodeRuntimeModule(): string {
  const source = readFileSync(
    new URL("../../../packages/config/test/runtime/node-file-runtime.ts", import.meta.url),
    "utf8"
  )
  const boundary = source.indexOf("const directory = await ")
  if (boundary < 0) throw new Error("Config Node runtime fixture entrypoint drifted")
  const nodeRuntime = `${source.slice(0, boundary)}export async function run() {
${source.slice(boundary)}
}
`
  return `
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { background, canceled, cause, withCancelCause, withTimeout } from "@likego/context"
import * as ConfigPackage from "@likego/config"
import {
  newConfig,
  objectSource,
  placeholderResolver,
  resolver,
  schema as configSchema,
  source as configSource
} from "@likego/config"
import * as ConfigFilePackage from "@likego/config/file"
import { fileSource, jsonFileDecoder } from "@likego/config/file"
import { newNodeFileCapability } from "@likego/config/node"
${scopedRuntimeFixture(configRuntimeModule(), "runConfigRootFixture")}
${scopedRuntimeFixture(configFileRuntimeModule(), "runConfigFileFixture")}
${scopedRuntimeFixture(nodeRuntime, "runConfigNodeFixture")}

function require(condition, message) {
  if (!condition) throw new Error(message)
}

async function rejectedNodeOperation(operation) {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error("expected Node operation rejection")
}

async function openCapturedNodeWatch(changed) {
  const directory = await mkdtemp(join(tmpdir(), "likego-config-node-published-"))
  const path = join(directory, "config.json")
  await writeFile(path, "{}")
  let watcher = null
  const originalOn = EventEmitter.prototype.on
  EventEmitter.prototype.on = function captureWatcher(event, listener) {
    if (this?.constructor?.name === "FSWatcher") watcher = this
    return Reflect.apply(originalOn, this, [event, listener])
  }
  try {
    const capability = newNodeFileCapability()
    const handle = await capability.watch(background(), path, changed)
    require(watcher !== null, "Node filesystem watcher was not captured")
    return { directory, handle, watcher }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    EventEmitter.prototype.on = originalOn
  }
}

async function disposeCapturedNodeWatch(subject) {
  try {
    await subject.handle.stop(background())
  } catch {}
  try {
    await subject.handle.done()
  } catch {}
  await rm(subject.directory, { recursive: true, force: true })
}

async function exerciseNodeWatcherFailures() {
  const passiveFailure = new Error("published passive watcher failure")
  const passive = await openCapturedNodeWatch(() => {})
  try {
    passive.watcher.emit("error", passiveFailure)
    require(
      await rejectedNodeOperation(passive.handle.done()) === passiveFailure,
      "Node passive watcher failure identity changed"
    )
  } finally {
    await disposeCapturedNodeWatch(passive)
  }

  const synchronousFailure = new Error("published synchronous listener failure")
  const synchronous = await openCapturedNodeWatch(() => {
    throw synchronousFailure
  })
  try {
    synchronous.watcher.emit("change", "change", "config.json")
    require(
      await rejectedNodeOperation(synchronous.handle.done()) === synchronousFailure,
      "Node synchronous listener failure identity changed"
    )
  } finally {
    await disposeCapturedNodeWatch(synchronous)
  }

  const asynchronousFailure = new Error("published structural listener failure")
  const structural = await openCapturedNodeWatch(() => ({
    then(resolve) {
      resolve({
        then(_resolve, reject) {
          reject(asynchronousFailure)
          return Promise.resolve()
        }
      })
      return Promise.resolve()
    }
  }))
  try {
    structural.watcher.emit("change", "change", "config.json")
    require(
      await rejectedNodeOperation(structural.handle.done()) === asynchronousFailure,
      "Node structural listener failure identity changed"
    )
  } finally {
    await disposeCapturedNodeWatch(structural)
  }
}

async function exerciseNodeWatchRollback() {
  const directory = await mkdtemp(join(tmpdir(), "likego-config-node-rollback-"))
  const path = join(directory, "config.json")
  await writeFile(path, "{}")
  const cleanupFailure = new Error("published watcher rollback close failure")
  let errorReads = 0
  let watcher = null
  const cancellationContext = {
    deadline() { return [new Date(0), false] },
    done() { return null },
    err() {
      errorReads += 1
      return errorReads === 1 ? null : canceled
    },
    value() { return null }
  }
  const originalOn = EventEmitter.prototype.on
  EventEmitter.prototype.on = function captureRollbackWatcher(event, listener) {
    if (watcher === null && this?.constructor?.name === "FSWatcher") {
      watcher = this
      const originalClose = this.close
      this.close = function closeThenFail() {
        Reflect.apply(originalClose, this, [])
        throw cleanupFailure
      }
    }
    return Reflect.apply(originalOn, this, [event, listener])
  }
  try {
    const capability = newNodeFileCapability()
    const failure = await rejectedNodeOperation(
      capability.watch(cancellationContext, path, () => {})
    )
    require(
      failure instanceof AggregateError
        && failure.errors[0] === canceled
        && failure.errors[1] === cleanupFailure,
      "Node watcher cancellation rollback failure order changed"
    )
  } finally {
    EventEmitter.prototype.on = originalOn
    await rm(directory, { recursive: true, force: true })
  }
}

export async function run() {
  await runConfigRootFixture()
  await runConfigFileFixture()
  await runConfigNodeFixture()
  await exerciseNodeWatcherFailures()
  await exerciseNodeWatchRollback()
}
`
}

/** Exercises the Node-only Core runtime without importing Node types into portable lanes. */
function coreNodeRuntimeModule(): string {
  return `
import process from "node:process"
import { server, newApp } from "@likego/core"
import { signal } from "@likego/core/node"

export async function run() {
  const previousExitCode = process.exitCode
  const previousListeners = process.listenerCount("SIGUSR2")
  let finish = null
  const terminal = new Promise((resolve) => { finish = resolve })
  const app = newApp(
    signal("SIGUSR2"),
    server({
      async start() { await terminal },
      async stop() { finish() }
    })
  )
  const running = app.run()
  while (process.listenerCount("SIGUSR2") === previousListeners) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  process.emit("SIGUSR2")
  await running
  if (typeof process.exitCode !== "number" || process.exitCode <= 128) {
    throw new Error("Node signal option did not set a conventional exit code")
  }
  process.exitCode = previousExitCode ?? 0
}
`
}

/** Keeps the Env Config public-runtime contract independent from the root Config fixture. */
function configEnvRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import { envSource } from "@likego/config/env"

function require(condition, message) {
  if (!condition) throw new Error(message)
}

export async function run() {
  const source = envSource({
    APP_HTTP__HOST: "127.0.0.1",
    APP_HTTP__PORT: "8080",
    OTHER_VALUE: "ignored",
    APP_UNDEFINED: undefined
  }, {
    name: "published-env",
    prefix: "APP_",
    decode(value, name) { return name.endsWith("PORT") ? Number(value) : value }
  })
  const loaded = await source.load(background())
  require(source.name === "published-env", "environment source name changed")
  require(loaded.value.http.host === "127.0.0.1" && loaded.value.http.port === 8080, "environment mapping changed")

  const composite = envSource({ VALUE: "composite" }, {
    decode() { return [null, true, 7, "text", { nested: [] }] }
  })
  require(Array.isArray((await composite.load(background())).value.value), "composite value changed")
  const defaults = envSource({ VALUE: "raw" })
  require((await defaults.load(background())).value.value === "raw", "default environment decoding changed")
  const preservedCase = envSource({ SERVICE_DB_PORT: "5432" }, {
    prefix: "SERVICE_",
    separator: "_",
    lowercase: false
  })
  require((await preservedCase.load(background())).value.DB.PORT === "5432", "case-preserving mapping changed")
  const emptySuffix = envSource({ APP_: "ignored", APP_VALUE: "selected" }, { prefix: "APP_" })
  require((await emptySuffix.load(background())).value.value === "selected", "empty suffix handling changed")

  for (const make of [
    () => envSource(null),
    () => envSource({}, { name: "" }),
    () => envSource({}, { prefix: 1 }),
    () => envSource({}, { separator: "" }),
    () => envSource({}, { lowercase: "yes" }),
    () => envSource({}, { decode: "no" }),
    () => envSource({ APP_HTTP: "scalar", APP_HTTP__PORT: "8080" }, { prefix: "APP_" }),
    () => envSource({ APP_HTTP__PORT: "8080", APP_http__port: "9000" }, { prefix: "APP_" }),
    () => envSource({ APP_HTTP____PORT: "bad" }, { prefix: "APP_" }),
    () => envSource({ APP___PROTO__: "bad" }, { prefix: "APP_", separator: "." }),
    () => envSource({ VALUE: 1 })
  ]) {
    let rejected = false
    try { make() } catch { rejected = true }
    require(rejected, "invalid environment input accepted")
  }

  const cyclic = []
  cyclic.push(cyclic)
  const sparse = []
  sparse.length = 1
  const decorated = []
  Object.defineProperty(decorated, "extra", { enumerable: true, value: "bad" })
  const accessor = ["placeholder"]
  Object.defineProperty(accessor, "0", { enumerable: true, get() { return "bad" } })
  const hiddenIndex = ["placeholder"]
  Object.defineProperty(hiddenIndex, "0", { enumerable: false, value: "bad" })
  const symbolArray = []
  Object.defineProperty(symbolArray, Symbol("extra"), { enumerable: true, value: "bad" })
  const unsafe = Object.defineProperty({}, "__proto__", { enumerable: true, value: "bad" })
  const hiddenObject = Object.defineProperty({}, "hidden", { enumerable: false, value: "bad" })
  const accessorObject = Object.defineProperty({}, "value", { enumerable: true, get() { return "bad" } })
  const symbolObject = Object.defineProperty({}, Symbol("secret"), { enumerable: true, value: "bad" })
  const values = [
    cyclic,
    sparse,
    decorated,
    accessor,
    hiddenIndex,
    symbolArray,
    Number.NaN,
    undefined,
    Object.setPrototypeOf({}, {}),
    unsafe,
    hiddenObject,
    accessorObject,
    symbolObject
  ]
  for (const value of values) {
    let rejected = false
    try { envSource({ VALUE: "bad" }, { decode() { return value } }) } catch { rejected = true }
    require(rejected, "unsafe decoded value accepted")
  }
  const nullPrototype = Object.create(null)
  nullPrototype.value = "accepted"
  require((await envSource({ VALUE: "plain" }, { decode() { return nullPrototype } }).load(background())).value.value.value === "accepted", "null-prototype value changed")

  const accessorEnvironment = Object.defineProperty({}, "VALUE", {
    enumerable: true,
    get() { return "hidden" }
  })
  let accessorRejected = false
  try { envSource(accessorEnvironment) } catch { accessorRejected = true }
  require(accessorRejected, "environment accessor accepted")
}
`
}

/** Exercises the complete strict YAML decoder through its published subpath. */
function configYamlRuntimeModule(): string {
  return `
import { decodeYaml } from "@likego/config/yaml"

function require(condition, message) {
  if (!condition) throw new Error(message)
}

export async function run() {
  const decoded = decodeYaml("service:\\n  name: 配置服务\\n  enabled: true\\n  ports: [8080, 8443]\\n  releasedAt: 2026-07-21T08:30:00Z\\n")
  require(decoded.service.name === "配置服务", "YAML Unicode value changed")
  require(decoded.service.releasedAt === "2026-07-21T08:30:00Z", "YAML timestamp coercion changed")
  for (const invalid of [
    "",
    "value\\n",
    "- one\\n- two\\n",
    "one: 1\\n---\\ntwo: 2\\n",
    "one: 1\\none: 2\\n",
    "one: !custom value\\n",
    "one: &value { nested: true }\\ntwo: *value\\n",
    "nested:\\n  __proto__: unsafe\\n",
    "one: 9007199254740992\\n",
    "one: .inf\\n",
    "one: .nan\\n"
  ]) {
    let rejected = false
    try { decodeYaml(invalid) } catch { rejected = true }
    require(rejected, "invalid YAML was accepted")
  }
}
`
}

/** Provides the complete root Config public type consumer for its published lane. */
function configRootTypeConsumer(): string {
  return `
import { background, type Context } from "@likego/context"
import {
  newConfig,
  objectSource,
  onReloadError,
  onTerminalError,
  placeholderResolver,
  resolver as configResolver,
  schema as configSchema,
  source as configSource,
  type Config,
  type ConfigAlreadyLoadedError,
  type ConfigNotFoundError,
  type ConfigObject,
  type ConfigOption,
  type ConfigReloadErrorHandler,
  type ConfigResolver,
  type ConfigScalar,
  type ConfigSchema,
  type ConfigSource,
  type ConfigSourceError,
  type ConfigSourceSnapshot,
  type ConfigSourceWatcher,
  type ConfigTerminalErrorHandler,
  type ConfigValidationError,
  type ConfigValue,
  type Observer,
  type Value
} from "@likego/config"

const context: Context = background()
const source: ConfigSource = objectSource("published", { value: 1 })
const sourceOption: ConfigOption = configSource(source)
const placeholders: ConfigResolver = placeholderResolver()
const resolverOption: ConfigOption = configResolver(placeholders)
const config: Config = newConfig(sourceOption, resolverOption)
const loaded: Promise<void> = config.load(context)
const closing: Promise<void> = config.close(context)
const current: Value = config.value("value")
const observer: Observer = (_key, _value) => {}
const watched: void = config.watch("value", observer)
const reload: ConfigReloadErrorHandler = (_error, _current) => {}
const reloadOption: ConfigOption = onReloadError(reload)
const terminal: ConfigTerminalErrorHandler = async (_error) => {}
const terminalOption: ConfigOption = onTerminalError(terminal)
const scalar: ConfigScalar = "value"
const value: ConfigValue = { scalar }
const schema: ConfigSchema<{ readonly ready: boolean }> = {
  "~standard": {
    version: 1,
    vendor: "published",
    validate(_input) { return { value: { ready: true } } }
  }
}
const schemaOption: ConfigOption<{ readonly ready: boolean }> = configSchema(schema)
const transformed = newConfig(configSource(source), schemaOption)
const transformedLoad: Promise<void> = transformed.load(context)
const scanned: Promise<{ readonly ready: boolean }> = config.scan(context, schema)
declare const watcher: ConfigSourceWatcher
const watcherNext: Promise<void> = watcher.next(context)
const watcherStop: Promise<void> = watcher.stop(context)
const sourceSnapshot: Promise<ConfigSourceSnapshot> = source.load(context)
declare const alreadyLoaded: ConfigAlreadyLoadedError
declare const notFound: ConfigNotFoundError
declare const sourceError: ConfigSourceError
declare const validationError: ConfigValidationError
void [loaded, closing, current, watched, reload, reloadOption, terminal, terminalOption, value, transformedLoad, scanned, watcherNext, watcherStop, sourceSnapshot, alreadyLoaded, notFound, sourceError, validationError]
`
}

/** Provides the complete Env Config public type consumer for its published lane. */
function configEnvTypeConsumer(): string {
  return `
import {
  envSource,
  type EnvironmentRecord,
  type EnvSourceOptions,
  type EnvValueDecoder
} from "@likego/config/env"
import type { ConfigSource, ConfigValue } from "@likego/config"

const environment: EnvironmentRecord = { APP_VALUE: "published" }
const decode: EnvValueDecoder = (value, _name, _path): ConfigValue => value
const options: EnvSourceOptions = { prefix: "APP_", decode }
const source: ConfigSource = envSource(environment, options)
void source
`
}

/** Provides the complete File Config public type consumer for its published lane. */
function configFileTypeConsumer(): string {
  return `
import type { ConfigSource } from "@likego/config"
import { background, type Context } from "@likego/context"
import {
  fileSource,
  jsonFileDecoder,
  type FileCapability,
  type FileChangeListener,
  type FileDecoder,
  type FileReadResult,
  type FileSourceOptions,
  type FileWatcher
} from "@likego/config/file"

declare const watcher: FileWatcher
const changed: FileChangeListener = () => {}
const readResult: FileReadResult = { text: "{}", revision: "v1" }
const capability: FileCapability = {
  async read(ctx: Context, path: string) { void ctx; void path; return readResult },
  async watch(ctx, path, listener) {
    void ctx; void path; listener(); changed()
    return watcher
  }
}

const decoder: FileDecoder = jsonFileDecoder
const options: FileSourceOptions = {
  name: "application-file",
  decode: decoder
}
const source: ConfigSource = fileSource(capability, "/config.json", options)
const terminal: Promise<void> = watcher.done()
const stopped: Promise<void> = watcher.stop(background())
void [source, terminal, stopped]
`
}

/** Reuses the public Node filesystem type authority through installed package imports. */
function configNodeTypeConsumer(): string {
  return readFileSync(
    new URL("../../../packages/config/test/node-public-types.ts", import.meta.url),
    "utf8"
  )
    .replaceAll('from "../src/file"', 'from "@likego/config/file"')
    .replaceAll('from "../src/node"', 'from "@likego/config/node"')
}

/** Lets the registry validate every Config export while per-export consumers prove behavior. */
function configExportInventoryTypeConsumer(): string {
  return `
import * as configRoot from "@likego/config"
import * as configEnv from "@likego/config/env"
import * as configFile from "@likego/config/file"
import * as configNode from "@likego/config/node"
import * as configYaml from "@likego/config/yaml"
void [configRoot, configEnv, configFile, configNode, configYaml]
`
}

/** Proves the strict YAML decoder retains its text-to-object public contract. */
function configYamlTypeConsumer(): string {
  return `
import type { ConfigObject } from "@likego/config"
import { decodeYaml } from "@likego/config/yaml"
const decoded: ConfigObject = decodeYaml("service:\\n  enabled: true\\n")
void decoded
// @ts-expect-error YAML input is source text, not a pre-parsed carrier.
decodeYaml({ service: true })
`
}

/** Registers published cases for portable kernels and their smallest portable adapters. */
export function registerPortableCases(registry: PublishedBusinessCaseRegistry): void {
  registry.register({
    package: "@likego/context",
    exports: ["."],
    runtimeModule: `
import {
  afterFunc,
  background,
  canceled,
  cause,
  deadlineExceeded,
  todo,
  withCancel,
  withCancelCause,
  withDeadline,
  withDeadlineCause,
  withoutCancel,
  withTimeout,
  withTimeoutCause,
  withValue
} from "@likego/context"

function require(condition, message) {
  if (!condition) throw new Error(message)
}

function rejects(invoke, expected) {
  let observed = null
  try { invoke() } catch (error) { observed = error }
  require(observed !== null, "expected Context boundary failure")
  if (expected !== undefined) require(observed === expected || observed instanceof expected, "Context failure identity changed")
}

function rootLike(deadline = null, signal = null, error = null) {
  return {
    deadline() { return deadline === null ? [new Date(0), false] : [deadline, true] },
    done() { return signal },
    err() { return error },
    value() { return null }
  }
}

function delegateContext(delegate) {
  const controller = new AbortController()
  return {
    deadline() { return [new Date(-62135596800000), false] },
    done() { return controller.signal },
    err() { return null },
    value() { return null },
    afterFunc: delegate
  }
}

async function tick() {
  await Promise.resolve()
}

const originalDateNow = Date.now
const originalPerformanceNow = performance.now
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

function restoreClock() {
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: originalDateNow })
  Object.defineProperty(performance, "now", { configurable: true, writable: true, value: originalPerformanceNow })
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: originalSetTimeout })
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: originalClearTimeout })
}

function setClock(wall, monotonic) {
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: wall })
  Object.defineProperty(performance, "now", { configurable: true, writable: true, value: monotonic })
}

function timerHarness(options = {}) {
  const callbacks = []
  const delays = []
  const cleared = []
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value(callback, delay) {
      if (options.failure) throw options.failure
      delays.push(delay ?? 0)
      callbacks.push(callback)
      const id = callbacks.length
      if (options.immediate) callback()
      return id
    }
  })
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value(id) {
      cleared.push(id)
      if (options.clearFailure) throw options.clearFailure
    }
  })
  return {
    delays,
    cleared,
    fire(index) {
      const callback = callbacks[index]
      require(typeof callback === "function", "timer callback missing")
      callback()
    }
  }
}

export async function run() {
  require(Object.isFrozen(canceled) && Object.isFrozen(deadlineExceeded), "Context sentinels are mutable")
  require(deadlineExceeded.timeout() && deadlineExceeded.temporary(), "deadline predicates changed")
  require(background() === background() && todo() === todo() && background() !== todo(), "root Context identity changed")
  for (const root of [background(), todo()]) {
    const firstDeadline = root.deadline()
    const secondDeadline = root.deadline()
    require(
      !firstDeadline[1]
      && firstDeadline[0].toISOString() === "0001-01-01T00:00:00.000Z"
      && firstDeadline[0] !== secondDeadline[0]
      && root.done() === null
      && root.err() === null
      && root.value("missing") === null,
      "root Context changed"
    )
  }

  const key = {}
  const valued = withValue(withValue(background(), key, "parent"), key, "child")
  require(valued.value(key) === "child" && valued.value({}) === null, "Context value lookup changed")
  const [valuedParent, cancelValuedParent] = withCancelCause(withValue(background(), "name", "value"))
  const inheritedValue = withValue(valuedParent, "child", "present")
  const detached = withoutCancel(inheritedValue)
  const detachedCause = new Error("detached")
  cancelValuedParent(detachedCause)
  require(inheritedValue.err() === canceled && cause(inheritedValue) === detachedCause, "value cancellation changed")
  require(detached.value("name") === "value" && !detached.deadline()[1] && detached.done() === null && detached.err() === null && cause(detached) === null, "withoutCancel changed")
  const detachedValue = withValue(detached, "detached-child", true)
  require(
    !detachedValue.deadline()[1]
    && detachedValue.done() === null
    && detachedValue.err() === null
    && detachedValue.value("detached-child") === true,
    "value over withoutCancel changed"
  )
  const deadlineValue = withValue(rootLike(new Date(1234)), "deadline", true)
  require(deadlineValue.deadline()[0].getTime() === 1234, "value deadline delegation changed")

  const [wrappedInner, cancelWrappedInner] = withCancelCause(background())
  const wrapped = {
    deadline() { return wrappedInner.deadline() },
    done() { return wrappedInner.done() },
    err() { return wrappedInner.err() },
    value(key) { return wrappedInner.value(key) }
  }
  const [wrappedChild] = withCancel(wrapped)
  const wrappedCause = new Error("wrapped")
  cancelWrappedInner(wrappedCause)
  require(cause(wrapped) === wrappedCause && cause(wrappedChild) === wrappedCause, "structural wrapper cause changed")
  require(cause(withoutCancel(wrapped)) === null, "withoutCancel structural cause barrier changed")
  let suppressedValueReads = 0
  const suppressedWrapper = {
    deadline() { return wrappedInner.deadline() },
    done() { return null },
    err() { return null },
    value(key) { suppressedValueReads += 1; return wrappedInner.value(key) }
  }
  require(cause(suppressedWrapper) === null && suppressedValueReads === 0, "outer Err cause gate changed")

  const barrierObserved = new Error("barrier observed")
  const barrierWrapper = {
    deadline() { return detached.deadline() },
    done() { return detached.done() },
    err() { return barrierObserved },
    value(key) { return detached.value(key) }
  }
  require(cause(barrierWrapper) === barrierObserved, "withoutCancel private cause barrier changed")

  const [activeCarrier, cancelActiveCarrier] = withCancel(background())
  const activeCarrierObserved = new Error("active carrier observed")
  const activeCarrierWrapper = {
    deadline() { return activeCarrier.deadline() },
    done() { return activeCarrier.done() },
    err() { return activeCarrierObserved },
    value(key) { return activeCarrier.value(key) }
  }
  require(cause(activeCarrierWrapper) === activeCarrierObserved, "active private cause fallback changed")
  cancelActiveCarrier()

  const [reentrantParent, cancelReentrantParent] = withCancelCause(background())
  const reentrantCause = new Error("reentrant parent")
  let reentrantChildState = null
  reentrantParent.done().addEventListener("abort", () => {
    const reentrantChild = withCancel(reentrantParent)[0]
    reentrantChildState = {
      aborted: reentrantChild.done().aborted,
      err: reentrantChild.err(),
      cause: cause(reentrantChild)
    }
  }, { once: true })
  cancelReentrantParent(reentrantCause)
  require(
    reentrantChildState !== null
    && reentrantChildState.aborted
    && reentrantChildState.err === canceled
    && reentrantChildState.cause === reentrantCause,
    "reentrant parent cancellation inheritance changed"
  )

  const [outerCancellation, cancelOuterCancellation] = withCancel(background())
  const [nestedCancellation, cancelNestedCancellation] = withCancel(background())
  const nestedCancellationChild = withCancel(nestedCancellation)[0]
  let nestedStateAtReturn = null
  outerCancellation.done().addEventListener("abort", () => {
    cancelNestedCancellation()
    nestedStateAtReturn = nestedCancellationChild.err()
  }, { once: true })
  cancelOuterCancellation()
  require(
    nestedStateAtReturn === canceled && nestedCancellationChild.err() === canceled,
    "nested independent cancellation boundary changed"
  )

  const [queuedParent, cancelQueuedParent] = withCancelCause(background())
  const [queuedChild, cancelQueuedChild] = withCancelCause(queuedParent)
  const queuedParentCause = new Error("queued parent")
  const reentrantChildCause = new Error("reentrant child")
  let reentrantChildAtReturn = null
  queuedParent.done().addEventListener("abort", () => {
    cancelQueuedChild(reentrantChildCause)
    reentrantChildAtReturn = {
      err: queuedChild.err(),
      cause: cause(queuedChild)
    }
  }, { once: true })
  cancelQueuedParent(queuedParentCause)
  require(
    reentrantChildAtReturn !== null
    && reentrantChildAtReturn.err === canceled
    && reentrantChildAtReturn.cause === reentrantChildCause
    && cause(queuedChild) === reentrantChildCause,
    "queued parent propagation replaced a reentrant child cause"
  )

  const propagationSignal = new AbortController().signal
  const [cleanupReentryRoot, cancelCleanupReentryRoot] = withCancel(background())
  const cleanupReentryChild = withCancel(cleanupReentryRoot)[0]
  let propagationChild = null
  let propagationCleanupState = null
  let cleanupReentryStateAtReturn = null
  const cleanupEvents = []
  const propagationParent = {
    deadline: background().deadline,
    done() { return propagationSignal },
    err() { return null },
    value() { return null },
    afterFunc() {
      return () => {
        cleanupEvents.push("parent-cleanup-start")
        cancelCleanupReentryRoot()
        cleanupReentryStateAtReturn = cleanupReentryChild.err()
        propagationCleanupState = propagationChild === null ? null : propagationChild.err()
        cleanupEvents.push("parent-cleanup-end")
        return true
      }
    }
  }
  const propagationRootTuple = withCancel(propagationParent)
  propagationChild = withCancel(propagationRootTuple[0])[0]
  propagationRootTuple[1]()
  require(
    propagationCleanupState === canceled
    && propagationChild.err() === canceled
    && cleanupReentryStateAtReturn === canceled
    && cleanupEvents.join(",") === "parent-cleanup-start,parent-cleanup-end",
    "parent cleanup cancellation order changed"
  )

  const deepKey = {}
  let deep = withValue(background(), deepKey, "retained")
  for (let index = 0; index < 20000; index += 1) deep = withValue(deep, {}, index)
  require(
    !deep.deadline()[1]
    && deep.done() === null
    && deep.err() === null
    && deep.value(deepKey) === "retained"
    && deep.value({}) === null
    && cause(deep) === null,
    "deep built-in Context chain changed"
  )
  const [deepChild, cancelDeepChild] = withCancel(deep)
  require(!deepChild.deadline()[1] && deepChild.err() === null, "deep cancel descendant changed")
  cancelDeepChild()

  const [deepCancelRoot, cancelDeepCancelRoot] = withCancelCause(background())
  const deepCancellationCause = new Error("deep cancellation")
  let deepCancelTail = deepCancelRoot
  for (let index = 0; index < 20000; index += 1) {
    const next = withCancel(deepCancelTail)
    deepCancelTail = next[0]
  }
  cancelDeepCancelRoot(deepCancellationCause)
  require(
    deepCancelTail.done().aborted
    && deepCancelTail.err() === canceled
    && cause(deepCancelTail) === deepCancellationCause,
    "deep built-in cancellation propagation changed"
  )

  const [parent, cancelParent] = withCancelCause(background())
  const [child, cancelChild] = withCancel(parent)
  const childSignal = child.done()
  const firstCause = new Error("first")
  cancelChild()
  cancelChild()
  require(child.err() === canceled && cause(child) === canceled && parent.err() === null, "child cancellation changed")
  require(childSignal !== null && childSignal.aborted && childSignal.reason === canceled, "canceled signal reason changed")
  cancelParent(firstCause)
  cancelParent(new Error("second"))
  require(cause(parent) === firstCause, "first parent cause changed")
  const [alreadyChild] = withCancel(parent)
  require(alreadyChild.err() === canceled && cause(alreadyChild) === firstCause, "already-canceled ancestry changed")
  const [nullCause, cancelNull] = withCancelCause(background())
  cancelNull(null)
  require(cause(nullCause) === canceled, "null cancel cause changed")

  const externalFailure = new Error("external")
  require(cause(rootLike(null, null, externalFailure)) === externalFailure, "external cause fallback changed")
  const opaqueCarrier = {}
  const opaqueContext = rootLike(null, new AbortController().signal, externalFailure)
  opaqueContext.value = () => opaqueCarrier
  require(cause(opaqueContext) === externalFailure, "opaque structural cause carrier impersonated a local Context")
  require(afterFunc(opaqueContext, () => {})(), "opaque structural carrier changed signal stopping")
  const callableParent = function () {}
  callableParent.deadline = () => [new Date(0), false]
  callableParent.done = () => null
  callableParent.err = () => null
  callableParent.value = () => "callable"
  const [callableChild, cancelCallable] = withCancel(callableParent)
  require(callableChild.value("x") === "callable", "callable Context changed")
  cancelCallable()

  for (const invalid of [null, undefined, {}, { deadline() {}, done() {}, err() {} }]) {
    rejects(() => withCancel(invalid), TypeError)
    rejects(() => withValue(invalid, "key", "value"), TypeError)
    rejects(() => withoutCancel(invalid), TypeError)
  }
  rejects(() => withValue(background(), null, "value"), TypeError)
  rejects(() => withValue(background(), undefined, "value"), TypeError)
  const base = background()
  for (const tuple of [{}, [new Date(0)], [new Date(0), "yes"]]) {
    const invalidDeadlineParent = { deadline: () => tuple, done: base.done, err: base.err, value: base.value }
    const [lazyChild, cancelLazyChild] = withCancel(invalidDeadlineParent)
    require(lazyChild.deadline() === tuple, "withCancel eagerly inspected parent deadline")
    cancelLazyChild()
    rejects(() => withDeadline(invalidDeadlineParent, new Date(Date.now() + 1000)), TypeError)
  }
  rejects(() => withDeadline({ deadline: () => [{}, true], done: base.done, err: base.err, value: base.value }, new Date(Date.now() + 1000)), TypeError)
  rejects(() => withDeadline({ deadline: () => [new Date(Number.NaN), true], done: base.done, err: base.err, value: base.value }, new Date(Date.now() + 1000)), RangeError)
  for (const signal of [1, {}, { aborted: false, addEventListener() {} }, { aborted: false, removeEventListener() {} }]) {
    rejects(() => withCancel({ deadline: base.deadline, done: () => signal, err: base.err, value: base.value }), TypeError)
  }

  let removals = 0
  const removalSignal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() { removals += 1; throw new Error("remove") }
  }
  const [removedChild, removeChild] = withCancelCause(rootLike(null, removalSignal, null))
  removeChild(firstCause)
  removeChild(new Error("ignored"))
  require(removals === 1 && cause(removedChild) === firstCause, "parent listener cleanup changed")

  const registrationFailure = new Error("registration")
  for (const removalThrows of [false, true]) {
    let removed = 0
    const signal = {
      aborted: false,
      addEventListener() { throw registrationFailure },
      removeEventListener() { removed += 1; if (removalThrows) throw new Error("remove") }
    }
    rejects(() => withCancel(rootLike(null, signal, null)), registrationFailure)
    require(removed === 1, "failed registration listener leaked")
  }

  let syncRemovals = 0
  const synchronousSignal = {
    aborted: false,
    addEventListener(_type, listener) { listener.call(synchronousSignal, new Event("abort")) },
    removeEventListener() { syncRemovals += 1 }
  }
  const [syncChild] = withCancel(rootLike(null, synchronousSignal, canceled))
  require(syncChild.err() === canceled && syncRemovals === 1, "synchronous parent cancellation changed")

  let abortedReads = 0
  const racingSignal = {
    get aborted() { abortedReads += 1; return abortedReads >= 3 },
    addEventListener() {},
    removeEventListener() {}
  }
  const [racingChild] = withCancel(rootLike(null, racingSignal, canceled))
  require(racingChild.err() === canceled, "post-registration race changed")

  const alreadyAbortedSignal = {
    aborted: true,
    addEventListener() {},
    removeEventListener() {}
  }
  const [deadlineParentChild] = withCancel(rootLike(null, alreadyAbortedSignal, deadlineExceeded))
  require(deadlineParentChild.err() === deadlineExceeded && cause(deadlineParentChild) === deadlineExceeded, "deadline parent propagation changed")
  const [fallbackParentChild] = withCancel(rootLike(null, alreadyAbortedSignal, null))
  require(fallbackParentChild.err() === canceled && cause(fallbackParentChild) === canceled, "null parent failure fallback changed")

  let propagationCallback = null
  let propagationStops = 0
  const delegatedPropagationParent = delegateContext((callback) => {
    propagationCallback = callback
    return () => { propagationStops += 1; return true }
  })
  const [propagatedChild] = withCancel(delegatedPropagationParent)
  propagationCallback()
  require(propagatedChild.err() === canceled, "custom parent afterFunc propagation changed")
  const [unregisteredChild, cancelUnregisteredChild] = withCancel(delegatedPropagationParent)
  cancelUnregisteredChild()
  require(unregisteredChild.err() === canceled && propagationStops === 1, "custom parent afterFunc unregister changed")

  let calls = 0
  const [afterContext, cancelAfter] = withCancel(background())
  const stopAfter = afterFunc(afterContext, () => { calls += 1 })
  cancelAfter()
  require(!stopAfter(), "admitted afterFunc stopped")
  await tick()
  require(calls === 1 && !stopAfter(), "afterFunc admission changed")

  const [stoppedContext, cancelStopped] = withCancel(background())
  const stopFirst = afterFunc(stoppedContext, () => { calls += 1 })
  require(stopFirst() && !stopFirst(), "afterFunc stop is not one-shot")
  cancelStopped()
  await tick()
  require(calls === 1, "stopped afterFunc executed")

  const [preCanceled, cancelPreCanceled] = withCancel(background())
  cancelPreCanceled()
  const preCanceledStop = afterFunc(preCanceled, () => { calls += 1 })
  require(!preCanceledStop(), "pre-canceled afterFunc stopped")
  await tick()
  require(calls === 2, "pre-canceled afterFunc missing")

  const rootStop = afterFunc(background(), () => { calls += 1 })
  require(rootStop() && !rootStop(), "root afterFunc stop changed")
  rejects(() => afterFunc(null, () => {}), TypeError)
  rejects(() => afterFunc(background(), null), TypeError)

  let signalListener = null
  let signalRemovals = 0
  const hostileSignal = {
    aborted: false,
    addEventListener(_type, listener) { signalListener = listener },
    removeEventListener() { signalRemovals += 1; throw new Error("remove") }
  }
  const hostileStop = afterFunc(rootLike(null, hostileSignal, null), () => { calls += 1 })
  signalListener.call(hostileSignal, new Event("abort"))
  signalListener.call(hostileSignal, new Event("abort"))
  require(!hostileStop(), "hostile signal afterFunc stopped")
  await tick()
  require(signalRemovals === 1 && calls === 3, "hostile signal afterFunc changed")

  for (const removalThrows of [false, true]) {
    let removed = 0
    const signal = {
      aborted: false,
      addEventListener() { throw registrationFailure },
      removeEventListener() { removed += 1; if (removalThrows) throw new Error("remove") }
    }
    rejects(() => afterFunc(rootLike(null, signal, null), () => {}), registrationFailure)
    require(removed === 1, "afterFunc registration cleanup changed")
  }

  const synchronousAfterSignal = {
    aborted: false,
    addEventListener(_type, listener) { listener.call(synchronousAfterSignal, new Event("abort")) },
    removeEventListener() {}
  }
  const synchronousAfterStop = afterFunc(rootLike(null, synchronousAfterSignal, null), () => { calls += 1 })
  require(!synchronousAfterStop(), "synchronous afterFunc admission stopped")
  await tick()
  require(calls === 4, "synchronous afterFunc admission missing")

  let afterAbortedReads = 0
  let afterRaceCalls = 0
  const afterRaceSignal = {
    get aborted() { afterAbortedReads += 1; return afterAbortedReads >= 3 },
    addEventListener() {},
    removeEventListener() {}
  }
  const afterRaceStop = afterFunc(rootLike(null, afterRaceSignal, canceled), () => { afterRaceCalls += 1 })
  require(!afterRaceStop(), "post-registration afterFunc race stopped")
  await tick()
  require(afterRaceCalls === 1, "post-registration afterFunc race changed")

  let delegatedCallback = null
  const delegated = delegateContext((callback) => { delegatedCallback = callback; return () => true })
  const delegatedStop = afterFunc(delegated, () => { calls += 1 })
  require(delegatedStop() && !delegatedStop(), "delegated stop changed")
  delegatedCallback()
  await tick()
  require(calls === 4, "stale delegated callback executed")

  const buffered = delegateContext((callback) => { callback(); callback(); return () => false })
  const bufferedStop = afterFunc(buffered, () => { calls += 1 })
  require(!bufferedStop(), "buffered admission stopped")
  await tick()
  require(calls === 5, "buffered delegated callback changed")

  const declinedStop = afterFunc(delegateContext(() => () => false), () => { calls += 1 })
  require(!declinedStop(), "declined delegated stop changed")

  let duringStop = null
  const duringStopContext = delegateContext((callback) => {
    duringStop = callback
    return () => { duringStop(); return true }
  })
  require(!afterFunc(duringStopContext, () => { calls += 1 })(), "delegate stop beat synchronous admission")
  await tick()
  require(calls === 6, "delegate stop admission missing")

  rejects(() => afterFunc(delegateContext((callback) => { callback(); throw registrationFailure }), () => {}), registrationFailure)
  rejects(() => afterFunc(delegateContext((callback) => { callback(); return null }), () => {}), TypeError)
  await tick()

  let getterReads = 0
  const accessorFailure = new Error("accessor")
  const accessorContext = rootLike(null, new AbortController().signal, null)
  Object.defineProperty(accessorContext, "afterFunc", { get() { getterReads += 1; throw accessorFailure } })
  rejects(() => afterFunc(accessorContext, () => {}), accessorFailure)
  require(getterReads === 1, "afterFunc accessor lookup changed")
  const propertyFailure = new Error("property")
  const proxyContext = new Proxy(rootLike(null, new AbortController().signal, null), {
    get(target, property, receiver) {
      if (property === "afterFunc") throw propertyFailure
      return Reflect.get(target, property, receiver)
    }
  })
  rejects(() => afterFunc(proxyContext, () => {}), propertyFailure)

  try {
    const requestedMonotonic = [10, 110]
    setClock(() => 1000, () => requestedMonotonic.shift() ?? 110)
    let timers = timerHarness()
    const requestedCause = new Error("deadline cause")
    const [requested, cancelRequested] = withDeadlineCause(background(), new Date(1100), requestedCause)
    require(requested.deadline()[0].getTime() === 1100, "requested deadline changed")
    timers.fire(0)
    require(requested.err() === deadlineExceeded && cause(requested) === requestedCause, "deadline cause changed")
    require(requested.done().reason === deadlineExceeded, "deadline signal reason changed")
    cancelRequested()

    restoreClock()
    const parentMonotonic = [10, 110]
    setClock(() => 1000, () => parentMonotonic.shift() ?? 110)
    timers = timerHarness()
    const [earlierParent] = withDeadlineCause(background(), new Date(1100), firstCause)
    const [inherited] = withDeadline(earlierParent, new Date(1500))
    require(timers.delays.length === 1, "child duplicated parent timer")
    timers.fire(0)
    require(cause(inherited) === firstCause, "parent deadline cause changed")

    restoreClock()
    setClock(() => 1000, () => 10)
    timers = timerHarness()
    const [fallbackDeadline] = withDeadline(rootLike(new Date(1100)), new Date(1500))
    require(timers.delays.length === 0, "earlier parent without Done gained a fallback timer")
    require(fallbackDeadline.err() === null && cause(fallbackDeadline) === null, "earlier parent without Done terminal changed")

    restoreClock()
    let timeoutWallReads = 0
    setClock(() => {
      timeoutWallReads += 1
      return timeoutWallReads === 1 ? 1000 : 1100
    }, () => 0)
    timers = timerHarness()
    const timeoutParent = {
      deadline() {
        require(timeoutWallReads === 1, "withTimeout read parent deadline before its origin")
        return [new Date(-62135596800000), false]
      },
      done() { return null },
      err() { return null },
      value() { return null }
    }
    const [elapsedTimeout] = withTimeout(timeoutParent, 100)
    require(timeoutWallReads === 2 && timers.delays.length === 0, "withTimeout parent lookup elapsed time changed")
    require(elapsedTimeout.err() === deadlineExceeded, "elapsed timeout did not expire synchronously")

    restoreClock()
    setClock(() => 1000, () => 0)
    timers = timerHarness()
    const [past] = withDeadlineCause(background(), new Date(1000), requestedCause)
    require(past.err() === deadlineExceeded && timers.delays.length === 0, "past deadline changed")

    restoreClock()
    timerHarness()
    rejects(() => withDeadline(background(), {}), TypeError)
    rejects(() => withDeadline(background(), new Date(Number.NaN)), RangeError)
    for (const wall of [Number.NaN, -8640000000000001, 8640000000000001]) {
      setClock(() => wall, () => 0)
      rejects(() => withDeadline(background(), new Date(1000)), RangeError)
    }

    restoreClock()
    setClock(() => 0, () => Number.NaN)
    timerHarness()
    rejects(() => withDeadline(background(), new Date(1000)), RangeError)

    restoreClock()
    setClock(() => 0, () => 0)
    const timerFailure = new Error("timer allocation")
    timerHarness({ failure: timerFailure })
    rejects(() => withDeadline(background(), new Date(1000)), timerFailure)

    restoreClock()
    const monotonic = [10, 50, 110]
    setClock(() => 1000, () => monotonic.shift() ?? 110)
    timers = timerHarness()
    const [rearmed] = withDeadline(background(), new Date(1100))
    timers.fire(0)
    require(rearmed.err() === null && timers.delays[1] === 60, "early timer wake changed")
    timers.fire(1)
    require(rearmed.err() === deadlineExceeded, "monotonic expiration changed")

    restoreClock()
    const longMonotonic = [0, 10]
    setClock(() => 0, () => longMonotonic.shift() ?? 10)
    timers = timerHarness()
    const [long, cancelLong] = withTimeout(background(), 2147483747)
    require(timers.delays[0] === 2147483647, "timer maximum changed")
    timers.fire(0)
    require(timers.delays[1] === 2147483647 && long.err() === null, "long timer re-arm changed")
    cancelLong()
    timers.fire(1)

    restoreClock()
    setClock(() => 1000.75, () => 5)
    timers = timerHarness()
    const [truncated, cancelTruncated] = withTimeout(background(), 0.8)
    require(truncated.deadline()[0].getTime() === 1001, "timeout truncation changed")
    cancelTruncated()

    restoreClock()
    setClock(() => 8640000000000000, () => 0)
    timerHarness()
    rejects(() => withTimeout(background(), 1), RangeError)
    setClock(() => -8640000000000000, () => 0)
    rejects(() => withTimeout(background(), -1), RangeError)
    setClock(() => 0, () => 0)
    rejects(() => withTimeout(background(), Number.POSITIVE_INFINITY), RangeError)
    rejects(() => withTimeout(background(), Number.MAX_VALUE), RangeError)

    restoreClock()
    setClock(() => 1000, () => 0)
    timers = timerHarness({ clearFailure: new Error("clear") })
    const [clearFailureContext, cancelClearFailure] = withTimeoutCause(background(), 1000, requestedCause)
    cancelClearFailure()
    require(clearFailureContext.err() === canceled, "timer cleanup failure escaped")

    restoreClock()
    const immediateMonotonic = [0, 100]
    setClock(() => 0, () => immediateMonotonic.shift() ?? 100)
    timers = timerHarness({ immediate: true })
    const [immediate] = withTimeoutCause(background(), 100, requestedCause)
    require(immediate.err() === deadlineExceeded && timers.cleared.length === 1, "synchronous timer settlement changed")

    restoreClock()
    setClock(() => 1000, () => 0)
    timers = timerHarness()
    const [canceledParent, cancelCanceledParent] = withCancelCause(background())
    cancelCanceledParent(firstCause)
    const [canceledTimed] = withTimeout(canceledParent, 1000)
    require(canceledTimed.err() === canceled && timers.delays.length === 0, "already-canceled timed Context armed")
  } finally {
    restoreClock()
  }
}
`,
    typeConsumer: `
import {
  afterFunc,
  background,
  canceled,
  cause,
  deadlineExceeded,
  todo,
  withCancel,
  withCancelCause,
  withDeadline,
  withDeadlineCause,
  withoutCancel,
  withTimeout,
  withTimeoutCause,
  withValue,
  type CancelCauseFunc,
  type CancelFunc,
  type Context,
  type ContextError,
  type StopFunc,
  type TimeoutContextError
} from "@likego/context"

const root: Context = background()
const pending: Context = todo()
const contextError: ContextError = canceled
const timeoutError: TimeoutContextError = deadlineExceeded
const valued: Context = withValue(root, "key", "value")
const detached: Context = withoutCancel(valued)
const cancelPair: readonly [Context, CancelFunc] = withCancel(root)
const cancelCausePair: readonly [Context, CancelCauseFunc] = withCancelCause(root)
const deadlinePair: readonly [Context, CancelFunc] = withDeadline(root, new Date())
const deadlineCausePair: readonly [Context, CancelFunc] = withDeadlineCause(root, new Date(), timeoutError)
const timeoutPair: readonly [Context, CancelFunc] = withTimeout(root, 100)
const timeoutCausePair: readonly [Context, CancelFunc] = withTimeoutCause(root, 100, timeoutError)
const stop: StopFunc = afterFunc(root, () => {})
const terminalCause: Error | null = cause(cancelPair[0])
const deadline: readonly [Date, boolean] = root.deadline()
const done: AbortSignal | null = root.done()
const err: ContextError | null = root.err()
const value: unknown = root.value("key")
const timeout: boolean = timeoutError.timeout()
const temporary: boolean = timeoutError.temporary()
void [pending, contextError, detached, cancelCausePair, deadlinePair, deadlineCausePair, timeoutPair, timeoutCausePair, stop, terminalCause, deadline, done, err, value, timeout, temporary]
`
  })

  registry.register({
    package: "@likego/metadata",
    exports: ["."],
    runtimeModule: `
import { background } from "@likego/context"
import {
  append,
  appendToClientContext,
  fromClientContext,
  fromServerContext,
  clone,
  get,
  keys,
  merge,
  mergeToClientContext,
  newClientContext,
  newMetadata,
  newServerContext,
  propagateToClientContext,
  remove,
  set,
  values
} from "@likego/metadata"

function require(condition, message) {
  if (!condition) throw new Error(message)
}

export async function run() {
  const initial = newMetadata({ "X-Trace": ["a", "b"], Tenant: "one" })
  const appended = append(initial, "x-trace", "c")
  const merged = merge(appended, newMetadata({ tenant: "two" }))
  const replaced = set(merged, "x-trace", "last")
  const removed = remove(replaced, "tenant")
  require(get(initial, "x-trace") === "a", "metadata first-value lookup changed")
  require(values(appended, "X-TRACE").join(",") === "a,b,c", "metadata append order changed")
  require(get(merged, "TENANT") === "two", "metadata merge replacement changed")
  require(keys(merged).join(",") === "tenant,x-trace", "metadata key normalization changed")
  require(clone(merged) !== merged, "metadata clone retained source identity")
  require(
    get(removed, "tenant") === null && values(removed, "x-trace").join(",") === "last",
    "metadata set/remove changed"
  )

  const clientCtx = appendToClientContext(
    newClientContext(background(), initial),
    "TraceParent",
    "one",
    "Tenant",
    "client"
  )
  const serverCtx = newServerContext(background(), merged)
  const mergedClientCtx = mergeToClientContext(
    clientCtx,
    newMetadata({ traceparent: "restored" })
  )
  require(
    values(fromClientContext(clientCtx), "traceparent").length === 1,
    "client Context metadata changed"
  )
  require(get(fromServerContext(serverCtx), "tenant") === "two", "server Context metadata changed")
  require(
    get(fromClientContext(mergedClientCtx), "traceparent") === "restored"
      && get(fromClientContext(mergedClientCtx), "tenant") === "client",
    "client Context mutation changed"
  )
  const propagated = propagateToClientContext(
    newServerContext(clientCtx, newMetadata({
      authorization: "secret",
      "x-request-id": ["request-one", "request-two"]
    })),
    { exact: ["x-request-id"] }
  )
  require(
    values(fromClientContext(propagated), "x-request-id").join(",") === "request-one,request-two"
      && get(fromClientContext(propagated), "authorization") === null,
    "metadata downstream propagation changed"
  )
}
`,
    typeConsumer: `
import type { Context } from "@likego/context"
import {
  append,
  appendToClientContext,
  fromClientContext,
  fromServerContext,
  clone,
  get,
  keys,
  merge,
  mergeToClientContext,
  newClientContext,
  newMetadata,
  newServerContext,
  propagateToClientContext,
  remove,
  set,
  values,
  type Metadata,
  type MetadataInput,
  type MetadataValue,
  type PropagationOptions
} from "@likego/metadata"

declare const ctx: Context
const input: MetadataInput = { traceparent: ["one", "two"] }
const value: MetadataValue = "three"
const metadata: Metadata = newMetadata(input)
const appended: Metadata = append(metadata, "traceparent", value)
const merged: Metadata = merge(appended, clone(metadata))
const replaced: Metadata = set(merged, "traceparent", "replacement")
const removed: Metadata = remove(replaced, "traceparent")
const clientCtx: Context = newClientContext(ctx, merged)
const serverCtx: Context = newServerContext(ctx, merged)
const propagation: PropagationOptions = { exact: ["traceparent"], prefix: ["x-baggage-"] }
const propagated: Context = propagateToClientContext(serverCtx, propagation)
const nextClient: Context = appendToClientContext(clientCtx, "tenant", "one")
const mergedClient: Context = mergeToClientContext(nextClient, metadata)
void [removed, propagated, get(merged, "tenant"), values(merged, "traceparent"), keys(merged), fromClientContext(mergedClient), fromServerContext(serverCtx)]
`
  })

  registry.register({
    package: "@likego/client",
    exports: ["."],
    runtimeModule: alignedClientRuntimeModule(),
    typeConsumer: alignedClientTypeConsumer()
  })

  registry.register({
    package: "@likego/server",
    exports: ["."],
    runtimeModule: alignedServerRuntimeModule(),
    typeConsumer: alignedServerTypeConsumer()
  })

  const corePortableRuntime = alignedCoreRuntimeModule()

  registry.register({
    package: "@likego/core",
    exports: [".", "./lifecycle", "./node"],
    runtimeModule: corePortableRuntime,
    runtimeModules: {
      ".": corePortableRuntime,
      "./lifecycle": corePortableRuntime,
      "./node": coreNodeRuntimeModule()
    },
    typeConsumer: alignedCoreTypeConsumer()
  })

  const webPortableRuntime = `
import { canceled, cause } from "@likego/context"
import { newProbeRegistry } from "@likego/health"
import { contextHandler } from "@likego/web"
import { createHealthHandler } from "@likego/web/health"

function require(condition, message) {
  if (!condition) throw new Error(message)
}

function structuralRequest(initiallyAborted, reason, abortDuringRegistration = false, failures = {}) {
  let aborted = initiallyAborted
  let listener = null
  const signal = {
    get aborted() {
      if (failures.aborted) throw failures.aborted
      return aborted
    },
    get reason() { return reason },
    addEventListener(_type, nextListener) {
      listener = nextListener
      if (failures.add) throw failures.add
      if (abortDuringRegistration) {
        aborted = true
        nextListener.call(signal, new Event("abort"))
      }
    },
    removeEventListener() {
      if (failures.remove) throw failures.remove
    }
  }
  return { request: { signal }, signal, dispatch() {
    aborted = true
    if (listener !== null) listener.call(signal, new Event("abort"))
  } }
}

export async function run() {
  let rejected = false
  try { contextHandler(null) } catch { rejected = true }
  require(rejected, "non-callable handler was accepted")
  rejected = false
  try { contextHandler(() => new Response(), { timeoutMs: Number.NaN }) } catch { rejected = true }
  require(rejected, "non-finite timeout was accepted")

  let retained = null
  const syncResponse = new Response("sync")
  const sync = contextHandler((ctx, request) => {
    retained = ctx
    require(request.url === "https://likego.test/sync", "request identity changed")
    return syncResponse
  })
  require(sync(new Request("https://likego.test/sync")) === syncResponse, "sync response identity changed")
  require(retained.err() === canceled, "sync request Context was not released")

  const asyncResponse = new Response("async")
  const asyncHandler = contextHandler(async () => asyncResponse)
  require(await asyncHandler(new Request("https://likego.test/async")) === asyncResponse, "async response changed")
  const asyncFailure = new Error("async failure")
  try {
    await contextHandler(() => Promise.reject(asyncFailure))(new Request("https://likego.test/reject"))
    throw new Error("async rejection resolved")
  } catch (error) {
    require(error === asyncFailure, "async rejection identity changed")
  }

  const syncFailure = new Error("sync failure")
  try {
    contextHandler(() => { throw syncFailure })(new Request("https://likego.test/throw"))
    throw new Error("sync failure resolved")
  } catch (error) {
    require(error === syncFailure, "sync throw identity changed")
  }

  const preAborted = structuralRequest(true, undefined)
  await contextHandler((ctx) => {
    require(ctx.err() === canceled && cause(ctx) === canceled, "undefined abort reason changed")
    return new Response("aborted")
  })(preAborted.request)

  const rawReason = { code: "disconnect" }
  const nonError = structuralRequest(true, rawReason)
  await contextHandler((ctx) => {
    require(cause(ctx)?.cause === rawReason, "non-Error abort reason was not preserved")
    return new Response("aborted")
  })(nonError.request)

  const errorDescriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  const localReason = new Error("local disconnect")
  try {
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    const localError = structuralRequest(true, localReason)
    await contextHandler((ctx) => {
      require(cause(ctx) === localReason, "local Error fallback changed")
      return new Response("local")
    })(localError.request)
  } finally {
    if (errorDescriptor === undefined) delete Error.isError
    else Object.defineProperty(Error, "isError", errorDescriptor)
  }

  const abortFailure = new Error("abort")
  const aborting = structuralRequest(false, abortFailure, true)
  await contextHandler((ctx) => {
    require(cause(ctx) === abortFailure, "registration-race abort changed")
    return new Response("race")
  })(aborting.request)

  let release
  let inFlightContext = null
  const pending = new Promise((resolve) => { release = resolve })
  const controller = new AbortController()
  const outcome = contextHandler((ctx) => {
    inFlightContext = ctx
    return pending
  })(new Request("https://likego.test/pending", { signal: controller.signal }))
  controller.abort(abortFailure)
  require(cause(inFlightContext) === abortFailure, "in-flight abort changed")
  release(new Response("late"))
  await outcome

  await contextHandler((ctx) => {
    require(ctx.deadline()[1], "timeout deadline missing")
    return new Response("timed")
  }, { timeoutMs: 1000 })(new Request("https://likego.test/timeout"))

  const removalFailure = structuralRequest(false, undefined, false, { remove: new Error("remove") })
  require(contextHandler(() => syncResponse)(removalFailure.request) === syncResponse, "cleanup replaced response")
  removalFailure.dispatch()

  const invalidNull = structuralRequest(false, undefined)
  require(contextHandler(() => null)(invalidNull.request) === null, "null handler result changed")
  const invalidPrimitive = structuralRequest(false, undefined)
  require(contextHandler(() => 1)(invalidPrimitive.request) === 1, "primitive handler result changed")

  const thenFailure = new Error("then getter failed")
  const hostileThen = Object.defineProperty({}, "then", { get() { throw thenFailure } })
  try {
    contextHandler(() => hostileThen)(structuralRequest(false, undefined).request)
    throw new Error("hostile then getter resolved")
  } catch (error) {
    require(error === thenFailure, "then getter failure identity changed")
  }

  const registrationFailure = new Error("register")
  const registrationRequest = structuralRequest(false, undefined, false, {
    add: registrationFailure,
    remove: new Error("remove")
  })
  try {
    contextHandler(() => new Response("unexpected"))(registrationRequest.request)
    throw new Error("registration failure resolved")
  } catch (error) {
    require(error === registrationFailure, "registration failure identity changed")
  }

  const originalNow = Date.now
  try {
    Date.now = () => Number.NaN
    try {
      contextHandler(() => new Response("unexpected"), { timeoutMs: 1 })(new Request("https://likego.test/nan"))
      throw new Error("invalid clock resolved")
    } catch (error) {
      require(error instanceof RangeError, "timeout construction failure changed")
    }
  } finally {
    Date.now = originalNow
  }

  const probes = newProbeRegistry()
  probes.register("live", "process", () => {})
  probes.register("ready", "dependency", () => {})
  const health = createHealthHandler(probes)
  let healthResponse = await health(new Request("https://likego.test/readyz?verbose=1"))
  require(healthResponse.status === 200 && (await healthResponse.json()).status === "ok", "ready endpoint changed")
  healthResponse = await health(new Request("https://likego.test/readyz", { method: "HEAD" }))
  require(healthResponse.status === 200 && await healthResponse.text() === "", "health HEAD changed")
  healthResponse = await health(new Request("https://likego.test/readyz", { method: "POST" }))
  require(healthResponse.status === 405 && healthResponse.headers.get("Allow") === "GET, HEAD", "health method gate changed")
  require((await health(new Request("https://likego.test/missing"))).status === 404, "health missing route changed")

  const privateFailure = new Error("private health failure")
  probes.register("live", "failing", () => { throw privateFailure })
  healthResponse = await health(new Request("https://likego.test/livez"))
  const healthBody = await healthResponse.text()
  require(healthResponse.status === 503 && !healthBody.includes(privateFailure.message), "health response leaked failure")

  const customHealth = createHealthHandler(newProbeRegistry(), { livePath: "/live", readyPath: "/ready" })
  require((await customHealth(new Request("https://likego.test/live"))).status === 200, "custom health path changed")
  for (const create of [
    () => createHealthHandler(null),
    () => createHealthHandler(1),
    () => createHealthHandler({}),
    () => createHealthHandler({ register() {} }),
    () => createHealthHandler({ register() {}, check: null }),
    () => createHealthHandler(newProbeRegistry(), { livePath: 1 }),
    () => createHealthHandler(newProbeRegistry(), { livePath: "live" }),
    () => createHealthHandler(newProbeRegistry(), { livePath: "/live?query=1" }),
    () => createHealthHandler(newProbeRegistry(), { livePath: "/live#fragment" }),
    () => createHealthHandler(newProbeRegistry(), { livePath: "/a/../live" }),
    () => createHealthHandler(newProbeRegistry(), { livePath: "/same", readyPath: "/same" })
  ]) {
    let healthRejected = false
    try { create() } catch { healthRejected = true }
    require(healthRejected, "invalid health handler construction was accepted")
  }

  function structuralRegistry(result, failure = null) {
    return {
      register() { return () => false },
      async check() {
        if (failure !== null) throw failure
        return typeof result === "function" ? result() : result
      }
    }
  }

  async function requireUnavailable(result, label, method = "GET") {
    const response = await createHealthHandler(structuralRegistry(result))(
      new Request("https://likego.test/readyz", { method })
    )
    require(response.status === 503, label + " status changed")
    require(
      await response.text() === (method === "HEAD" ? "" : '{"status":"unavailable","checks":[]}'),
      label + " payload changed"
    )
  }

  await requireUnavailable(null, "null report")
  await requireUnavailable(1, "primitive report")
  await requireUnavailable({ ok: true, checks: [] }, "missing report kind")
  await requireUnavailable({ kind: "ready", checks: [] }, "missing report state")
  await requireUnavailable({ kind: "ready", ok: true }, "missing report checks")
  await requireUnavailable({ kind: "live", ok: true, checks: [] }, "wrong report kind")
  await requireUnavailable({ kind: "ready", ok: "yes", checks: [] }, "non-boolean report state")
  await requireUnavailable({ kind: "ready", ok: true, checks: {} }, "non-array report checks")
  await requireUnavailable({ kind: "ready", ok: true, checks: [null] }, "null check")
  await requireUnavailable({ kind: "ready", ok: true, checks: [1] }, "primitive check")
  await requireUnavailable({ kind: "ready", ok: true, checks: [{}] }, "missing check fields")
  await requireUnavailable({
    kind: "ready",
    ok: true,
    checks: [{ name: "postgres://secret", ok: true, error: null }]
  }, "private check name")
  await requireUnavailable({
    kind: "ready",
    ok: true,
    checks: [{ name: "public", ok: "yes", error: null }]
  }, "non-boolean check state")
  await requireUnavailable({
    kind: "ready",
    ok: true,
    checks: [{ name: "public", ok: true, error: new Error("private") }]
  }, "healthy check error")
  await requireUnavailable({
    kind: "ready",
    ok: false,
    checks: [{ name: "public", ok: false, error: "private" }]
  }, "failed check non-error")
  await requireUnavailable({
    kind: "ready",
    ok: false,
    checks: [{ name: "public", ok: true, error: null }]
  }, "inconsistent report state")
  await requireUnavailable(function throwingReport() {
    return {
      get kind() { throw new Error("private getter") },
      ok: true,
      checks: []
    }
  }, "throwing report getter")

  const registryFailure = new Error("private registry failure")
  const thrownResponse = await createHealthHandler(structuralRegistry(null, registryFailure))(
    new Request("https://likego.test/readyz", { method: "HEAD" })
  )
  require(thrownResponse.status === 503 && await thrownResponse.text() === "", "registry failure was not sanitized")

  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  try {
    if (descriptor === undefined) {
      const legacyResponse = await createHealthHandler(structuralRegistry({
        kind: "ready",
        ok: false,
        checks: [{ name: "legacy", ok: false, error: new Error("private") }]
      }))(new Request("https://likego.test/readyz"))
      require(legacyResponse.status === 503, "legacy Error fallback changed")
    } else {
      Object.defineProperty(Error, "isError", { ...descriptor, value: undefined })
      const legacyResponse = await createHealthHandler(structuralRegistry({
        kind: "ready",
        ok: false,
        checks: [{ name: "legacy", ok: false, error: new Error("private") }]
      }))(new Request("https://likego.test/readyz"))
      require(
        await legacyResponse.text() === '{"status":"unavailable","checks":[{"name":"legacy","status":"failed"}]}',
        "same-realm Error fallback changed"
      )
    }
  } finally {
    if (descriptor !== undefined) Object.defineProperty(Error, "isError", descriptor)
  }

  let kindReads = 0
  let reportReads = 0
  let checksReads = 0
  let nameReads = 0
  let okReads = 0
  let errorReads = 0
  const structuralCheck = {
    get name() { nameReads += 1; return "public-name" },
    get ok() { okReads += 1; return true },
    get error() { errorReads += 1; return null }
  }
  const structuralReport = {
    get kind() { kindReads += 1; return "ready" },
    get ok() { reportReads += 1; return true },
    get checks() { checksReads += 1; return [structuralCheck] }
  }
  healthResponse = await createHealthHandler(structuralRegistry(structuralReport))(
    new Request("https://likego.test/readyz")
  )
  require(healthResponse.status === 200, "structural report status changed")
  require(
    kindReads === 1
      && reportReads === 1
      && checksReads === 1
      && nameReads === 1
      && okReads === 1
      && errorReads === 1,
    "structural report was read more than once"
  )
}
`

  const webRootTypes = `
import { contextHandler, type ContextHandler, type ContextHandlerOptions, type Handler } from "@likego/web"

const handler: ContextHandler = (_ctx, _request) => new Response("published")
const options: ContextHandlerOptions = { timeoutMs: 100 }
const webHandler: Handler = contextHandler(handler, options)
void webHandler
`
  const webHealthTypes = `
import { newProbeRegistry, type ProbeRegistry } from "@likego/health"
import type { Handler } from "@likego/web"
import { createHealthHandler, type HealthHandlerOptions } from "@likego/web/health"

const probes: ProbeRegistry = newProbeRegistry()
const options: HealthHandlerOptions = { livePath: "/live", readyPath: "/ready" }
const healthHandler: Handler = createHealthHandler(probes, options)
void healthHandler
`
  const webNodeTypes = `
import { background } from "@likego/context"
import type { Endpointer, Server } from "@likego/core"
import {
  hostname,
  newNodeServer,
  nodeShutdownTimeout,
  port,
  type NodeServer,
  type NodeServerAlreadyStartedError,
  type NodeServerForceCloseError,
  type NodeServerOption,
  type NodeServerOptions,
  type NodeServerUnexpectedCloseError
} from "@likego/web/node"

const defaults: NodeServerOptions = {
  hostname: "127.0.0.1",
  port: 0,
  shutdownTimeoutMs: 25_000
}
const option: NodeServerOption = hostname("localhost")
const configured: NodeServerOptions = option(defaults)
const server: NodeServer = newNodeServer(
  () => new Response("published"),
  port(0),
  nodeShutdownTimeout(1_000)
)
const coreServer: Server = server
const endpointer: Endpointer = server
const endpoint: Promise<string> = server.endpoint(background())
declare const started: NodeServerAlreadyStartedError
declare const forced: NodeServerForceCloseError
declare const unexpected: NodeServerUnexpectedCloseError
void [configured, coreServer, endpointer, endpoint, started.code, forced.code, unexpected.code]
`
  const webExportInventoryTypes = `
import * as webRoot from "@likego/web"
import * as webHealth from "@likego/web/health"
import * as webNode from "@likego/web/node"
void [webRoot, webHealth, webNode]
`

  registry.register({
    package: "@likego/web",
    exports: [".", "./health", "./node"],
    runtimeModule: webPortableRuntime,
    typeConsumer: webExportInventoryTypes,
    runtimeModules: {
      ".": webPortableRuntime,
      "./health": webPortableRuntime,
      "./node": webNodeRuntimeModule()
    },
    typeConsumers: {
      ".": webRootTypes,
      "./health": webHealthTypes,
      "./node": webNodeTypes
    }
  })

  registry.register({
    package: "@likego/health",
    exports: ["."],
    runtimeModule: alignedHealthRuntimeModule(),
    typeConsumer: alignedHealthTypeConsumer()
  })

  registry.register({
    package: "@likego/config",
    exports: [".", "./env", "./file", "./node", "./yaml"],
    runtimeModule: configRuntimeModule(),
    typeConsumer: configExportInventoryTypeConsumer(),
    runtimeModules: {
      ".": configRuntimeModule(),
      "./env": combinedConfigRuntimeModule("env", configEnvRuntimeModule()),
      "./file": combinedConfigRuntimeModule("file", configFileRuntimeModule()),
      "./node": configNodeRuntimeModule(),
      "./yaml": combinedConfigRuntimeModule("yaml", configYamlRuntimeModule())
    },
    typeConsumers: {
      ".": configRootTypeConsumer(),
      "./env": configEnvTypeConsumer(),
      "./file": configFileTypeConsumer(),
      "./node": configNodeTypeConsumer(),
      "./yaml": configYamlTypeConsumer()
    }
  })

  registry.register({
    package: "@likego/resilience",
    exports: ["."],
    runtimeModule: `
import {
  background,
  canceled,
  withCancelCause
} from "@likego/context"
import {
  circuitOpen,
  exponentialBackoff,
  newCircuitBreaker,
  newTokenBucketLimiter,
  retry
} from "@likego/resilience"

function require(condition, message) {
  if (!condition) throw new Error(message)
}

function deferred() {
  let resolvePromise = null
  let rejectPromise = null
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve(value) {
      if (resolvePromise === null) throw new Error("deferred resolve unavailable")
      resolvePromise(value)
    },
    reject(error) {
      if (rejectPromise === null) throw new Error("deferred reject unavailable")
      rejectPromise(error)
    }
  }
}

async function rejected(operation) {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error("expected rejection")
}

function rejects(invoke, name) {
  let observed = null
  try { invoke() } catch (error) { observed = error }
  require(observed !== null && observed.name === name, "expected " + name)
  return observed
}

function structuralContext(error, signal = null) {
  return {
    deadline() { return [new Date(0), false] },
    done() { return signal },
    err() { return error() },
    value() { return null }
  }
}

const originalPerformanceNowDescriptor = Object.getOwnPropertyDescriptor(performance, "now")
const originalErrorIsErrorDescriptor = Object.getOwnPropertyDescriptor(Error, "isError")
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

function setMonotonicNow(value) {
  Object.defineProperty(performance, "now", { configurable: true, writable: true, value: () => value })
}

function restoreErrorIsError() {
  if (originalErrorIsErrorDescriptor === undefined) delete Error.isError
  else Object.defineProperty(Error, "isError", originalErrorIsErrorDescriptor)
}

function restoreRuntime() {
  if (originalPerformanceNowDescriptor === undefined) delete performance.now
  else Object.defineProperty(performance, "now", originalPerformanceNowDescriptor)
  restoreErrorIsError()
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: originalSetTimeout })
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: originalClearTimeout })
}

async function exerciseBackoff() {
  const defaults = exponentialBackoff({ initialDelayMs: 2 })
  require(defaults(1) === 2 && defaults(2) === 4, "default exponential backoff changed")
  require(exponentialBackoff({ initialDelayMs: 0 })(1) === 0, "zero exponential backoff changed")
  const capped = exponentialBackoff({ initialDelayMs: 3, multiplier: 3, maxDelayMs: 8 })
  require(capped(1) === 3 && capped(2) === 8 && capped(3) === 8, "capped backoff changed")
  rejects(() => exponentialBackoff(null), "TypeError")
  rejects(() => exponentialBackoff("invalid"), "TypeError")
  rejects(() => exponentialBackoff({ initialDelayMs: Number.NaN }), "RangeError")
  rejects(() => exponentialBackoff({ initialDelayMs: -1 }), "RangeError")
  rejects(() => exponentialBackoff({ initialDelayMs: 2147483648 }), "RangeError")
  rejects(() => exponentialBackoff({ initialDelayMs: 1, multiplier: Number.POSITIVE_INFINITY }), "RangeError")
  rejects(() => exponentialBackoff({ initialDelayMs: 1, multiplier: 0 }), "RangeError")
  rejects(() => exponentialBackoff({ initialDelayMs: 2, maxDelayMs: 1 }), "RangeError")
  rejects(() => defaults(0), "RangeError")
  rejects(() => defaults(Number.MAX_SAFE_INTEGER + 1), "RangeError")
}

async function exerciseRetry() {
  const transient = new Error("transient")
  const identities = new Set()
  const bodies = []
  const delays = []
  const baseBackoff = exponentialBackoff({ initialDelayMs: 1, multiplier: 2, maxDelayMs: 2 })
  const response = await retry(background(), async (_ctx, attempt) => {
    const request = new Request("https://published.test/retry/" + attempt, {
      method: "POST",
      body: "attempt-" + attempt
    })
    identities.add(request)
    bodies.push(await request.text())
    if (attempt < 3) throw transient
    return new Response("accepted", { status: 201 })
  }, {
    authorization: "idempotent",
    maxAttempts: 3,
    shouldRetry(_ctx, failure, attempt) { return failure === transient && attempt < 3 },
    backoff(attempt) {
      const delayMs = baseBackoff(attempt)
      delays.push(delayMs)
      return delayMs
    }
  })
  require(response.status === 201 && await response.text() === "accepted", "retry response changed")
  require(identities.size === 3 && bodies.join(",") === "attempt-1,attempt-2,attempt-3", "Request recreation changed")
  require(delays.join(",") === "1,2", "retry delays changed")

  const immediate = await retry(background(), (_ctx, attempt) => attempt, {
    authorization: "caller-approved",
    maxAttempts: 1,
    shouldRetry() { return false }
  })
  require(immediate === 1, "single retry attempt changed")

  const boundedFailure = new Error("bounded")
  require(await rejected(retry(background(), () => { throw boundedFailure }, {
    authorization: "idempotent",
    maxAttempts: 1,
    shouldRetry() { return true }
  })) === boundedFailure, "attempt bound failure changed")

  const [operationContext, cancelOperation] = withCancelCause(background())
  require(await rejected(retry(operationContext, () => {
    cancelOperation(new Error("operation cancellation"))
    throw transient
  }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true }
  })) === canceled, "operation cancellation precedence changed")

  const stoppedFailure = new Error("stopped")
  let stoppedAttempts = 0
  require(await rejected(retry(background(), () => {
    stoppedAttempts += 1
    throw stoppedFailure
  }, {
    authorization: "caller-approved",
    maxAttempts: 3,
    async shouldRetry() { return false }
  })) === stoppedFailure && stoppedAttempts === 1, "retry predicate false changed")

  const policyFailure = new Error("retry policy")
  require(await rejected(retry(background(), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { throw policyFailure }
  })) === policyFailure, "retry policy failure identity changed")

  const [throwingPolicyContext, cancelThrowingPolicy] = withCancelCause(background())
  require(await rejected(retry(throwingPolicyContext, () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() {
      cancelThrowingPolicy(new Error("policy cancellation"))
      throw policyFailure
    }
  })) === canceled, "retry policy cancellation precedence changed")

  let zeroDelayAttempts = 0
  require(await retry(background(), () => {
    zeroDelayAttempts += 1
    if (zeroDelayAttempts === 1) throw transient
    return "zero-delay"
  }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true }
  }) === "zero-delay", "zero-delay retry changed")

  const invalidPredicate = await rejected(retry(background(), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return "yes" }
  }))
  require(invalidPredicate instanceof TypeError, "invalid retry predicate accepted")

  const invalidBackoff = await rejected(retry(background(), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() { return -1 }
  }))
  require(invalidBackoff instanceof RangeError, "invalid retry delay accepted")

  const backoffFailure = new Error("retry backoff")
  require(await rejected(retry(background(), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() { throw backoffFailure }
  })) === backoffFailure, "retry backoff failure identity changed")

  const [throwingBackoffContext, cancelThrowingBackoff] = withCancelCause(background())
  require(await rejected(retry(throwingBackoffContext, () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() {
      cancelThrowingBackoff(new Error("backoff cancellation"))
      throw backoffFailure
    }
  })) === canceled, "retry backoff cancellation precedence changed")

  const [invalidBackoffContext, cancelInvalidBackoff] = withCancelCause(background())
  require(await rejected(retry(invalidBackoffContext, () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() {
      cancelInvalidBackoff(new Error("invalid backoff cancellation"))
      return Number.NaN
    }
  })) === canceled, "invalid backoff cancellation precedence changed")

  const [cancelContext, cancelRetry] = withCancelCause(background())
  const cancelFailure = new Error("cancel retry delay")
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value() { throw new Error("ignored timer cleanup") }
  })
  try {
    const canceledRetry = retry(cancelContext, () => { throw transient }, {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry() {
        setTimeout(() => cancelRetry(cancelFailure), 0)
        return true
      },
      backoff() { return 25 }
    })
    require(await rejected(canceledRetry) === canceled, "retry delay cancellation changed")
  } finally {
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      writable: true,
      value: originalClearTimeout
    })
  }

  let dynamicReads = 0
  const dynamicContext = structuralContext(() => {
    dynamicReads += 1
    return dynamicReads === 4 ? canceled : null
  })
  require(await rejected(retry(dynamicContext, () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true }
  })) === canceled, "post-failure Context state changed")

  const [predicateContext, cancelPredicate] = withCancelCause(background())
  const predicateCause = new Error("predicate canceled")
  const predicateCanceled = retry(predicateContext, () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { cancelPredicate(predicateCause); return true }
  })
  require(await rejected(predicateCanceled) === canceled, "predicate cancellation changed")

  const synchronousSignal = {
    aborted: false,
    addEventListener(_type, callback) {
      this.aborted = true
      callback()
      callback()
    },
    removeEventListener() { throw new Error("ignored remove") }
  }
  const synchronousContext = structuralContext(() => null, synchronousSignal)
  require(await rejected(retry(synchronousContext, () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() { return 10 }
  })) === canceled, "synchronous abort changed")

  const registrationRaceSignal = {
    aborted: false,
    addEventListener() { this.aborted = true },
    removeEventListener() {}
  }
  require(await rejected(retry(structuralContext(() => null, registrationRaceSignal), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() { return 10 }
  })) === canceled, "post-registration abort changed")

  const observationFailure = new Error("cancellation observation")
  let failCancellationObservation = false
  const observationSignal = {
    aborted: false,
    addEventListener(_type, callback) {
      failCancellationObservation = true
      callback()
    },
    removeEventListener() {}
  }
  require(await rejected(retry(structuralContext(() => {
    if (failCancellationObservation) throw observationFailure
    return null
  }, observationSignal), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() { return 10 }
  })) === observationFailure, "cancellation observation failure changed")

  const explicitCancellationFailure = new Error("explicit cancellation failure")
  let exposeCancellationFailure = false
  const explicitFailureSignal = {
    aborted: false,
    addEventListener(_type, callback) {
      exposeCancellationFailure = true
      callback()
    },
    removeEventListener() {}
  }
  require(await rejected(retry(structuralContext(
    () => exposeCancellationFailure ? explicitCancellationFailure : null,
    explicitFailureSignal
  ), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() { return 10 }
  })) === explicitCancellationFailure, "explicit cancellation failure changed")

  const fallbackCancellationSignal = {
    aborted: false,
    addEventListener(_type, callback) { callback() },
    removeEventListener() {}
  }
  require(await rejected(retry(structuralContext(() => null, fallbackCancellationSignal), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() { return 10 }
  })) === canceled, "abort-listener cancellation fallback changed")

  let synchronousTimerAttempts = 0
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value(callback) {
      callback()
      callback()
      return 1
    }
  })
  try {
    require(await retry(background(), () => {
      synchronousTimerAttempts += 1
      if (synchronousTimerAttempts === 1) throw transient
      return "synchronous timer"
    }, {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry() { return true },
      backoff() { return 10 }
    }) === "synchronous timer", "synchronous timer settlement changed")
  } finally {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: originalSetTimeout
    })
  }

  const listenerFailure = new Error("listener registration")
  const throwingSignal = {
    aborted: false,
    addEventListener() { throw listenerFailure },
    removeEventListener() {}
  }
  require(await rejected(retry(structuralContext(() => null, throwingSignal), () => { throw transient }, {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry() { return true },
    backoff() { return 10 }
  })) === listenerFailure, "listener registration failure changed")

  const timerFailure = new Error("timer registration")
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value() { throw timerFailure }
  })
  try {
    require(await rejected(retry(background(), () => { throw transient }, {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry() { return true },
      backoff() { return 10 }
    })) === timerFailure, "timer registration failure changed")
  } finally {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: originalSetTimeout
    })
  }

  const base = {
    authorization: "idempotent",
    maxAttempts: 1,
    shouldRetry() { return false }
  }
  require((await rejected(retry(null, () => 1, base))) instanceof TypeError, "null Context accepted")
  require((await rejected(retry(1, () => 1, base))) instanceof TypeError, "scalar Context accepted")
  require((await rejected(retry({}, () => 1, base))) instanceof TypeError, "methodless Context accepted")
  require((await rejected(retry({ err() { return null } }, () => 1, base))) instanceof TypeError,
    "Context without done accepted")

  const fallbackContextFailure = new Error("fallback Context failure")
  const recognizedContextFailure = new Error("recognized Context failure")
  try {
    Object.defineProperty(Error, "isError", {
      configurable: true,
      writable: true,
      value: undefined
    })
    require(await rejected(retry(structuralContext(() => fallbackContextFailure), () => 1, base)) === fallbackContextFailure,
      "standard Error fallback changed")
    Object.defineProperty(Error, "isError", {
      configurable: true,
      writable: true,
      value(value) { return value === recognizedContextFailure }
    })
    require(await rejected(retry(structuralContext(() => recognizedContextFailure), () => 1, base)) === recognizedContextFailure,
      "Error.isError recognition changed")
    require((await rejected(retry(structuralContext(() => new Error("unrecognized")), () => 1, base))) instanceof TypeError,
      "Error.isError rejection changed")
  } finally {
    restoreErrorIsError()
  }
  require((await rejected(retry(structuralContext(() => canceled), () => 1, base))) === canceled, "terminal Context admitted")
  require((await rejected(retry(structuralContext(() => null, {
    aborted: true,
    addEventListener() {},
    removeEventListener() {}
  }), () => 1, base))) === canceled, "aborted Context admitted")
  for (const signal of [
    1,
    { aborted: "false", addEventListener() {}, removeEventListener() {} },
    { aborted: false, removeEventListener() {} },
    { aborted: false, addEventListener() {} }
  ]) {
    require((await rejected(retry(structuralContext(() => null, signal), () => 1, base))) instanceof TypeError,
      "invalid Context signal accepted")
  }
  require((await rejected(retry(background(), null, base))) instanceof TypeError, "non-callable operation accepted")
  require((await rejected(retry(background(), () => 1, null))) instanceof TypeError, "null retry options accepted")
  require((await rejected(retry(background(), () => 1, "invalid"))) instanceof TypeError, "scalar retry options accepted")
  require((await rejected(retry(background(), () => 1, {
    authorization: "unsafe",
    maxAttempts: 1,
    shouldRetry() { return false }
  }))) instanceof TypeError, "invalid retry authorization accepted")
  require((await rejected(retry(background(), () => 1, {
    authorization: "idempotent",
    maxAttempts: 0,
    shouldRetry() { return false }
  }))) instanceof RangeError, "zero retry bound accepted")
  require((await rejected(retry(background(), () => 1, {
    authorization: "idempotent",
    maxAttempts: Number.MAX_SAFE_INTEGER + 1,
    shouldRetry() { return false }
  }))) instanceof RangeError, "unsafe retry bound accepted")
  require((await rejected(retry(background(), () => 1, {
    authorization: "idempotent",
    maxAttempts: 1,
    shouldRetry: null
  }))) instanceof TypeError, "non-callable retry predicate accepted")
  require((await rejected(retry(background(), () => 1, {
    authorization: "idempotent",
    maxAttempts: 1,
    shouldRetry() { return false },
    backoff: 1
  }))) instanceof TypeError, "non-callable backoff accepted")
}

async function exerciseCircuit() {
  rejects(() => newCircuitBreaker(null), "TypeError")
  rejects(() => newCircuitBreaker("invalid"), "TypeError")
  rejects(() => newCircuitBreaker({ failureThreshold: 0, resetTimeoutMs: 1 }), "RangeError")
  rejects(() => newCircuitBreaker({ failureThreshold: Number.MAX_SAFE_INTEGER + 1, resetTimeoutMs: 1 }), "RangeError")
  rejects(() => newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: -1 }), "RangeError")
  rejects(() => newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: Number.NaN }), "RangeError")
  rejects(() => newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1, isFailure: 1 }), "TypeError")

  setMonotonicNow(100)
  const failure = new Error("breaker failure")
  const breaker = newCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10 })
  require(breaker.snapshot().state === "closed", "new circuit state changed")
  require(await breaker.execute(background(), () => "success") === "success", "closed circuit success changed")
  require(await rejected(breaker.execute(background(), () => { throw failure })) === failure, "first circuit failure changed")
  require(breaker.snapshot().state === "closed" && breaker.snapshot().consecutiveFailures === 1, "failure count changed")
  require(await rejected(breaker.execute(background(), () => { throw failure })) === failure, "second circuit failure changed")
  const opened = breaker.snapshot()
  require(opened.state === "open" && opened.retryAfterMs === 10, "circuit did not open")
  require(await rejected(breaker.execute(background(), () => "blocked")) === circuitOpen, "open circuit sentinel changed")
  setMonotonicNow(110)
  require(breaker.snapshot().state === "half-open", "circuit did not become half-open")
  require(await breaker.execute(background(), () => "recovered") === "recovered", "half-open recovery changed")
  require(breaker.snapshot().state === "closed" && breaker.snapshot().consecutiveFailures === 0, "recovered circuit changed")

  const healthyClassification = newCircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 10,
    async isFailure(_ctx, error) { return error !== failure }
  })
  require(await rejected(healthyClassification.execute(background(), () => { throw failure })) === failure,
    "healthy classification changed")
  require(healthyClassification.snapshot().state === "closed" && healthyClassification.snapshot().consecutiveFailures === 0,
    "healthy classification counted as a breaker failure")
  const countedFailure = new Error("counted breaker failure")
  require(await rejected(healthyClassification.execute(background(), () => { throw countedFailure })) === countedFailure,
    "breaker failure classification changed")
  require(healthyClassification.snapshot().state === "closed" && healthyClassification.snapshot().consecutiveFailures === 1,
    "breaker failure classification was not counted")

  const invalidClassification = newCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 10,
    isFailure() { return "yes" }
  })
  require((await rejected(invalidClassification.execute(background(), () => { throw failure }))) instanceof TypeError,
    "invalid circuit classifier accepted")
  require(invalidClassification.snapshot().state === "open", "invalid classifier did not fail safe")

  const classificationFailure = new Error("circuit classification")
  const throwingClassification = newCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 10,
    isFailure() { throw classificationFailure }
  })
  require(await rejected(throwingClassification.execute(background(), () => { throw failure })) === classificationFailure,
    "circuit classification failure identity changed")
  require(throwingClassification.snapshot().state === "open", "circuit classification failure was not counted")

  const [rejectingClassifierContext, cancelRejectingClassifier] = withCancelCause(background())
  const rejectingClassifier = newCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 10,
    isFailure() {
      cancelRejectingClassifier(new Error("rejecting classifier cancellation"))
      throw classificationFailure
    }
  })
  require(await rejected(rejectingClassifier.execute(rejectingClassifierContext, () => { throw failure })) === canceled,
    "rejecting classifier cancellation precedence changed")
  require(rejectingClassifier.snapshot().state === "closed", "rejecting classifier cancellation changed breaker state")

  const [resolvedClassifierContext, cancelResolvedClassifier] = withCancelCause(background())
  const resolvedClassifier = newCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 10,
    async isFailure() {
      await Promise.resolve()
      cancelResolvedClassifier(new Error("resolved classifier cancellation"))
      return true
    }
  })
  require(await rejected(resolvedClassifier.execute(resolvedClassifierContext, () => { throw failure })) === canceled,
    "resolved classifier cancellation precedence changed")
  require(resolvedClassifier.snapshot().state === "closed", "resolved classifier cancellation changed breaker state")

  const malformedContextFailure = new Error("circuit Context observation")
  let failCircuitContextObservation = false
  const malformedCircuitContext = structuralContext(() => {
    if (failCircuitContextObservation) throw malformedContextFailure
    return null
  })
  const malformedCircuit = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 })
  require(await rejected(malformedCircuit.execute(malformedCircuitContext, () => {
    failCircuitContextObservation = true
    throw failure
  })) === malformedContextFailure, "malformed circuit Context observation changed")
  require(malformedCircuit.snapshot().state === "closed", "malformed circuit Context changed breaker state")

  setMonotonicNow(200)
  const probing = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 })
  await rejected(probing.execute(background(), () => { throw failure }))
  setMonotonicNow(210)
  const probe = deferred()
  const probeResult = probing.execute(background(), () => probe.promise)
  require(probing.snapshot().probeActive, "half-open probe was not observable")
  require(await rejected(probing.execute(background(), () => "second probe")) === circuitOpen, "second probe was admitted")
  probe.resolve("probe success")
  require(await probeResult === "probe success" && probing.snapshot().state === "closed", "probe completion changed")

  setMonotonicNow(300)
  const probeFailure = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 })
  await rejected(probeFailure.execute(background(), () => { throw failure }))
  setMonotonicNow(310)
  require(probeFailure.snapshot().state === "half-open", "failed probe was not admitted")
  await rejected(probeFailure.execute(background(), () => { throw failure }))
  require(probeFailure.snapshot().state === "open", "failed probe did not reopen circuit")

  setMonotonicNow(400)
  const neutralProbe = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 })
  await rejected(neutralProbe.execute(background(), () => { throw failure }))
  setMonotonicNow(410)
  neutralProbe.snapshot()
  let neutralReads = 0
  const neutralContext = structuralContext(() => {
    neutralReads += 1
    return neutralReads === 2 ? canceled : null
  })
  require(await rejected(neutralProbe.execute(neutralContext, () => { throw failure })) === canceled, "neutral probe cancellation changed")
  require(neutralProbe.snapshot().state === "half-open" && !neutralProbe.snapshot().probeActive, "neutral probe remained active")

  setMonotonicNow(500)
  const staleSuccessBreaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 })
  const lateSuccess = deferred()
  const staleSuccess = staleSuccessBreaker.execute(background(), () => lateSuccess.promise)
  await rejected(staleSuccessBreaker.execute(background(), () => { throw failure }))
  lateSuccess.resolve("late success")
  require(await staleSuccess === "late success" && staleSuccessBreaker.snapshot().state === "open", "stale success closed circuit")

  const staleFailureBreaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 })
  const lateFailure = deferred()
  const staleFailure = rejected(staleFailureBreaker.execute(background(), () => lateFailure.promise))
  await rejected(staleFailureBreaker.execute(background(), () => { throw failure }))
  lateFailure.reject(failure)
  require(await staleFailure === failure && staleFailureBreaker.snapshot().state === "open", "stale failure changed circuit")

  const invalidOperation = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1 })
  require((await rejected(invalidOperation.execute(background(), null))) instanceof TypeError, "non-callable circuit operation accepted")
}

async function exerciseLimiter() {
  rejects(() => newTokenBucketLimiter(null), "TypeError")
  rejects(() => newTokenBucketLimiter("invalid"), "TypeError")
  for (const options of [
    { capacity: 0, refillTokens: 1, refillIntervalMs: 1 },
    { capacity: Number.MAX_SAFE_INTEGER + 1, refillTokens: 1, refillIntervalMs: 1 },
    { capacity: 1, refillTokens: 0, refillIntervalMs: 1 },
    { capacity: 1, refillTokens: Number.MAX_SAFE_INTEGER + 1, refillIntervalMs: 1 },
    { capacity: 1, refillTokens: 1, refillIntervalMs: 0 },
    { capacity: 1, refillTokens: 1, refillIntervalMs: Number.MAX_SAFE_INTEGER + 1 },
    { capacity: 2, refillTokens: 1, refillIntervalMs: 1, initialTokens: -1 },
    { capacity: 2, refillTokens: 1, refillIntervalMs: 1, initialTokens: 3 },
    { capacity: 2, refillTokens: 1, refillIntervalMs: 1, initialTokens: 0.5 }
  ]) rejects(() => newTokenBucketLimiter(options), "RangeError")

  setMonotonicNow(0)
  const defaults = newTokenBucketLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 10 })
  require(defaults.snapshot().availableTokens === 1, "default initial tokens changed")
  require(defaults.allow(background()).allowed, "default token was not admitted")
  const denied = defaults.allow(background())
  require(!denied.allowed && denied.retryAfterMs === 10, "empty bucket decision changed")

  const limiter = newTokenBucketLimiter({ capacity: 3, refillTokens: 1, refillIntervalMs: 10, initialTokens: 0 })
  require(limiter.snapshot().availableTokens === 0, "explicit initial tokens changed")
  setMonotonicNow(5)
  require(limiter.snapshot().availableTokens === 0 && limiter.snapshot().nextRefillInMs === 5, "partial refill changed")
  setMonotonicNow(10)
  require(limiter.snapshot().availableTokens === 1, "single refill changed")
  require(limiter.allow(background()).allowed, "refilled token was not consumed")
  setMonotonicNow(100)
  require(limiter.snapshot().availableTokens === 3, "refill capacity cap changed")
  require(Object.isFrozen(limiter.snapshot()) && Object.isFrozen(limiter.allow(background())), "limiter evidence was mutable")
  setMonotonicNow(90)
  require(limiter.snapshot().availableTokens === 2, "clock regression changed tokens")

  const callableContext = function callableContext() {}
  callableContext.err = () => null
  callableContext.done = () => null
  require(limiter.allow(callableContext).allowed, "callable structural Context was rejected")

  setMonotonicNow(Number.POSITIVE_INFINITY)
  rejects(() => newTokenBucketLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 1 }), "RangeError")
}

export async function run() {
  try {
    await exerciseBackoff()
    await exerciseRetry()
    await exerciseCircuit()
    await exerciseLimiter()
  } finally {
    restoreRuntime()
  }
}
`,
    typeConsumer: `
import { background, type Context } from "@likego/context"
import {
  circuitOpen,
  exponentialBackoff,
  newCircuitBreaker,
  newTokenBucketLimiter,
  retry,
  type Backoff,
  type BackoffOptions,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitFailurePredicate,
  type CircuitOperation,
  type CircuitSnapshot,
  type CircuitState,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimiterSnapshot,
  type RetryAuthorization,
  type RetryOperation,
  type RetryOptions,
  type RetryPredicate,
  type TokenBucketOptions
} from "@likego/resilience"

const context: Context = background()
const authorization: RetryAuthorization = "idempotent"
const retryOperation: RetryOperation<number> = async (_ctx, attempt) => attempt
const retryPredicate: RetryPredicate = async (_ctx, _failure, attempt) => attempt < 2
const backoffOptions: BackoffOptions = { initialDelayMs: 1, multiplier: 2, maxDelayMs: 4 }
const backoff: Backoff = exponentialBackoff(backoffOptions)
const retryOptions: RetryOptions = {
  authorization,
  maxAttempts: 2,
  shouldRetry: retryPredicate,
  backoff
}
const retried: Promise<number> = retry(context, retryOperation, retryOptions)

const circuitPredicate: CircuitFailurePredicate = async (_ctx, _failure) => true
const circuitOptions: CircuitBreakerOptions = {
  failureThreshold: 2,
  resetTimeoutMs: 100,
  isFailure: circuitPredicate
}
const breaker: CircuitBreaker = newCircuitBreaker(circuitOptions)
const circuitOperation: CircuitOperation<string> = async (_ctx) => "ok"
const executed: Promise<string> = breaker.execute(context, circuitOperation)
const circuitSnapshot: CircuitSnapshot = breaker.snapshot()
const circuitState: CircuitState = circuitSnapshot.state
const openError: Error = circuitOpen

const tokenOptions: TokenBucketOptions = {
  capacity: 2,
  refillTokens: 1,
  refillIntervalMs: 100,
  initialTokens: 1
}
const limiter: RateLimiter = newTokenBucketLimiter(tokenOptions)
const decision: RateLimitDecision = limiter.allow(context)
const limiterSnapshot: RateLimiterSnapshot = limiter.snapshot()
void [retried, executed, circuitState, openError, decision, limiterSnapshot]
`
  })
}

import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

import {
  background,
  canceled,
  cause,
  deadlineExceeded,
  withCancelCause,
  withTimeout,
  withValue,
  type Context
} from "@go-like/context"
import { fromClientContext, newMetadata, newClientContext, type Metadata } from "@go-like/metadata"
import { filterLabel, filterVersion, newRoundRobinSelector } from "@go-like/registry"
import { snapshotServiceInstances } from "@go-like/registry/provider"
import { struct } from "@go-like/struct"
import type {
  Discovery,
  Filter,
  SelectionDone,
  SelectionOutcome,
  Selector,
  ServiceEndpoint,
  ServiceInstance,
  Watcher
} from "@go-like/registry"
import {
  endpoint,
  fromClientContext as transportFromClientContext,
  isServiceError,
  serviceError
} from "@go-like/transport"
import type {
  Client as TransportClient,
  Listener,
  Options,
  Transport,
  TransportInfo
} from "@go-like/transport"
import { encodeMetadataHeader, serviceErrorResponse } from "@go-like/transport/provider"
import { circuitOpen } from "@go-like/resilience"

import {
  circuitBreakerMiddleware,
  withDiscovery,
  closeTimeout,
  middleware,
  newClient,
  poolSize,
  poolTtl,
  use,
  withBlock,
  withSelector,
  withTransport,
  withEndpoint,
  withFilter,
  withRetry,
  type CallOption,
  type CallOptions,
  type CallRequest,
  type Client,
  type ClientMiddleware,
  type ClientOption
} from "../src/index"
import { newDiscoveryResolver } from "../src/discovery"

type MainStage = "discover" | "select" | "dial" | "fetch"

interface MainFailure {
  readonly stage: MainStage
  readonly value: unknown
}

interface CustomAfterContext extends Context {
  afterFunc(callback: () => void): () => boolean
}

interface SentRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

interface HarnessOptions {
  readonly mainFailure?: MainFailure
  readonly feedbackFailure?: unknown
  readonly closeFailure?: unknown
  readonly response?: Response
  readonly onDiscover?: () => void
  readonly onFetch?: (ctx: Context, request: Request, client: TransportClient) => void
  readonly onFeedback?: (client: TransportClient) => unknown
  readonly onClose?: (ctx: Context) => void | Promise<void>
}

interface Harness {
  readonly discovery: Discovery
  readonly selector: Selector
  readonly transport: Transport
  readonly events: string[]
  readonly sent: SentRequest[]
  readonly discoveryContexts: Context[]
  readonly selectionContexts: Context[]
  readonly dialContexts: Context[]
  readonly fetchContexts: Context[]
  readonly feedbackContexts: Context[]
  readonly outcomes: SelectionOutcome[]
  readonly closeContexts: Context[]
  readonly instances: readonly ServiceInstance[]
}

const selectedEndpoint: ServiceEndpoint = Object.freeze({
  instance: Object.freeze({
    id: "orders-a",
    name: "orders",
    version: "v1",
    endpoints: Object.freeze(["http://127.0.0.1:8080/"]),
    metadata: Object.freeze({ zone: "a" })
  }),
  url: "http://127.0.0.1:8080/"
})

/** Builds one exact expected Client feedback snapshot. */
function expectedSelectionOutcome(
  error: Error | null,
  bytesSent: boolean,
  bytesReceived: boolean,
  replyHeaders?: Readonly<Record<string, string>>
): SelectionOutcome {
  if (replyHeaders === undefined) return { error, bytesSent, bytesReceived }
  const replyMetadata: Metadata = newMetadata(replyHeaders)
  return { error, replyMetadata, bytesSent, bytesReceived }
}

/** Copies bytes into a Fetch body the caller can mutate independently. */
function responseFrom(headers: HeadersInit, body: Uint8Array, status = 200): Response {
  const copy = new ArrayBuffer(body.byteLength)
  new Uint8Array(copy).set(body)
  return new Response(copy, { status, headers })
}

/** Reads one response body without requiring the caller to know the stream type. */
async function bodyBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

/** Builds structural dependencies while recording every observable Client boundary. */
function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = []
  const sent: SentRequest[] = []
  const discoveryContexts: Context[] = []
  const selectionContexts: Context[] = []
  const dialContexts: Context[] = []
  const fetchContexts: Context[] = []
  const feedbackContexts: Context[] = []
  const outcomes: SelectionOutcome[] = []
  const closeContexts: Context[] = []
  const instances = Object.freeze([selectedEndpoint.instance])
  const prepared = options.response ?? responseFrom({ node: "a" }, new Uint8Array([9, 8]))

  const done: SelectionDone = (ctx, outcome) => {
    events.push(outcome.error === null ? "done:ok" : "done:error")
    feedbackContexts.push(ctx)
    outcomes.push(outcome)
    const result = options.onFeedback?.(transportClient)
    if (options.feedbackFailure !== undefined) throw options.feedbackFailure
    return result
  }
  const discovery: Discovery = {
    async getService(this: Discovery, ctx, service): Promise<readonly ServiceInstance[]> {
      expect(this).toBe(discovery)
      events.push(`discover:${service}`)
      discoveryContexts.push(ctx)
      const canceled = ctx.err()
      if (canceled !== null) throw cause(ctx) ?? canceled
      options.onDiscover?.()
      if (options.mainFailure?.stage === "discover") throw options.mainFailure.value
      return instances
    },
    async watch(_ctx: Context, _service: string): Promise<Watcher> {
      return controlledWatch(instances, function watcherStopped(): void {}).watcher
    }
  }
  const selector: Selector = {
    select(this: Selector, ctx, received): readonly [ServiceEndpoint, SelectionDone] {
      expect(this).toBe(selector)
      events.push("select")
      selectionContexts.push(ctx)
      const canceled = ctx.err()
      if (canceled !== null) throw cause(ctx) ?? canceled
      expect(received).toBe(instances)
      if (options.mainFailure?.stage === "select") throw options.mainFailure.value
      return Object.freeze([selectedEndpoint, done])
    }
  }
  const transportClient: TransportClient = {
    async fetch(this: TransportClient, ctx, request): Promise<Response> {
      expect(this).toBe(transportClient)
      events.push("fetch")
      fetchContexts.push(ctx)
      sent.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: new Uint8Array(await request.clone().arrayBuffer())
      })
      options.onFetch?.(ctx, request, transportClient)
      if (options.mainFailure?.stage === "fetch") throw options.mainFailure.value
      if (!(prepared instanceof Response)) return prepared
      return prepared.clone()
    },
    async close(this: TransportClient, ctx): Promise<void> {
      expect(this).toBe(transportClient)
      events.push("close")
      closeContexts.push(ctx)
      await options.onClose?.(ctx)
      if (options.closeFailure !== undefined) throw options.closeFailure
    }
  }
  const transport: Transport = {
    kind(): string {
      return "http"
    },
    init(): void {
      throw new Error("unexpected transport init")
    },
    options(): Options {
      throw new Error("unexpected transport options")
    },
    async dial(this: Transport, ctx, address): Promise<TransportClient> {
      expect(this).toBe(transport)
      events.push(`dial:${address}`)
      dialContexts.push(ctx)
      if (options.mainFailure?.stage === "dial") throw options.mainFailure.value
      return transportClient
    },
    async listen(): Promise<Listener> {
      throw new Error("unexpected transport listen")
    },
    string(): string {
      throw new Error("diagnostic string must not determine TransportInfo")
    }
  }
  return {
    discovery,
    selector,
    transport,
    events,
    sent,
    discoveryContexts,
    selectionContexts,
    dialContexts,
    fetchContexts,
    feedbackContexts,
    outcomes,
    closeContexts,
    instances
  }
}

/** Requires one Promise to reject with an Error and returns its exact identity. */
/** Requires one Promise to reject with an Error and returns its exact identity. */
async function rejected(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (value) {
    if (value instanceof Error) return value
    throw new Error("Client rejection was not normalized to Error")
  }
  throw new Error("Client operation unexpectedly fulfilled")
}

/** Returns one rejected value without normalizing its JavaScript identity. */
async function rejectedValue(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (value) {
    return value
  }
  throw new Error("Client operation unexpectedly fulfilled")
}

/** Narrows one post-response cleanup failure to the native public error contract. */
function completedCallFailure(value: Error): AggregateError {
  expect(value).toBeInstanceOf(AggregateError)
  expect(value.message).toBe("client exchange completed but cleanup failed; do not retry")
  return value as AggregateError
}

/** Reads the completed response retained in the standard Error cause field. */
function completedResponse(value: AggregateError): Response {
  const response = value.cause
  if (!(response instanceof Response)) {
    throw new Error("completed call failure did not retain its response")
  }
  return response
}

/** Bounds one test wait without retaining its guard timer after settlement. */
async function within<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const guard = new Promise<never>(function timeout(_resolve, reject): void {
    timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([operation, guard])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Creates an active external Context whose custom StopFunc fails during waiter cleanup. */
function throwingStopContext(failure: Error): CustomAfterContext {
  const signal = new AbortController().signal
  return {
    deadline: () => [new Date(0), false],
    done: () => signal,
    err: () => null,
    value: () => null,
    afterFunc() {
      return () => {
        throw failure
      }
    }
  }
}

interface WatchWaiter {
  readonly resolve: (value: readonly ServiceInstance[]) => void
  readonly reject: (failure: unknown) => void
  readonly signal: AbortSignal | null
  readonly abort: () => void
}

interface ControlledWatch {
  readonly watcher: Watcher
  readonly deliver: (value: readonly ServiceInstance[]) => void
  readonly fail: (failure: Error) => void
}

/** Creates one controllable replacement-snapshot watcher for resolver lifecycle tests. */
function controlledWatch(initial: readonly ServiceInstance[], onStop: () => void): ControlledWatch {
  const queue: (readonly ServiceInstance[])[] = initial.length === 0 ? [] : [initial]
  let waiter: WatchWaiter | null = null
  let terminal: Error | null = null
  let stopped = false

  /** Settles and detaches the current waiter. */
  function settle(complete: (pending: WatchWaiter) => void): void {
    const pending = waiter
    if (pending === null) return
    waiter = null
    if (pending.signal !== null) pending.signal.removeEventListener("abort", pending.abort)
    complete(pending)
  }

  const watcher: Watcher = Object.freeze({
    next(ctx: Context): Promise<readonly ServiceInstance[]> {
      if (terminal !== null) return Promise.reject(terminal)
      if (stopped) return Promise.reject(new Error("watcher stopped"))
      const queued = queue.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise<readonly ServiceInstance[]>((resolve, reject) => {
        const signal = ctx.done()
        const pending: WatchWaiter = {
          resolve,
          reject,
          signal,
          abort(): void {
            if (waiter !== pending) return
            settle((current) => current.reject(cause(ctx) ?? ctx.err() ?? canceled))
          }
        }
        waiter = pending
        signal?.addEventListener("abort", pending.abort, { once: true })
        if (signal?.aborted === true) pending.abort()
      })
    },
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      onStop()
      settle((pending) => pending.reject(new Error("watcher stopped")))
    }
  })

  return Object.freeze({
    watcher,
    deliver(value: readonly ServiceInstance[]): void {
      if (stopped || terminal !== null) return
      if (waiter === null) queue.push(value)
      else settle((pending) => pending.resolve(value))
    },
    fail(failure: Error): void {
      if (stopped || terminal !== null) return
      terminal = failure
      queue.length = 0
      settle((pending) => pending.reject(failure))
    }
  })
}

interface ControlledDiscovery {
  readonly discovery: Discovery
  readonly update: (instances: readonly ServiceInstance[]) => void
  readonly failWatcher: (failure: Error) => void
  readonly counts: {
    get: number
    watch: number
    stop: number
  }
}

/** Creates one mutable discovery backend with independently replaceable watchers. */
function controlledDiscovery(initial: readonly ServiceInstance[]): ControlledDiscovery {
  let current = initial
  let active: ControlledWatch | null = null
  const counts = { get: 0, watch: 0, stop: 0 }
  const discovery: Discovery = {
    async getService(): Promise<readonly ServiceInstance[]> {
      counts.get += 1
      return current
    },
    async watch(): Promise<Watcher> {
      counts.watch += 1
      active = controlledWatch(current, () => {
        counts.stop += 1
      })
      return active.watcher
    }
  }
  return Object.freeze({
    discovery,
    counts,
    update(instances: readonly ServiceInstance[]): void {
      current = instances
      active?.deliver(instances)
    },
    failWatcher(failure: Error): void {
      active?.fail(failure)
    }
  })
}

/** Selects the first transport endpoint from the latest complete discovery snapshot. */
function firstEndpointSelector(): Selector {
  const selector: Selector = {
    select(
      _ctx: Context,
      instances: readonly ServiceInstance[]
    ): readonly [ServiceEndpoint, SelectionDone] {
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("missing endpoint")
      return Object.freeze([Object.freeze({ instance, url }), function complete(): void {}])
    }
  }
  return Object.freeze(selector)
}

/** Selects like `firstEndpointSelector` and records every instance array it receives. */
function recordingSelector(seen: (readonly ServiceInstance[])[]): Selector {
  const first = firstEndpointSelector()
  return Object.freeze({
    select(
      ctx: Context,
      instances: readonly ServiceInstance[]
    ): readonly [ServiceEndpoint, SelectionDone] {
      seen.push(instances)
      return first.select(ctx, instances)
    }
  })
}

/** Completes one empty raw call to the named service and drains its response body. */
async function completeCall(client: Client, service: string): Promise<void> {
  const response = await client.call(background(), {
    service,
    endpoint: "Create",
    headers: {},
    body: new Uint8Array()
  })
  await bodyBytes(response)
}

/** Polls one asynchronous resident-state transition under a finite test boundary. */
async function eventually(check: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("resident state did not converge")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface PoolOwner {
  readonly address: string
  readonly serial: number
  fetches: number
  closes: number
}

interface PoolProbe {
  readonly transport: Transport
  readonly owners: readonly PoolOwner[]
}

const poolRequest: CallRequest = {
  service: "orders",
  endpoint: "Get",
  headers: {},
  body: new Uint8Array()
}

/** Builds a Transport whose every dial admits one distinct owner that rejects use after close. */
function poolProbe(respond?: (owner: PoolOwner) => Response | Promise<Response>): PoolProbe {
  const owners: PoolOwner[] = []
  const transport: Transport = Object.freeze({
    init(): void {
      throw new Error("unexpected init")
    },
    async dial(_ctx: Context, address: string): Promise<TransportClient> {
      const owner: PoolOwner = { address, serial: owners.length + 1, fetches: 0, closes: 0 }
      owners.push(owner)
      return Object.freeze({
        async fetch(): Promise<Response> {
          if (owner.closes > 0) throw new Error(`owner ${owner.serial} was used after close`)
          owner.fetches += 1
          await Promise.resolve()
          if (respond !== undefined) return await respond(owner)
          return responseFrom({ node: "a" }, new Uint8Array([owner.serial]))
        },
        async close(): Promise<void> {
          owner.closes += 1
        }
      })
    },
    listen(): Promise<Listener> {
      throw new Error("unexpected listen")
    },
    options(): Options {
      throw new Error("unexpected options")
    },
    string(): string {
      return "pool-probe"
    }
  })
  return { transport, owners }
}

interface TimerTracker {
  /** Timers of the watched delay that have neither fired nor been cleared. */
  readonly live: Set<unknown>
  restore(): void
}

/** Tracks every timer scheduled with one sentinel delay until it fires or is cleared. */
function trackTimers(delay: number): TimerTracker {
  const live = new Set<unknown>()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = function trackedSetTimeout(
    handler: () => void,
    ms?: number
  ): ReturnType<typeof setTimeout> {
    if (ms !== delay) return realSet(handler, ms)
    const timer = realSet(function trackedFire(): void {
      live.delete(timer)
      handler()
    }, ms)
    live.add(timer)
    return timer
  } as typeof setTimeout
  globalThis.clearTimeout = function trackedClearTimeout(
    timer?: Parameters<typeof clearTimeout>[0]
  ): void {
    live.delete(timer)
    realClear(timer)
  } as typeof clearTimeout
  return {
    live,
    restore(): void {
      for (const timer of live) realClear(timer as Parameters<typeof clearTimeout>[0])
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  }
}

interface OptionProbe {
  readonly client: Client
  /** Options accumulated by the outermost middleware from the options it received. */
  readonly forwarded: CallOptions[]
  /** Options accumulated by the innermost call once its own snapshot has been taken. */
  readonly downstream: CallOptions[]
  /** Option counts received by the outermost middleware. */
  readonly arities: number[]
}

const optionOperation = endpoint("orders", "Create", struct.number(), struct.number())
const emptyCallOptions: CallOptions = Object.freeze({ filters: Object.freeze([]), retry: null })

/** Builds a Client whose middleware records the call options each layer accumulated. */
function optionProbe(extra: readonly CallOption[] = []): OptionProbe {
  const probe = poolProbe(() =>
    responseFrom({ "content-type": "application/json" }, new TextEncoder().encode("1"))
  )
  const forwarded: CallOptions[] = []
  const downstream: CallOptions[] = []
  const arities: number[] = []
  const client = newClient(
    withTransport(probe.transport),
    withEndpoint("memory://orders"),
    middleware((next) => async (ctx, request, ...options) => {
      arities.push(options.length)
      forwarded.push(options.reduce((current, option) => option(current), emptyCallOptions))
      return await next(ctx, request, ...options, ...extra, function observe(current) {
        downstream.push(current)
        return current
      })
    })
  )
  return { client, forwarded, downstream, arities }
}

/** Verifies that completed close waits used an already released deadline Context. */
function expectBoundedClose(contexts: readonly Context[]): void {
  expect(contexts).toHaveLength(1)
  const context = contexts[0]
  if (context === undefined) throw new Error("Client did not provide a close Context")
  expect(context.deadline()[1]).toBe(true)
  expect(context.done()?.aborted).toBe(true)
}

/** Creates a Context that becomes hostile only after test-controlled business I/O. */
function lateHostileContext(
  mode: "inspect" | "classify",
  failure: Error
): readonly [Context, () => void] {
  const state = { hostile: false }
  const root = background()
  const stable: Context = {
    deadline() {
      return root.deadline()
    },
    done() {
      return root.done()
    },
    err() {
      if (state.hostile && mode === "classify") throw failure
      return root.err()
    },
    value(key) {
      return root.value(key)
    }
  }
  const ctx = new Proxy(stable, {
    get(target, key, receiver) {
      if (state.hostile && mode === "inspect" && key === "err") throw failure
      return Reflect.get(target, key, receiver)
    }
  })
  return Object.freeze([
    ctx,
    function activate(): void {
      state.hostile = true
    }
  ])
}

describe("unary Client", () => {
  test("caches discovery snapshots, applies watcher replacements, and closes ownership", async () => {
    const first = selectedEndpoint.instance
    const second: ServiceInstance = Object.freeze({
      ...first,
      id: "orders-b",
      endpoints: Object.freeze(["http://127.0.0.1:9090/"])
    })
    const source = controlledDiscovery(Object.freeze([first]))
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    await client.call(background(), request)
    await eventually(() => source.counts.get === 2)
    expect(source.counts).toEqual({ get: 2, watch: 1, stop: 0 })
    expect(subject.events).toContain("dial:http://127.0.0.1:8080/")

    source.update(Object.freeze([second]))
    await eventually(() => source.counts.watch === 1)
    await Promise.resolve()
    subject.events.length = 0
    await client.call(background(), request)
    expect(subject.events).toContain("dial:http://127.0.0.1:9090/")
    expect(source.counts.get).toBe(2)

    await client.close(background())
    expect(source.counts.stop).toBe(1)
    await expect(client.call(background(), request)).rejects.toThrow("client is closed")
  })

  test("reconciles the initial watcher snapshot without regressing the newer initial read", async () => {
    const stale = selectedEndpoint.instance
    const current: ServiceInstance = Object.freeze({
      ...stale,
      id: "orders-current",
      endpoints: Object.freeze(["http://127.0.0.1:9090/"])
    })
    let getCalls = 0
    const watched = controlledWatch(Object.freeze([stale]), () => {})
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        getCalls += 1
        return Object.freeze([current])
      },
      async watch(): Promise<Watcher> {
        return watched.watcher
      }
    })
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )

    try {
      await client.call(background(), {
        service: "orders",
        endpoint: "Get",
        headers: {},
        body: new Uint8Array()
      })
      await eventually(() => getCalls === 2)
      expect(subject.events).toContain("dial:http://127.0.0.1:9090/")
    } finally {
      await client.close(background())
    }
  })

  test("starts empty, adopts the first nodes, and applies later empty watcher snapshots", async () => {
    const source = controlledDiscovery(Object.freeze([]))
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    try {
      await expect(client.call(background(), request)).rejects.toThrow(
        "no service endpoint is available"
      )
      source.update(Object.freeze([selectedEndpoint.instance]))
      await eventually(() => source.counts.get === 2)
      await client.call(background(), request)
      expect(subject.events).toContain("dial:http://127.0.0.1:8080/")

      source.update(Object.freeze([]))
      await Promise.resolve()
      await expect(client.call(background(), request)).rejects.toThrow(
        "no service endpoint is available"
      )
    } finally {
      await client.close(background())
    }
  })

  test("withBlock waits for the first raw discovery endpoint", async () => {
    const source = controlledDiscovery(Object.freeze([]))
    const subject = harness()
    const client = newClient(
      withBlock(),
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    try {
      const pending = client.call(background(), request)
      void pending.catch(() => {})
      await eventually(() => source.counts.get === 1 && source.counts.watch === 1)
      expect(subject.events).toEqual([])

      source.update(Object.freeze([selectedEndpoint.instance]))
      await pending
      expect(subject.events).toContain("dial:http://127.0.0.1:8080/")
    } finally {
      await client.close(background())
    }
  })

  test("keeps one canceled withBlock waiter local while another reaches readiness", async () => {
    const source = controlledDiscovery(Object.freeze([]))
    const subject = harness()
    const client = newClient(
      withBlock(),
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }
    const cancellation = new Error("first readiness waiter canceled")
    const [firstContext, cancelFirst] = withCancelCause(background())

    try {
      const first = client.call(firstContext, request)
      const second = client.call(background(), request)
      void first.catch(() => {})
      void second.catch(() => {})
      await eventually(() => source.counts.get === 1 && source.counts.watch === 1)

      cancelFirst(cancellation)
      await expect(first).rejects.toBe(cancellation)
      source.update(Object.freeze([selectedEndpoint.instance]))
      await second
      expect(source.counts.watch).toBe(1)
      expect(subject.events.filter((event) => event.startsWith("dial:"))).toEqual([
        "dial:http://127.0.0.1:8080/"
      ])
    } finally {
      await client.close(background())
    }
  })

  test("wakes a pending withBlock call when the Client closes", async () => {
    const source = controlledDiscovery(Object.freeze([]))
    const subject = harness()
    const client = newClient(
      withBlock(),
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const pending = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    })
    void pending.catch(() => {})
    await eventually(() => source.counts.get === 1 && source.counts.watch === 1)

    await client.close(background())

    await expect(pending).rejects.toThrow("client is closed")
    expect(source.counts.stop).toBe(1)
    expect(subject.events).toEqual([])
  })

  test("does not block again after readiness when the authoritative snapshot becomes empty", async () => {
    const source = controlledDiscovery(Object.freeze([selectedEndpoint.instance]))
    const subject = harness()
    const client = newClient(
      withBlock(),
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    try {
      await client.call(background(), request)
      source.update(Object.freeze([]))
      await Promise.resolve()

      await expect(within(client.call(background(), request))).rejects.toThrow(
        "no service endpoint is available"
      )
    } finally {
      await client.close(background())
    }
  })

  test("does not treat an instance without endpoints as ready", async () => {
    const empty: ServiceInstance = Object.freeze({
      ...selectedEndpoint.instance,
      endpoints: Object.freeze([])
    })
    const source = controlledDiscovery(Object.freeze([empty]))
    const subject = harness()
    const client = newClient(
      withBlock(),
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const pending = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    })
    void pending.catch(() => {})

    try {
      await eventually(() => source.counts.get === 2)
      expect(subject.events).toEqual([])
      source.update(Object.freeze([selectedEndpoint.instance]))
      await pending
      expect(subject.events).toContain("dial:http://127.0.0.1:8080/")
    } finally {
      await client.close(background())
    }
  })

  test("uses raw discovery readiness before applying call filters", async () => {
    const source = controlledDiscovery(Object.freeze([selectedEndpoint.instance]))
    const subject = harness()
    const client = newClient(
      withBlock(),
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )

    try {
      await expect(
        within(
          client.call(
            background(),
            {
              service: "orders",
              endpoint: "Get",
              headers: {},
              body: new Uint8Array()
            },
            withFilter(() => [])
          )
        )
      ).rejects.toThrow("no service endpoint is available")
      expect(subject.events).toEqual([])
    } finally {
      await client.close(background())
    }
  })

  test("does not lose a readiness notification delivered before waiter continuation", async () => {
    const source = controlledDiscovery(Object.freeze([]))
    const resolver = newDiscoveryResolver(source.discovery)

    try {
      await resolver.getService(background(), "orders")
      source.update(Object.freeze([selectedEndpoint.instance]))

      await expect(within(resolver.getService(background(), "orders", true))).resolves.toEqual([
        selectedEndpoint.instance
      ])
    } finally {
      await resolver.close(background())
    }
  })

  test("wakes blocked discovery with the exact terminal watcher failure", async () => {
    const nextFailure = new Error("watcher next failed before readiness")
    const stopFailure = new Error("watcher stop failed before readiness")
    const watched = controlledWatch(Object.freeze([]), () => {
      throw stopFailure
    })
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        return Object.freeze([])
      },
      async watch(): Promise<Watcher> {
        return watched.watcher
      }
    })
    const resolver = newDiscoveryResolver(discovery)
    const pending = resolver.getService(background(), "orders", true)
    void pending.catch(() => {})

    watched.fail(nextFailure)
    const failure = await rejected(within(pending, 50))
    const closeFailure = await rejected(resolver.close(background()))

    expect(failure).toBe(closeFailure)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([nextFailure, stopFailure])
  })

  test("keeps the last snapshot and rebuilds a terminal discovery watcher", async () => {
    const first = selectedEndpoint.instance
    const second: ServiceInstance = Object.freeze({
      ...first,
      id: "orders-recovered",
      endpoints: Object.freeze(["http://127.0.0.1:9191/"])
    })
    const source = controlledDiscovery(Object.freeze([first]))
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    try {
      await client.call(background(), request)
      source.update(Object.freeze([second]))
      source.failWatcher(new Error("watch failed"))
      await eventually(() => source.counts.get === 4)
      subject.events.length = 0
      await client.call(background(), request)
      expect(subject.events).toContain("dial:http://127.0.0.1:9191/")
      expect(source.counts.watch).toBe(2)
    } finally {
      await client.close(background())
    }
    expect(source.counts.stop).toBe(2)
  })

  test("clears removed endpoints when a rebuilt discovery watcher opens on an empty registry", async () => {
    const source = controlledDiscovery(Object.freeze([selectedEndpoint.instance]))
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport),
      withBlock()
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    try {
      await client.call(background(), request)
      await eventually(() => source.counts.get === 2)
      source.failWatcher(new Error("watch connection lost"))
      source.update(Object.freeze([]))
      await eventually(() => source.counts.watch === 2)

      subject.events.length = 0
      await expect(within(client.call(background(), request))).rejects.toMatchObject({
        name: "NoAvailableEndpointError"
      })
      expect(subject.events).toEqual([])
      expect(source.counts.get).toBe(3)
    } finally {
      await client.close(background())
    }
    expect(source.counts.stop).toBe(2)
  })

  test("reconciles a rebuilt watcher's stale initial snapshot against the current registry", async () => {
    const first = selectedEndpoint.instance
    const current: ServiceInstance = Object.freeze({ ...first, id: "orders-current" })
    const initial = controlledWatch(Object.freeze([first]), () => {})
    const reopened = controlledWatch(Object.freeze([first]), () => {})
    let watchCalls = 0
    let reopenedNextCalls = 0
    let getCalls = 0
    const discovery: Discovery = {
      async getService(): Promise<readonly ServiceInstance[]> {
        getCalls += 1
        return Object.freeze([watchCalls === 1 ? first : current])
      },
      async watch(): Promise<Watcher> {
        watchCalls += 1
        if (watchCalls === 1) return initial.watcher
        return {
          next(ctx): Promise<readonly ServiceInstance[]> {
            reopenedNextCalls += 1
            return reopened.watcher.next(ctx)
          },
          stop: reopened.watcher.stop
        }
      }
    }
    const resolver = newDiscoveryResolver(discovery)

    try {
      await resolver.getService(background(), "orders")
      await eventually(() => getCalls === 2)
      initial.fail(new Error("watch connection lost"))
      await eventually(() => reopenedNextCalls === 2)

      expect(await resolver.getService(background(), "orders")).toEqual([current])
      expect(getCalls).toBe(4)
    } finally {
      await resolver.close(background())
    }
  })

  test("retains a rebuilt watcher refresh failure together with its cleanup failure", async () => {
    const primary = new Error("reopened registry read failed")
    const cleanup = new Error("reopened watcher cleanup failed")
    let watchCalls = 0
    let stopCalls = 0
    const initial = controlledWatch(Object.freeze([]), () => {
      stopCalls += 1
    })
    const reopened = controlledWatch(Object.freeze([]), () => {
      stopCalls += 1
      throw cleanup
    })
    const resolver = newDiscoveryResolver({
      async getService(): Promise<readonly ServiceInstance[]> {
        if (watchCalls > 1) throw primary
        return Object.freeze([])
      },
      async watch(): Promise<Watcher> {
        watchCalls += 1
        return watchCalls === 1 ? initial.watcher : reopened.watcher
      }
    })
    await resolver.getService(background(), "orders")
    const pending = resolver.getService(background(), "orders", true)
    void pending.catch(() => {})
    initial.fail(new Error("watch connection lost"))

    let failure: Error | undefined
    try {
      failure = await rejected(within(pending, 1_800))
    } finally {
      const closeFailure = await rejected(resolver.close(background()))
      expect(failure).toBe(closeFailure)
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([primary, cleanup])
    expect(watchCalls).toBe(2)
    expect(stopCalls).toBe(2)
  })

  test("drains a late rebuilt watcher refresh without leaking its owner on close", async () => {
    let watchCalls = 0
    let stopCalls = 0
    let getCalls = 0
    const refresh = Promise.withResolvers<readonly ServiceInstance[]>()
    const initial = controlledWatch(Object.freeze([selectedEndpoint.instance]), () => {
      stopCalls += 1
    })
    const reopened = controlledWatch(Object.freeze([]), () => {
      stopCalls += 1
    })
    const resolver = newDiscoveryResolver({
      async getService(): Promise<readonly ServiceInstance[]> {
        getCalls += 1
        if (watchCalls > 1) return await refresh.promise
        return Object.freeze([selectedEndpoint.instance])
      },
      async watch(): Promise<Watcher> {
        watchCalls += 1
        return watchCalls === 1 ? initial.watcher : reopened.watcher
      }
    })

    try {
      await resolver.getService(background(), "orders")
      await eventually(() => getCalls === 2)
      initial.fail(new Error("watch connection lost"))
      await eventually(() => getCalls === 3)
      const closing = resolver.close(background())
      refresh.resolve(Object.freeze([]))
      await within(closing)
      await resolver.close(background())
      expect(stopCalls).toBe(2)
      await expect(resolver.getService(background(), "orders")).rejects.toThrow("client is closed")
    } finally {
      refresh.resolve(Object.freeze([]))
      await resolver.close(background())
    }
  })

  test("preserves discovery admission and watcher rollback failures", async () => {
    const primary = new Error("discovery failed")
    const cleanup = new Error("watcher stop failed")
    const watcher: Watcher = Object.freeze({
      async next(): Promise<readonly ServiceInstance[]> {
        throw new Error("unexpected watcher next")
      },
      async stop(): Promise<void> {
        throw cleanup
      }
    })
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        throw primary
      },
      async watch(): Promise<Watcher> {
        return watcher
      }
    })
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Get",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([primary, cleanup])
    expect(subject.events).toEqual([])
    await client.close(background())
  })

  test("preserves watcher failure when its terminal cleanup also fails", async () => {
    const nextFailure = new Error("watcher next failed")
    const stopFailure = new Error("watcher stop failed")
    let watchCalls = 0
    let nextCalls = 0
    let stopCalls = 0
    const watcher: Watcher = Object.freeze({
      next(): Promise<readonly ServiceInstance[]> {
        nextCalls += 1
        if (nextCalls === 1) return Promise.resolve(Object.freeze([selectedEndpoint.instance]))
        return Promise.reject(nextFailure)
      },
      stop(): Promise<void> {
        stopCalls += 1
        return Promise.reject(stopFailure)
      }
    })
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        return Object.freeze([selectedEndpoint.instance])
      },
      async watch(): Promise<Watcher> {
        watchCalls += 1
        return watcher
      }
    })
    const resolver = newDiscoveryResolver(discovery)

    await resolver.getService(background(), "orders")
    await eventually(() => stopCalls === 1)
    await Bun.sleep(1_100)
    expect(watchCalls).toBe(1)
    const firstClose = resolver.close(background())
    const secondClose = resolver.close(background())
    const [failure, repeatedFailure] = await Promise.all([
      rejected(firstClose),
      rejected(secondClose)
    ])

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([nextFailure, stopFailure])
    expect(repeatedFailure).toBe(failure)
    expect(stopCalls).toBe(1)
    expect(watchCalls).toBe(1)
  })

  test("preserves watcher and cleanup failures that race resolver close", async () => {
    const nextFailure = new Error("watcher next failed during close")
    const stopFailure = new Error("watcher stop failed during close")
    const pendingNext = Promise.withResolvers<readonly ServiceInstance[]>()
    let nextCalls = 0
    let stopCalls = 0
    const watcher: Watcher = Object.freeze({
      next(): Promise<readonly ServiceInstance[]> {
        nextCalls += 1
        if (nextCalls === 1) return Promise.resolve(Object.freeze([selectedEndpoint.instance]))
        return pendingNext.promise
      },
      stop(): Promise<void> {
        stopCalls += 1
        return Promise.reject(stopFailure)
      }
    })
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        return Object.freeze([selectedEndpoint.instance])
      },
      async watch(): Promise<Watcher> {
        return watcher
      }
    })
    const resolver = newDiscoveryResolver(discovery)

    await resolver.getService(background(), "orders")
    await eventually(() => nextCalls === 2)
    const closing = resolver.close(background())
    pendingNext.reject(nextFailure)
    const failure = await rejected(closing)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([nextFailure, stopFailure])
    expect(stopCalls).toBe(1)
  })

  test("reports a null cleanup failure from a watcher admitted after close starts", async () => {
    const firstFailure = new Error("first watcher failed")
    const stopFailure = null
    const lateAdmission = Promise.withResolvers<Watcher>()
    let watchCalls = 0
    let nextCalls = 0
    let lateStops = 0
    const firstWatcher: Watcher = Object.freeze({
      next(): Promise<readonly ServiceInstance[]> {
        nextCalls += 1
        if (nextCalls === 1) return Promise.resolve(Object.freeze([selectedEndpoint.instance]))
        return Promise.reject(firstFailure)
      },
      stop(): Promise<void> {
        return Promise.resolve()
      }
    })
    const lateWatcher: Watcher = Object.freeze({
      next(ctx: Context): Promise<readonly ServiceInstance[]> {
        return Promise.reject(ctx.err() ?? canceled)
      },
      stop(): Promise<void> {
        lateStops += 1
        return Promise.reject(stopFailure)
      }
    })
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        return Object.freeze([selectedEndpoint.instance])
      },
      watch(): Promise<Watcher> {
        watchCalls += 1
        if (watchCalls === 1) return Promise.resolve(firstWatcher)
        return lateAdmission.promise
      }
    })
    const resolver = newDiscoveryResolver(discovery)

    await resolver.getService(background(), "orders")
    await eventually(() => watchCalls === 2)
    const closing = resolver.close(background())
    lateAdmission.resolve(lateWatcher)
    const failure = await rejectedValue(closing)

    expect(failure).toBe(stopFailure)
    expect(watchCalls).toBe(2)
    expect(lateStops).toBe(1)
  })

  test("reports initial watcher rollback failure to its caller and close", async () => {
    const stopFailure = new Error("initial watcher stop failed")
    const admission = Promise.withResolvers<Watcher>()
    let stopCalls = 0
    const watcher: Watcher = Object.freeze({
      next(): Promise<readonly ServiceInstance[]> {
        return Promise.reject(new Error("unexpected watcher next"))
      },
      stop(): Promise<void> {
        stopCalls += 1
        return Promise.reject(stopFailure)
      }
    })
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        return Object.freeze([selectedEndpoint.instance])
      },
      watch(): Promise<Watcher> {
        return admission.promise
      }
    })
    const resolver = newDiscoveryResolver(discovery)

    const getting = resolver.getService(background(), "orders")
    const closing = resolver.close(background())
    admission.resolve(watcher)
    const [callFailure, closeFailure] = await Promise.all([rejected(getting), rejected(closing)])

    expect(callFailure).toBeInstanceOf(AggregateError)
    expect((callFailure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "client is closed" }),
      stopFailure
    ])
    expect(closeFailure).toBe(stopFailure)
    expect(stopCalls).toBe(1)
  })

  test("aggregates watcher cleanup failures in completed admission order", async () => {
    const ordersFailure = new Error("orders watcher stop failed")
    const billingFailure = new Error("billing watcher stop failed")
    const ordersAdmission = Promise.withResolvers<readonly ServiceInstance[]>()
    const billingAdmission = Promise.withResolvers<readonly ServiceInstance[]>()
    /** Creates one complete snapshot for a concurrently admitted service. */
    function snapshot(name: string): readonly ServiceInstance[] {
      return Object.freeze([
        Object.freeze({
          id: `${name}-1`,
          name,
          version: "v1",
          metadata: Object.freeze({}),
          endpoints: Object.freeze([`memory://${name}`])
        })
      ])
    }
    const discovery: Discovery = Object.freeze({
      getService(_ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
        if (name === "orders") return ordersAdmission.promise
        if (name === "billing") return billingAdmission.promise
        return Promise.reject(new Error("unexpected service"))
      },
      async watch(_ctx: Context, name: string): Promise<Watcher> {
        const failure = name === "orders" ? ordersFailure : billingFailure
        let firstSnapshot = true
        return Object.freeze({
          next(ctx: Context): Promise<readonly ServiceInstance[]> {
            if (firstSnapshot) {
              firstSnapshot = false
              return Promise.resolve(snapshot(name))
            }
            return new Promise((_resolve, reject) => {
              ctx
                .done()
                ?.addEventListener("abort", () => reject(cause(ctx) ?? ctx.err() ?? canceled), {
                  once: true
                })
            })
          },
          stop(): Promise<void> {
            return Promise.reject(failure)
          }
        })
      }
    })
    const resolver = newDiscoveryResolver(discovery)

    const orders = resolver.getService(background(), "orders")
    const billing = resolver.getService(background(), "billing")
    billingAdmission.resolve(snapshot("billing"))
    await billing
    ordersAdmission.resolve(snapshot("orders"))
    await orders
    const failure = await rejected(resolver.close(background()))

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([billingFailure, ordersFailure])
  })

  test("aggregates transport and discovery watcher close failures", async () => {
    const watcherFailure = new Error("orders watcher stop failed")
    const transportFailure = new Error("transport close failed")
    /** Creates the current complete snapshot for one admitted service. */
    function serviceSnapshot(name: string): readonly ServiceInstance[] {
      return Object.freeze([
        Object.freeze({
          id: `${name}-1`,
          name,
          version: "v1",
          metadata: Object.freeze({}),
          endpoints: Object.freeze([`memory://${name}`])
        })
      ])
    }
    const discovery: Discovery = Object.freeze({
      async getService(_ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
        return serviceSnapshot(name)
      },
      async watch(_ctx: Context, name: string): Promise<Watcher> {
        if (name !== "orders") throw new Error("unexpected service")
        const initial = serviceSnapshot(name)
        let firstSnapshot = true
        return Object.freeze({
          next(ctx: Context): Promise<readonly ServiceInstance[]> {
            if (firstSnapshot) {
              firstSnapshot = false
              return Promise.resolve(initial)
            }
            return new Promise((_resolve, reject) => {
              const signal = ctx.done()
              signal?.addEventListener("abort", () => reject(cause(ctx) ?? ctx.err() ?? canceled), {
                once: true
              })
            })
          },
          stop(): Promise<void> {
            throw watcherFailure
          }
        })
      }
    })
    const subject = harness({ closeFailure: transportFailure })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    })

    const firstClose = client.close(background())
    const secondClose = client.close(background())
    const [failure, repeatedFailure] = await Promise.all([
      rejected(firstClose),
      rejected(secondClose)
    ])

    expect(failure).toBeInstanceOf(AggregateError)
    const closeFailures = (failure as AggregateError).errors
    expect(closeFailures).toEqual([transportFailure, watcherFailure])
    expect(repeatedFailure).toBe(failure)
  })

  test("bounds each close waiter without canceling the shared watcher shutdown", async () => {
    const releaseStop: { value: (() => void) | null } = { value: null }
    const stopped = new Promise<void>((resolve) => {
      releaseStop.value = resolve
    })
    let nextCalls = 0
    let stopCalls = 0
    const watcher: Watcher = Object.freeze({
      next(ctx: Context): Promise<readonly ServiceInstance[]> {
        nextCalls += 1
        if (nextCalls === 1) return Promise.resolve(Object.freeze([selectedEndpoint.instance]))
        return new Promise((_resolve, reject) => {
          const signal = ctx.done()
          signal?.addEventListener("abort", () => reject(cause(ctx) ?? ctx.err() ?? canceled), {
            once: true
          })
        })
      },
      stop(ctx: Context): Promise<void> {
        stopCalls += 1
        expect(ctx.err()).toBeNull()
        return stopped
      }
    })
    let getCalls = 0
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        getCalls += 1
        return Object.freeze([selectedEndpoint.instance])
      },
      async watch(): Promise<Watcher> {
        return watcher
      }
    })
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    })
    await eventually(() => getCalls === 2)
    const marker = new Error("close Context inspection failed")
    const [baseWaitContext, cancelWait] = withCancelCause(background())
    const waitState = { hostile: false }
    const waitTarget: Context = {
      deadline: () => baseWaitContext.deadline(),
      done: () => baseWaitContext.done(),
      err: () => baseWaitContext.err(),
      value: (key) => baseWaitContext.value(key)
    }
    const waitContext = new Proxy(waitTarget, {
      get(target, key, receiver) {
        if (waitState.hostile && key === "err") throw marker
        return Reflect.get(target, key, receiver)
      }
    })
    const firstClose = client.close(waitContext)
    void firstClose.catch(() => {})
    await eventually(() => stopCalls === 1)

    waitState.hostile = true
    cancelWait(new Error("close waiter canceled"))
    await expect(firstClose).rejects.toBe(marker)
    const secondClose = client.close(background())
    const release = releaseStop.value
    if (release === null) throw new Error("watcher stop was not captured")
    release()
    await secondClose
    expect(stopCalls).toBe(1)
  })

  test("settles a fulfilled Client close when a custom StopFunc throws", async () => {
    const cleanupFailure = new Error("custom StopFunc failed after Client close")
    const client = newClient(withTransport(harness().transport), withEndpoint("memory://orders"))
    const unhandled: unknown[] = []
    function observeUnhandled(reason: unknown): void {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", observeUnhandled)
    try {
      const result = await within(client.close(throwingStopContext(cleanupFailure)), 100)
      await new Promise<void>((resolve) => setTimeout(resolve, 20))

      expect(result).toBeUndefined()
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", observeUnhandled)
    }
  })

  test("preserves a rejected Client close when a custom StopFunc throws", async () => {
    const operationFailure = new Error("Client close failed")
    const cleanupFailure = new Error("custom StopFunc failed after rejected Client close")
    const subject = harness({ closeFailure: operationFailure })
    const client = newClient(withTransport(subject.transport), withEndpoint("memory://orders"))
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    const unhandled: unknown[] = []
    function observeUnhandled(reason: unknown): void {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", observeUnhandled)
    try {
      const result = await rejectedValue(
        within(client.close(throwingStopContext(cleanupFailure)), 100)
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 20))

      expect(result).toBe(operationFailure)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", observeUnhandled)
    }
  })

  test("preserves close Context failures before a resolver drain waiter is installed", async () => {
    const unused: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        throw new Error("unexpected getService")
      },
      async watch(): Promise<Watcher> {
        throw new Error("unexpected watch")
      }
    })

    const initialFailure = new Error("initial err inspection failed")
    const initialTarget: Context = {
      deadline: () => background().deadline(),
      done: () => background().done(),
      err: () => null,
      value: (key) => background().value(key)
    }
    const initial = new Proxy(initialTarget, {
      get(target, key, receiver) {
        if (key === "err") throw initialFailure
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(newDiscoveryResolver(unused).close(initial)).rejects.toBe(initialFailure)

    const causeFailure = new Error("pre-canceled cause inspection failed")
    let causeReads = 0
    const canceledTarget: Context = {
      deadline: () => background().deadline(),
      done: () => background().done(),
      err: () => canceled,
      value: (key) => background().value(key)
    }
    const canceledContext = new Proxy(canceledTarget, {
      get(target, key, receiver) {
        if (key !== "err") return Reflect.get(target, key, receiver)
        causeReads += 1
        if (causeReads === 1) return () => canceled
        throw causeFailure
      }
    })
    await expect(newDiscoveryResolver(unused).close(canceledContext)).rejects.toBe(causeFailure)

    const setupFailure = new Error("afterFunc setup failed")
    let setupReads = 0
    const setupTarget: Context = {
      deadline: () => background().deadline(),
      done: () => background().done(),
      err: () => null,
      value: (key) => background().value(key)
    }
    const setupContext = new Proxy(setupTarget, {
      get(target, key, receiver) {
        if (key !== "err") return Reflect.get(target, key, receiver)
        setupReads += 1
        if (setupReads === 1) return () => null
        throw setupFailure
      }
    })
    await expect(newDiscoveryResolver(unused).close(setupContext)).rejects.toBe(setupFailure)

    const callbackFailure = new Error("afterFunc callback inspection failed")
    const admission: { value: (() => void) | null } = { value: null }
    const controller = new AbortController()
    const callbackState = { hostile: false }
    const callbackTarget: Context & {
      afterFunc(callback: () => void): () => boolean
    } = {
      deadline: () => background().deadline(),
      done: () => controller.signal,
      err: () => null,
      value: (key) => background().value(key),
      afterFunc(callback): () => boolean {
        admission.value = callback
        return () => true
      }
    }
    const callbackContext = new Proxy(callbackTarget, {
      get(target, key, receiver) {
        if (callbackState.hostile && key === "err") throw callbackFailure
        return Reflect.get(target, key, receiver)
      }
    })
    const closing = newDiscoveryResolver(unused).close(callbackContext)
    callbackState.hostile = true
    const admit = admission.value
    if (admit === null) throw new Error("afterFunc callback was not captured")
    admit()
    await expect(closing).rejects.toBe(callbackFailure)
  })

  test("cancels an in-flight watcher admission when the Client closes", async () => {
    let admitWatch: (() => void) | null = null
    const watchEntered = new Promise<void>((resolve) => {
      admitWatch = resolve
    })
    let getCalls = 0
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        getCalls += 1
        return Object.freeze([selectedEndpoint.instance])
      },
      async watch(ctx: Context): Promise<Watcher> {
        admitWatch?.()
        return await new Promise<Watcher>((_resolve, reject) => {
          const signal = ctx.done()
          signal?.addEventListener("abort", () => reject(cause(ctx) ?? ctx.err() ?? canceled), {
            once: true
          })
        })
      }
    })
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const called = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    })
    void called.catch(() => {})
    await watchEntered

    await client.close(background())

    await expect(called).rejects.toThrow("client is closed")
    expect(getCalls).toBe(0)
    expect(subject.events).toEqual([])
  })

  test("lets one caller cancel without poisoning a shared resident admission", async () => {
    let enterWatch: (() => void) | null = null
    const watchEntered = new Promise<void>((resolve) => {
      enterWatch = resolve
    })
    const admitWatcher: { value: ((watcher: Watcher) => void) | null } = { value: null }
    const admitted = new Promise<Watcher>((resolve) => {
      admitWatcher.value = resolve
    })
    let getCalls = 0
    let watchCalls = 0
    let stopCalls = 0
    const controlled = controlledWatch(Object.freeze([selectedEndpoint.instance]), () => {
      stopCalls += 1
    })
    const discovery: Discovery = Object.freeze({
      async getService(): Promise<readonly ServiceInstance[]> {
        getCalls += 1
        return Object.freeze([selectedEndpoint.instance])
      },
      async watch(): Promise<Watcher> {
        watchCalls += 1
        enterWatch?.()
        return await admitted
      }
    })
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }
    const marker = new Error("first caller canceled")
    const [firstContext, cancelFirst] = withCancelCause(background())
    const first = client.call(firstContext, request)
    void first.catch(() => {})
    await watchEntered
    const second = client.call(background(), request)

    cancelFirst(marker)
    await expect(first).rejects.toBe(marker)
    const release = admitWatcher.value
    if (release === null) throw new Error("watcher admission was not captured")
    release(controlled.watcher)
    await second

    await eventually(() => getCalls === 2)
    expect({ getCalls, watchCalls }).toEqual({ getCalls: 2, watchCalls: 1 })
    await client.close(background())
    expect(stopCalls).toBe(1)
  })

  test("runs one discover-select-dial-send-recv exchange and snapshots both Messages", async () => {
    const requestHeader = { tenant: "one", "Go-Like-Method": "POST" }
    const requestBody = new Uint8Array([1, 2, 3])
    const responseHeader = { Node: "a" }
    const responseBody = new Uint8Array([9, 8])
    const key = Object.freeze({})
    const value = Object.freeze({ request: "value" })
    const subject = harness({
      response: responseFrom(responseHeader, responseBody),
      onDiscover() {
        requestHeader.tenant = "changed"
        requestBody[0] = 99
      }
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const rootContext = newClientContext(
      withValue(background(), key, value),
      newMetadata({ baggage: ["one", "two"] })
    )
    const metadataWire = encodeMetadataHeader(newMetadata({ baggage: ["one", "two"] }))
    if (metadataWire === null) throw new Error("Client metadata wire was unexpectedly empty")
    const response = await client.call(rootContext, {
      service: "orders",
      endpoint: "Create",
      headers: requestHeader,
      body: requestBody
    })
    await client.close(background())

    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "fetch",
      "done:ok",
      "close"
    ])
    expect(subject.sent).toHaveLength(1)
    const outbound = subject.sent[0]
    if (outbound === undefined) throw new Error("Client did not send its outbound Request")
    expect(outbound).toEqual({
      url: "http://127.0.0.1:8080/orders/Create",
      method: "POST",
      headers: {
        tenant: "one",
        "go-like-method": "POST",
        "go-like-metadata": metadataWire
      },
      body: new Uint8Array([1, 2, 3])
    })
    expect(outbound.body).not.toBe(requestBody)

    responseHeader.Node = "changed"
    responseBody[0] = 77
    expect(response.headers.get("node")).toBe("a")
    expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
    expect(response).toBeInstanceOf(Response)

    expect(transportFromClientContext(rootContext)).toBeNull()
    expect(subject.dialContexts).toHaveLength(1)
    expect(subject.fetchContexts).toEqual(subject.dialContexts)
    expect(subject.fetchContexts).toEqual(subject.dialContexts)
    const transportInfo = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (transportInfo === null) throw new Error("Client did not inject TransportInfo")
    expect(transportInfo.kind()).toBe("http")
    expect(transportInfo.endpoint()).toBe("http://127.0.0.1:8080/")
    expect(transportInfo.operation()).toBe("orders/Create")
    expect(transportInfo.requestHeaders()).toEqual({
      "go-like-metadata": [metadataWire],
      "go-like-method": ["POST"],
      tenant: ["one"]
    })
    expect(transportInfo.replyHeaders()).toEqual({ node: ["a"] })
    expect(transportInfo.peerIdentity()).toBeNull()
    expect(fromClientContext(subject.dialContexts[0] ?? background())).toEqual({
      baggage: ["one", "two"]
    })
    expect(outbound.headers).not.toHaveProperty("baggage")
    expect(transportInfo.requestHeaders()).not.toHaveProperty("baggage")

    expect(subject.outcomes).toHaveLength(1)
    expect(subject.outcomes[0]).toEqual(expectedSelectionOutcome(null, true, true, { Node: "a" }))
    expect(Object.isFrozen(subject.outcomes[0])).toBe(true)
    const replyMetadata = subject.outcomes[0]?.replyMetadata
    if (replyMetadata === undefined) throw new Error("Client did not publish reply metadata")
    expect(replyMetadata).toEqual({ node: ["a"] })
    expect(Object.isFrozen(replyMetadata)).toBe(true)
    expect(Object.isFrozen(replyMetadata.node)).toBe(true)
    const feedbackContext = subject.feedbackContexts[0]
    if (feedbackContext === undefined) throw new Error("Client did not publish selection feedback")
    expect(feedbackContext.done()).toBeNull()
    expect(feedbackContext.err()).toBeNull()
    expect(feedbackContext.value(key)).toBe(value)
    expectBoundedClose(subject.closeContexts)
    expect(Object.isFrozen(client)).toBe(true)
  })

  test("captures structural dependency methods and their receivers at construction", async () => {
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    Reflect.set(subject.discovery, "getService", () => {
      throw new Error("mutated discovery method called")
    })
    Reflect.set(subject.selector, "select", () => {
      throw new Error("mutated selector method called")
    })
    Reflect.set(subject.transport, "dial", () => {
      throw new Error("mutated transport method called")
    })

    await client.call(background(), {
      service: "orders-v2",
      endpoint: "CreateV2",
      headers: {},
      body: new Uint8Array()
    })
    await client.close(background())
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "fetch",
      "done:ok",
      "close"
    ])
  })

  test("captures admitted transport client methods before borrowed callbacks can mutate them", async () => {
    let replacementRecvCalls = 0
    let replacementCloseCalls = 0
    const subject = harness({
      onFetch(_ctx, _request, transportClient) {
        Reflect.set(transportClient, "fetch", async function replacementFetch(): Promise<Response> {
          replacementRecvCalls += 1
          return responseFrom({ node: "a" }, new Uint8Array([1]))
        })
      },
      onFeedback(transportClient) {
        Reflect.set(transportClient, "close", async function replacementClose(): Promise<void> {
          replacementCloseCalls += 1
        })
      }
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const response = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    await client.close(background())

    expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
    expect(replacementRecvCalls).toBe(0)
    expect(replacementCloseCalls).toBe(0)
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "fetch",
      "done:ok",
      "close"
    ])
  })

  test("rejects a malformed admitted client after closing its captured owner", async () => {
    const subject = harness()
    let malformedCloseCalls = 0
    Reflect.set(
      subject.transport,
      "dial",
      async function malformedDial(this: Transport, _ctx: Context, address: string) {
        expect(this).toBe(subject.transport)
        subject.events.push(`dial:${address}`)
        return {
          async close(closeContext: Context): Promise<void> {
            malformedCloseCalls += 1
            subject.closeContexts.push(closeContext)
          }
        }
      }
    )
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure).toBeInstanceOf(TypeError)
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(failure, false, false)])
    expect(malformedCloseCalls).toBe(1)
    expectBoundedClose(subject.closeContexts)
  })

  test("closes an admitted owner when a later method getter rejects", async () => {
    const accessorFailure = new Error("send getter failed")
    const subject = harness()
    let closes = 0
    Reflect.set(subject.transport, "dial", async function hostileDial(): Promise<never> {
      const admitted = {
        async close(): Promise<void> {
          closes += 1
        }
      }
      Object.defineProperty(admitted, "fetch", {
        get() {
          throw accessorFailure
        }
      })
      return admitted as never
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure).toBe(accessorFailure)
    expect(closes).toBe(1)
    await client.close(background())
    expect(closes).toBe(1)
  })

  test("rejects malformed transport owners and preserves admission cleanup failure", async () => {
    const withoutClose = harness()
    Reflect.set(withoutClose.transport, "dial", async function malformedDial(): Promise<never> {
      return {
        fetch(): Promise<Response> {
          return Promise.resolve(responseFrom({ node: "a" }, new Uint8Array()))
        }
      } as never
    })
    const missingCloseClient = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(withoutClose.discovery),
      withSelector(withoutClose.selector),
      withTransport(withoutClose.transport)
    )
    await expect(
      missingCloseClient.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    ).rejects.toThrow("transport dial must return a Client with fetch and close")

    const cleanupFailure = new Error("malformed owner close failed")
    const withFailingClose = harness()
    Reflect.set(withFailingClose.transport, "dial", async function malformedDial(): Promise<never> {
      return {
        close(): Promise<void> {
          throw cleanupFailure
        }
      } as never
    })
    const failingCloseClient = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(withFailingClose.discovery),
      withSelector(withFailingClose.selector),
      withTransport(withFailingClose.transport)
    )
    const failure = await rejected(
      failingCloseClient.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBeInstanceOf(TypeError)
    expect((failure as AggregateError).errors[1]).toBe(cleanupFailure)
  })

  test("rejects malformed dependencies at construction", () => {
    const subject = harness()
    expect(() => newClient()).toThrow("requires a transport option")
    expect(() => Reflect.apply(withDiscovery, undefined, [null])).toThrow(TypeError)
    expect(() => Reflect.apply(withSelector, undefined, [{}])).toThrow(TypeError)
    expect(() => Reflect.apply(withTransport, undefined, [{}])).toThrow(TypeError)

    const invalidOptions = [
      (options: Parameters<ClientOption>[0]) => ({
        addresses: options.addresses,
        service: options.service,
        discovery: {},
        selector: options.selector,
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: options.operationMiddleware,
        closeTimeoutMs: options.closeTimeoutMs
      }),
      (options: Parameters<ClientOption>[0]) => ({
        addresses: options.addresses,
        service: options.service,
        discovery: options.discovery,
        selector: {},
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: options.operationMiddleware,
        closeTimeoutMs: options.closeTimeoutMs
      }),
      (options: Parameters<ClientOption>[0]) => ({
        addresses: options.addresses,
        service: options.service,
        discovery: options.discovery,
        selector: options.selector,
        transport: {},
        middleware: options.middleware,
        operationMiddleware: options.operationMiddleware,
        closeTimeoutMs: options.closeTimeoutMs
      })
    ]
    for (const invalid of invalidOptions) {
      expect(() =>
        Reflect.apply(newClient, undefined, [
          withEndpoint("discovery:///orders"),
          withDiscovery(subject.discovery),
          withSelector(subject.selector),
          withTransport(subject.transport),
          invalid
        ])
      ).toThrow(TypeError)
    }
    expect(() =>
      Reflect.apply(newClient, undefined, [null, subject.selector, subject.transport])
    ).toThrow(TypeError)
    expect(() =>
      Reflect.apply(newClient, undefined, [subject.discovery, {}, subject.transport])
    ).toThrow(TypeError)
    expect(() =>
      Reflect.apply(newClient, undefined, [subject.discovery, subject.selector, {}])
    ).toThrow(TypeError)
  })

  test("uses an independent round-robin selector when Discovery has no override", async () => {
    const instances = Object.freeze([
      Object.freeze({
        id: "orders-a",
        name: "orders",
        version: "v1",
        endpoints: Object.freeze(["memory://orders-a"]),
        metadata: Object.freeze({})
      }),
      Object.freeze({
        id: "orders-b",
        name: "orders",
        version: "v1",
        endpoints: Object.freeze(["memory://orders-b"]),
        metadata: Object.freeze({})
      })
    ])
    const firstDiscovery = controlledDiscovery(instances)
    const secondDiscovery = controlledDiscovery(instances)
    const firstSubject = harness()
    const secondSubject = harness()
    const first = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(firstDiscovery.discovery),
      withTransport(firstSubject.transport)
    )
    const second = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(secondDiscovery.discovery),
      withTransport(secondSubject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    // dx.md 7.5: a raw body holds its connection until the caller reads it.
    await bodyBytes(await first.call(background(), request))
    await bodyBytes(await first.call(background(), request))
    await bodyBytes(await first.call(background(), request))
    await bodyBytes(await second.call(background(), request))

    expect(firstSubject.events.filter((event) => event.startsWith("dial:"))).toEqual([
      "dial:memory://orders-a",
      "dial:memory://orders-b"
    ])
    expect(secondSubject.events.filter((event) => event.startsWith("dial:"))).toEqual([
      "dial:memory://orders-a"
    ])
    await first.close(background())
    await second.close(background())
  })

  test("calls one typed endpoint and keeps the raw Fetch call", async () => {
    const NumberValue = struct.number()
    const operation = endpoint("orders", "Create", NumberValue, NumberValue)
    const subject = harness({
      response: responseFrom(
        { "content-type": "Application/JSON; charset=utf-8" },
        new TextEncoder().encode("42")
      )
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withTransport(subject.transport)
    )

    await expect(client.call(background(), operation, 7)).resolves.toBe(42)
    expect(subject.sent).toHaveLength(1)
    expect(subject.sent[0]).toEqual({
      url: "http://127.0.0.1:8080/orders/Create",
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: new TextEncoder().encode("7")
    })

    const raw = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    expect(await bodyBytes(raw)).toEqual(new TextEncoder().encode("42"))
    await client.close(background())
  })

  test("maps malformed typed responses to TransportProtocolError", async () => {
    const NumberValue = struct.number()
    const operation = endpoint("orders", "Create", NumberValue, NumberValue)
    const responses = [
      {
        response: responseFrom({}, new TextEncoder().encode("1")),
        reply: {}
      },
      {
        response: responseFrom({ "content-type": "text/plain" }, new TextEncoder().encode("1")),
        reply: { "content-type": "text/plain" }
      },
      {
        response: responseFrom(
          { "content-type": "application/json" },
          new TextEncoder().encode('"invalid"')
        ),
        reply: { "content-type": "application/json" }
      }
    ]

    for (const candidate of responses) {
      const subject = harness({ response: candidate.response })
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      const failure = await rejected(client.call(background(), operation, 1))
      expect(failure).toMatchObject({
        name: "TransportProtocolError",
        code: "GO_LIKE_TRANSPORT_PROTOCOL",
        message: "client typed response is invalid"
      })
      expect(subject.outcomes).toEqual([
        expectedSelectionOutcome(failure, true, true, candidate.reply)
      ])
      await client.close(background())
    }
  })

  test("keeps typed response validation inside selector, retry, and operation middleware", async () => {
    const NumberValue = struct.number()
    const operation = endpoint("orders", "Create", NumberValue, NumberValue)
    const subject = harness({
      response: responseFrom(
        { "content-type": "application/json" },
        new TextEncoder().encode('"invalid"')
      )
    })
    const observed: Error[] = []
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      use(
        "orders/Create",
        (next) =>
          async (ctx, request, ...options) => {
            try {
              return await next(ctx, request, ...options)
            } catch (value) {
              if (value instanceof Error) observed.push(value)
              throw value
            }
          },
        circuitBreakerMiddleware({ failureThreshold: 1, resetTimeoutMs: 60_000 })
      )
    )
    let retryFailure: Error | null = null

    const failure = await rejected(
      client.call(
        background(),
        operation,
        1,
        withRetry({
          authorization: "idempotent",
          maxAttempts: 2,
          shouldRetry(_ctx, value) {
            if (value instanceof Error) retryFailure = value
            return true
          }
        })
      )
    )

    expect(retryFailure === subject.outcomes[0]?.error).toBe(true)
    expect(subject.outcomes).toEqual([
      expectedSelectionOutcome(retryFailure, true, true, {
        "content-type": "application/json"
      }),
      expectedSelectionOutcome(failure, true, true, {
        "content-type": "application/json"
      })
    ])
    expect(observed).toEqual([failure])
    await expect(client.call(background(), operation, 1)).rejects.toBe(circuitOpen)
    expect(subject.sent).toHaveLength(2)
    await client.close(background())
  })

  test("rejects malformed typed calls before service I/O", async () => {
    const subject = harness()
    const NumberValue = struct.number()
    const operation = endpoint("orders", "Create", NumberValue, NumberValue)
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withTransport(subject.transport)
    )

    await expect(
      Reflect.apply(client.call, client, [background(), operation, "invalid"])
    ).rejects.toThrow()
    await expect(Reflect.apply(client.call, client, [background(), null])).rejects.toThrow(
      "Client call requires a request or Endpoint"
    )
    await expect(Reflect.apply(client.call, client, [background(), operation])).rejects.toThrow(
      "Client typed call requires a request value"
    )
    await expect(
      Reflect.apply(client.call, client, [background(), operation, 1, null])
    ).rejects.toThrow("Client call option must be a function")
    expect(subject.events).toEqual([])
    await client.close(background())
  })

  test("rejects invalid service and endpoint strings before discovery", async () => {
    for (const [field, value] of [
      ["service", null],
      ["service", ""],
      ["service", "\ud800"],
      ["service", "orders/admin"],
      ["service", "orders*"],
      ["service", "orders\u0000"],
      ["service", "orders\u007f"],
      ["service", " orders"],
      ["service", "orders "],
      ["service", "orders admin"],
      ["service", "订单"],
      ["service", "orders😀"],
      ["endpoint", 1],
      ["endpoint", ""],
      ["endpoint", "\udfff"],
      ["endpoint", "Create/Sync"],
      ["endpoint", "Create*"],
      ["endpoint", "Create\u001f"],
      ["endpoint", "Create\u007f"],
      ["endpoint", " Create"],
      ["endpoint", "Create "],
      ["endpoint", "Create Sync"],
      ["endpoint", "创建"],
      ["endpoint", "Créate"]
    ] as const) {
      const subject = harness()
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      const request = {
        service: field === "service" ? value : "orders",
        endpoint: field === "endpoint" ? value : "Create",
        headers: {},
        body: new Uint8Array()
      }
      await expect(
        Reflect.apply(client.call, client, [background(), request])
      ).rejects.toBeInstanceOf(TypeError)
      expect(subject.events).toEqual([])
    }
  })

  test("rejects either reserved header case-insensitively before discovery", async () => {
    for (const header of [
      { "GO-LIKE-METADATA": "caller" },
      { "go-like-timeout-ms": "10" }
    ] as const) {
      const subject = harness()
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      await expect(
        client.call(background(), {
          service: "orders",
          endpoint: "Create",
          headers: header,
          body: new Uint8Array()
        })
      ).rejects.toBeInstanceOf(TypeError)
      expect(subject.events).toEqual([])
    }
  })

  test("projects large TransportInfo headers in one grouped snapshot without losing valid neighbors", async () => {
    const requestHeader: Record<string, string> = {
      "X-Duplicate": "first",
      "x-duplicate": "second"
    }
    for (let index = 0; index < 2_000; index += 1) {
      requestHeader[`x-request-${index}`] = String(index)
    }
    const responseHeader: Record<string, string> = {
      "X-Duplicate": "first",
      "x-duplicate": "second",
      "x-oversize": "x".repeat(4_097)
    }
    for (let index = 0; index < 2_000; index += 1) {
      responseHeader[`x-response-${index}`] = String(index)
    }
    const subject = harness({
      response: responseFrom(responseHeader, new Uint8Array([1]))
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const response = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: requestHeader,
      body: new Uint8Array()
    })

    expect(response.headers.get("x-duplicate")).toBe("first, second")
    expect(response.headers.get("x-response-1999")).toBe("1999")
    expect(response.headers.get("x-oversize")).toBe("x".repeat(4_097))
    expect(subject.events).toContain("dial:http://127.0.0.1:8080/")
    expect(subject.sent[0]?.headers["x-duplicate"]).toBe("first, second")
    const info = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (info === null) throw new Error("Transport did not receive TransportInfo")
    const requestProjection = info.requestHeaders()
    expect(Object.keys(requestProjection)).toHaveLength(2_001)
    expect(requestProjection["x-duplicate"]).toEqual(["first, second"])
    expect(requestProjection["x-request-1999"]).toEqual(["1999"])
    expect(requestProjection).not.toHaveProperty("go-like-service")
    expect(requestProjection).not.toHaveProperty("go-like-endpoint")
    const replyProjection = info.replyHeaders()
    expect(Object.keys(replyProjection)).toHaveLength(2_002)
    expect(replyProjection["x-duplicate"]).toEqual(["first, second"])
    expect(replyProjection["x-response-1999"]).toEqual(["1999"])
    expect(replyProjection["x-oversize"]).toEqual(["x".repeat(4_097)])
    await client.close(background())

    for (const headers of [
      { "bad key": "still-on-wire" },
      { "bad-value": "contains\0control" },
      { emoji: "😀" },
      { "": "empty-key" },
      { "\ud800": "unpaired-key" },
      { "bad-surrogate-value": "\ud800" },
      1,
      null
    ]) {
      const rejectedSubject = harness()
      const rejectedClient = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(rejectedSubject.discovery),
        withSelector(rejectedSubject.selector),
        withTransport(rejectedSubject.transport)
      )
      await expect(
        rejectedClient.call(background(), {
          service: "orders",
          endpoint: "Create",
          headers: headers as HeadersInit,
          body: new Uint8Array()
        })
      ).rejects.toThrow("CallRequest.headers must be a header record")
      expect(rejectedSubject.events).toEqual([])
      await rejectedClient.close(background())
    }
  })

  test("rejects malformed Selector tuples before unary target I/O", async () => {
    const invalidSelections: readonly unknown[] = [
      null,
      [],
      [selectedEndpoint],
      [selectedEndpoint, function complete(): void {}, "extra"],
      [null, function complete(): void {}],
      [[selectedEndpoint], function complete(): void {}],
      [{ url: "" }, function complete(): void {}],
      [{ url: "\ud800" }, function complete(): void {}],
      [selectedEndpoint, null]
    ]
    for (const selection of invalidSelections) {
      const subject = harness()
      Reflect.set(subject.selector, "select", function malformedSelector(): unknown {
        subject.events.push("select")
        return selection
      })
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )

      await expect(
        client.call(background(), {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        })
      ).rejects.toBeInstanceOf(TypeError)
      expect(subject.events).toEqual(["discover:orders", "discover:orders", "select"])
      expect(subject.dialContexts).toEqual([])
      expect(subject.outcomes).toEqual([])
    }
  })

  test("uses one construction-time direct address without a call option", async () => {
    const subject = harness()
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint("memory://orders-direct")
    )

    const response = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    await client.close(background())

    expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
    expect(subject.events).toEqual(["dial:memory://orders-direct", "fetch", "close"])
  })

  test("feeds every direct address to one injected Selector and dials its choice", async () => {
    const subject = harness()
    const selector: Selector = Object.freeze({
      select(
        _ctx: Context,
        instances: readonly ServiceInstance[]
      ): readonly [ServiceEndpoint, SelectionDone] {
        expect(Object.isFrozen(instances)).toBe(true)
        expect(instances).toHaveLength(1)
        const instance = instances[0]
        if (instance === undefined) throw new Error("missing direct instance")
        expect(instance).toEqual({
          id: "",
          name: "orders",
          version: "",
          metadata: {},
          endpoints: ["memory://orders-a", "memory://orders-b"]
        })
        expect(Object.isFrozen(instance)).toBe(true)
        expect(Object.isFrozen(instance.metadata)).toBe(true)
        expect(Object.isFrozen(instance.endpoints)).toBe(true)
        return Object.freeze([
          Object.freeze({ instance, url: instance.endpoints[1] ?? "" }),
          function complete(): void {}
        ])
      }
    })
    const client = newClient(
      withTransport(subject.transport),
      withSelector(selector),
      withEndpoint(["memory://orders-a", "memory://orders-b"])
    )

    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })

    expect(subject.events.filter((event) => event.startsWith("dial:"))).toEqual([
      "dial:memory://orders-b"
    ])
    await client.close(background())
  })

  test("reuses one published direct snapshot per service across attempts", async () => {
    const subject = harness()
    const seen: (readonly ServiceInstance[])[] = []
    const client = newClient(
      withTransport(subject.transport),
      withSelector(recordingSelector(seen)),
      withEndpoint(["memory://orders-b", "memory://orders-a"])
    )

    for (const service of ["orders", "orders", "billing", "orders", "billing"]) {
      await completeCall(client, service)
    }

    expect(seen).toHaveLength(5)
    const [first, second, other, third, otherAgain] = seen
    if (first === undefined || other === undefined) throw new Error("missing direct snapshot")
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(otherAgain).toBe(other)
    expect(other).not.toBe(first)
    expect(first).toEqual([
      {
        id: "",
        name: "orders",
        version: "",
        metadata: {},
        endpoints: ["memory://orders-a", "memory://orders-b"]
      }
    ])
    expect(other[0]?.name).toBe("billing")
    // A published snapshot is deeply frozen and recognized, not copied, by the registry helper.
    for (const snapshot of [first, other]) {
      expect(Object.isFrozen(snapshot)).toBe(true)
      for (const instance of snapshot) {
        expect(Object.isFrozen(instance)).toBe(true)
        expect(Object.isFrozen(instance.metadata)).toBe(true)
        expect(Object.isFrozen(instance.endpoints)).toBe(true)
      }
      expect(snapshotServiceInstances(snapshot)).toBe(snapshot)
    }
    await client.close(background())
  })

  test("rebuilds a direct snapshot after the bounded per-service cache turns over", async () => {
    const subject = harness()
    const seen: (readonly ServiceInstance[])[] = []
    const client = newClient(
      withTransport(subject.transport),
      withSelector(recordingSelector(seen)),
      withEndpoint("memory://orders")
    )

    // Call n is recorded at seen[n]: 1,024 services fit, so service-0 is still cached.
    for (let index = 0; index < 1_024; index += 1) await completeCall(client, `service-${index}`)
    await completeCall(client, "service-0")
    expect(seen[1_024]).toBe(seen[0])

    // One more service turns the cache over: service-0 is rebuilt, the newest one stays cached.
    await completeCall(client, "service-1024")
    await completeCall(client, "service-0")
    await completeCall(client, "service-1024")
    expect(seen[1_026]).not.toBe(seen[0])
    expect(seen[1_026]).toEqual(seen[0])
    expect(seen[1_027]).toBe(seen[1_025])
    await client.close(background())
  })

  test("keeps the configured direct instance when its addresses cannot be published", async () => {
    const subject = harness()
    const seen: (readonly ServiceInstance[])[] = []
    const addresses = ["memory://orders-b", "http://user:secret@example.test/"]
    const client = newClient(
      withTransport(subject.transport),
      withSelector(recordingSelector(seen)),
      withEndpoint(addresses)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    // The injected Selector alone decides; configured order and credentials reach it unchanged.
    await bodyBytes(await client.call(background(), request))
    await bodyBytes(await client.call(background(), request))
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual([
      { id: "", name: "orders", version: "", metadata: {}, endpoints: addresses }
    ])
    expect(Object.isFrozen(seen[0])).toBe(true)
    expect(Object.isFrozen(seen[0]?.[0])).toBe(true)
    expect(subject.events.filter((event) => event.startsWith("dial:"))).toEqual([
      "dial:memory://orders-b"
    ])
    await client.close(background())

    // The built-in Selector reports the registry validation failure, after cancellation.
    for (const address of ["http://example.test/#fragment", "http://user:secret@example.test/"]) {
      const builtIn = newClient(withTransport(subject.transport), withEndpoint(address))
      const failure = await rejected(builtIn.call(background(), request))
      expect(failure).toBeInstanceOf(TypeError)
      expect(failure.message).toBe("ServiceInstance endpoint must omit credentials and fragments")
      const [ctx, cancel] = withCancelCause(background())
      const reason = new Error("caller gave up")
      cancel(reason)
      expect(await rejected(builtIn.call(ctx, request))).toBe(reason)
      await builtIn.close(background())
    }
  })

  test("lets the built-in Selector hand out published direct and discovery instances as is", async () => {
    const seen: (readonly ServiceInstance[])[] = []
    const chosen: ServiceEndpoint[] = []
    const builtIn = newRoundRobinSelector()
    const selector: Selector = Object.freeze({
      select(
        ctx: Context,
        instances: readonly ServiceInstance[]
      ): readonly [ServiceEndpoint, SelectionDone] {
        seen.push(instances)
        const selected = builtIn.select(ctx, instances)
        chosen.push(selected[0])
        return selected
      }
    })
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    const direct = newClient(
      withTransport(harness().transport),
      withSelector(selector),
      withEndpoint(["memory://orders-b", "memory://orders-a"])
    )
    await bodyBytes(await direct.call(background(), request))
    await bodyBytes(await direct.call(background(), request))
    await direct.close(background())
    expect(chosen.map((endpoint) => endpoint.url)).toEqual([
      "memory://orders-a",
      "memory://orders-b"
    ])
    expect(seen[1]).toBe(seen[0])
    expect(chosen[0]?.instance).toBe(seen[0]?.[0])
    expect(chosen[1]?.instance).toBe(seen[1]?.[0])

    const published = snapshotServiceInstances([
      {
        id: "orders-a",
        name: "orders",
        version: "v1",
        metadata: {},
        endpoints: ["memory://orders-a"]
      }
    ])
    const source = controlledDiscovery(published)
    const discovered = newClient(
      withTransport(harness().transport),
      withSelector(selector),
      withEndpoint("discovery:///orders"),
      withDiscovery(source.discovery)
    )
    await bodyBytes(await discovered.call(background(), request))
    await discovered.close(background())
    expect(seen[2]).toBe(published)
    expect(chosen[2]?.instance).toBe(published[0])
  })

  test("round-robins consecutive successful direct calls across configured addresses", async () => {
    const subject = harness()
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint(["memory://orders-a", "memory://orders-b"])
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    await client.call(background(), request)
    await client.call(background(), request)

    expect(subject.events.filter((event) => event.startsWith("dial:"))).toEqual([
      "dial:memory://orders-a",
      "dial:memory://orders-b"
    ])
    await client.close(background())
  })

  test("publishes direct SelectionDone once with each real exchange outcome", async () => {
    const failure = new Error("second receive failed")
    let receives = 0
    const subject = harness({
      onFetch() {
        receives += 1
        if (receives === 2) throw failure
      }
    })
    const outcomes: SelectionOutcome[] = []
    const selector: Selector = Object.freeze({
      select(
        _ctx: Context,
        instances: readonly ServiceInstance[]
      ): readonly [ServiceEndpoint, SelectionDone] {
        const instance = instances[0]
        const url = instance?.endpoints[0]
        if (instance === undefined || url === undefined) throw new Error("missing direct endpoint")
        return Object.freeze([
          Object.freeze({ instance, url }),
          function complete(_ctx: Context, outcome: SelectionOutcome): void {
            outcomes.push(outcome)
          }
        ])
      }
    })
    const client = newClient(
      withTransport(subject.transport),
      withSelector(selector),
      withEndpoint("memory://orders")
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    await client.call(background(), request)
    await expect(client.call(background(), request)).rejects.toBe(failure)

    expect(outcomes).toEqual([
      expectedSelectionOutcome(null, true, true, { node: "a" }),
      expectedSelectionOutcome(failure, true, false)
    ])
    await client.close(background())
  })

  test("rejects invalid construction-time addressing states", () => {
    const subject = harness()
    expect(() =>
      newClient(
        withTransport(subject.transport),
        withEndpoint("memory://orders"),
        withDiscovery(subject.discovery)
      )
    ).toThrow("newClient cannot combine direct addresses with discovery")
    expect(() =>
      newClient(withTransport(subject.transport), withDiscovery(subject.discovery))
    ).toThrow("newClient requires a discovery endpoint when withDiscovery is configured")
    expect(() =>
      newClient(withTransport(subject.transport), withEndpoint("discovery:///orders-registry"))
    ).toThrow("newClient discovery endpoint requires withDiscovery")
    expect(() => newClient(withTransport(subject.transport))).toThrow(
      "newClient requires direct addresses or discovery"
    )
    expect(subject.events).toEqual([])
  })

  test("rejects zero, empty, malformed, and duplicate direct addresses before dialing", () => {
    const subject = harness()
    expect(() => withEndpoint([])).toThrow(TypeError)
    expect(() => withEndpoint("")).toThrow(TypeError)
    expect(() => withEndpoint("\ud800")).toThrow(TypeError)
    expect(() => withEndpoint(["memory://orders", "memory://orders"])).toThrow(TypeError)
    expect(subject.events).toEqual([])
  })

  test("uses orders-http construction service while preserving the request wire service", async () => {
    const subject = harness()
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint("discovery:///orders-http"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector)
    )

    await client.call(background(), {
      service: "orders-contract",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })

    expect(subject.events[0]).toBe("discover:orders-http")
    expect(subject.events).toContain("dial:http://127.0.0.1:8080/")
    expect(subject.sent[0]?.url).toBe("http://127.0.0.1:8080/orders-contract/Create")
    expect(subject.sent[0]?.headers["go-like-service"]).toBeUndefined()
    const transportInfo = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (transportInfo === null) throw new Error("Discovery call did not inject TransportInfo")
    expect(transportInfo.operation()).toBe("orders-contract/Create")
    await client.close(background())
  })

  test("uses one direct address through the default Selector without scheme filtering", async () => {
    const subject = harness()
    Reflect.set(subject.transport, "kind", function invalidKind(): string {
      throw new Error("optional kind failed")
    })
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint("memory://orders-direct"),
      middleware((next) => async (ctx, request, ...options) => {
        expect(options).toHaveLength(1)
        return await next(ctx, request, ...options)
      })
    )

    const response = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    await client.close(background())

    expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
    expect(subject.events).toEqual(["dial:memory://orders-direct", "fetch", "close"])
    const transportInfo = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (transportInfo === null) throw new Error("Direct call did not inject TransportInfo")
    expect(transportInfo.kind()).toBe("transport")
    expect(transportInfo.endpoint()).toBe("memory://orders-direct")
    expect(transportInfo.operation()).toBe("orders/Create")
  })

  test("carries a published call-option snapshot through every layer without copying it", async () => {
    const { client, forwarded, downstream } = optionProbe()
    const keepAll: Filter = (instances) => instances
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    await bodyBytes(await client.call(background(), request, withFilter(keepAll)))
    const published = forwarded[0]
    if (published === undefined) throw new Error("missing published call options")
    expect(published.filters).toEqual([keepAll])
    expect(Object.isFrozen(published)).toBe(true)
    expect(Object.isFrozen(published.filters)).toBe(true)

    // Raw, middleware, and typed layers all receive the published snapshot itself.
    await bodyBytes(await client.call(background(), request, () => published))
    expect(await client.call(background(), optionOperation, 1, () => published)).toBe(1)
    expect(forwarded).toHaveLength(3)
    expect(downstream).toHaveLength(3)
    for (const observed of [forwarded[1], forwarded[2], downstream[1], downstream[2]]) {
      expect(observed).toBe(published)
    }
    await client.close(background())
  })

  test("applies each user call option once and in declaration order", async () => {
    const { client, arities } = optionProbe()
    const applied: string[] = []
    const named = (name: string): CallOption =>
      function namedOption(current): CallOptions {
        applied.push(name)
        return current
      }
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    expect(await client.call(background(), optionOperation, 1, named("a"), named("b"))).toBe(1)
    expect(applied).toEqual(["a", "b"])
    await bodyBytes(await client.call(background(), request, named("c"), named("d")))
    expect(applied).toEqual(["a", "b", "c", "d"])
    // Middleware still sees exactly one resolved option, however many the caller supplied.
    expect(arities).toEqual([1, 1])
    await client.close(background())
  })

  test("shares the default call options between calls that pass no option", async () => {
    const { client, forwarded, arities } = optionProbe()
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    await bodyBytes(await client.call(background(), request))
    await bodyBytes(await client.call(background(), request))
    expect(await client.call(background(), optionOperation, 1)).toBe(1)
    expect(await client.call(background(), optionOperation, 1)).toBe(1)
    expect(arities).toEqual([1, 1, 1, 1])
    const defaults = forwarded[0]
    if (defaults === undefined) throw new Error("missing default call options")
    expect(defaults).toEqual({ filters: [], retry: null })
    expect(Object.isFrozen(defaults)).toBe(true)
    expect(forwarded).toHaveLength(4)
    for (const observed of forwarded.slice(1)) expect(observed).toBe(defaults)
    await client.close(background())
  })

  test("copies and validates every call option that no snapshot published", async () => {
    const { client, forwarded } = optionProbe()
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    // Frozen is not published: a look-alike is copied, never adopted.
    const lookalike: CallOptions = Object.freeze({ filters: Object.freeze([]), retry: null })
    await bodyBytes(await client.call(background(), request, () => lookalike))
    expect(await client.call(background(), optionOperation, 1, () => lookalike)).toBe(1)
    for (const observed of forwarded) {
      expect(observed).toEqual(lookalike)
      expect(observed).not.toBe(lookalike)
    }

    const invalid: readonly (readonly [unknown, string])[] = [
      [null, "Call options must be an object"],
      [[], "Call options must be an object"],
      [{ filters: null, retry: null }, "CallOptions.filters must be an array"],
      [
        Object.freeze({ filters: Object.freeze([1]), retry: null }),
        "call filter must be a function"
      ],
      [{ filters: [], retry: 1 }, "CallOptions.retry must be a retry options object or null"]
    ]
    for (const [value, message] of invalid) {
      const option: CallOption = () => value as CallOptions
      await expect(client.call(background(), request, option)).rejects.toThrow(message)
      await expect(client.call(background(), optionOperation, 1, option)).rejects.toThrow(message)
    }

    // Options appended by middleware are validated by the innermost call exactly as before.
    for (const [value, message] of invalid) {
      const added = optionProbe([() => value as CallOptions])
      await expect(added.client.call(background(), request)).rejects.toThrow(message)
      await added.client.close(background())
    }
    const notFunction = optionProbe([1 as never])
    await expect(notFunction.client.call(background(), request)).rejects.toThrow(
      "Call option must be a function"
    )
    await notFunction.client.close(background())
    await client.close(background())
  })

  test("reports a construction-address owner close timeout", async () => {
    const subject = harness({
      onClose() {
        return new Promise<void>(function neverSettles(): void {})
      }
    })
    Reflect.deleteProperty(subject.transport, "kind")
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint("memory://orders-direct"),
      closeTimeout(5)
    )
    const response = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    const failure = await rejected(client.close(background()))

    expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
    expect(failure).toMatchObject({
      message: "transport client close exceeded 5ms"
    })
    expect(subject.events).toEqual(["dial:memory://orders-direct", "fetch", "close"])
  })

  test("keeps idle transport owners per address without sharing an active lease", async () => {
    const probe = poolProbe()
    const client = newClient(withTransport(probe.transport), withEndpoint("memory://orders"))
    const call = (): Promise<Response> => client.call(background(), poolRequest)

    // The first body must return before the overlapping pair can borrow its idle owner.
    await bodyBytes(await call())
    const overlapped = await Promise.all([call(), call()])
    // An active owner serves one call: the pair needs the idle owner plus one new dial.
    expect(probe.owners.map((owner) => owner.fetches)).toEqual([2, 1])
    await Promise.all(overlapped.map((response) => bodyBytes(response)))

    // Both completed exchanges stay idle for the address; neither is closed.
    await Bun.sleep(10)
    expect(probe.owners.map((owner) => owner.closes)).toEqual([0, 0])
    await client.close(background())
    await client.close(background())
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 1])
    await expect(call()).rejects.toThrow("client is closed")
    expect(probe.owners).toHaveLength(2)
  })

  test("reuses both owners of an overlapped pair without dialing again", async () => {
    const probe = poolProbe()
    const client = newClient(withTransport(probe.transport), withEndpoint("memory://orders"))
    const call = (): Promise<Response> => client.call(background(), poolRequest)

    const first = await Promise.all([call(), call()])
    expect(probe.owners).toHaveLength(2)
    await Promise.all(first.map((response) => bodyBytes(response)))
    const second = await Promise.all([call(), call()])
    await Promise.all(second.map((response) => bodyBytes(response)))

    expect(probe.owners).toHaveLength(2)
    expect(probe.owners.map((owner) => owner.fetches)).toEqual([2, 2])
    expect(probe.owners.map((owner) => owner.closes)).toEqual([0, 0])
    await client.close(background())
  })

  test("reuses the most recently released idle owner of an address first", async () => {
    const probe = poolProbe()
    const client = newClient(withTransport(probe.transport), withEndpoint("memory://orders"))
    const call = (): Promise<Response> => client.call(background(), poolRequest)

    const [one, two, three] = await Promise.all([call(), call(), call()])
    // Release order is owner 2, owner 1, owner 3: owner 3 tops the address stack.
    await bodyBytes(two)
    await bodyBytes(one)
    await bodyBytes(three)
    await bodyBytes(await call())
    await bodyBytes(await call())
    expect(probe.owners.map((owner) => owner.fetches)).toEqual([1, 1, 3])

    // The next overlapped pair takes the top of the stack, then the entry below it.
    const pair = await Promise.all([call(), call()])
    await Promise.all(pair.map((response) => bodyBytes(response)))
    expect(probe.owners.map((owner) => owner.fetches)).toEqual([2, 1, 4])
    expect(probe.owners).toHaveLength(3)
    await client.close(background())
  })

  test("closes exactly one owner when poolSize(1) keeps two concurrent completions", async () => {
    const probe = poolProbe()
    const client = newClient(
      withTransport(probe.transport),
      withEndpoint("memory://orders"),
      poolSize(1)
    )
    const call = (): Promise<Response> => client.call(background(), poolRequest)

    const [first, second] = await Promise.all([call(), call()])
    await bodyBytes(first)
    await bodyBytes(second)
    await eventually(() => probe.owners[0]?.closes === 1)
    await Bun.sleep(10)
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 0])

    // The evicted owner left its address stack: the next pair reuses only the retained owner.
    const pair = await Promise.all([call(), call()])
    await Promise.all(pair.map((response) => bodyBytes(response)))
    expect(probe.owners.map((owner) => owner.fetches)).toEqual([1, 2, 1])
    await eventually(() => probe.owners[1]?.closes === 1)
    await client.close(background())
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 1, 1])
  })

  test("enforces poolSize across addresses and drops the evicted owner from its address stack", async () => {
    const probe = poolProbe()
    const client = newClient(
      withTransport(probe.transport),
      withEndpoint(["memory://a", "memory://b"]),
      poolSize(1)
    )
    const call = (): Promise<Response> => client.call(background(), poolRequest)

    // The default round-robin Selector sends the first pair to a, then b.
    const [toA, toB] = await Promise.all([call(), call()])
    expect(probe.owners.map((owner) => owner.address)).toEqual(["memory://a", "memory://b"])
    await bodyBytes(toA)
    await bodyBytes(toB)
    await eventually(() => probe.owners[0]?.closes === 1)
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 0])

    // The next pair asks for a, then b: a must dial afresh while b reuses its retained owner.
    const next = await Promise.all([call(), call()])
    await Promise.all(next.map((response) => bodyBytes(response)))
    expect(probe.owners.map((owner) => `${owner.address}:${owner.fetches}`)).toEqual([
      "memory://a:1",
      "memory://b:2",
      "memory://a:1"
    ])
    await eventually(() => probe.owners[2]?.closes === 1)
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 0, 1])
    await client.close(background())
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 1, 1])
  })

  test("closes instead of pooling an owner whose exchange failed or is not reusable", async () => {
    const NumberValue = struct.number()
    const operation = endpoint("orders", "Create", NumberValue, NumberValue)
    const failure = new Error("fetch failed")
    const json = { "content-type": "application/json" }
    const rawOk = (owner: PoolOwner): Response =>
      responseFrom({ node: "a" }, new Uint8Array([owner.serial]))
    const typedOk = (): Response => responseFrom(json, new TextEncoder().encode("1"))
    const raw = (client: Client): Promise<unknown> => client.call(background(), poolRequest)
    const typed = (client: Client): Promise<unknown> => client.call(background(), operation, 1)
    const modes = [
      {
        invoke: raw,
        good: rawOk,
        bad(): Response {
          throw failure
        }
      },
      { invoke: raw, good: rawOk, bad: () => responseFrom({}, new Uint8Array(), 503) },
      { invoke: raw, good: rawOk, bad: () => ({}) as never },
      {
        invoke: typed,
        good: typedOk,
        bad: () => responseFrom(json, new TextEncoder().encode('"invalid"'))
      }
    ] as const

    for (const mode of modes) {
      const probe = poolProbe((owner) => (owner.serial === 1 ? mode.bad() : mode.good(owner)))
      const client = newClient(withTransport(probe.transport), withEndpoint("memory://orders"))

      await rejected(mode.invoke(client))
      expect(probe.owners.map((owner) => owner.closes)).toEqual([1])
      const result = await mode.invoke(client)
      if (result instanceof Response) await bodyBytes(result)

      // The failed owner was never pooled, so the second call had to dial its own owner.
      expect(probe.owners.map((owner) => owner.fetches)).toEqual([1, 1])
      expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 0])
      await client.close(background())
      expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 1])
    }
  })

  test("awaits and reports the close of a completed typed exchange when pooling is disabled", async () => {
    const closeFailure = new Error("close failed")
    const subject = harness({
      response: responseFrom({ "content-type": "application/json" }, new TextEncoder().encode("1")),
      closeFailure
    })
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint("memory://orders"),
      poolSize(0)
    )

    const failure = completedCallFailure(
      await rejected(client.call(background(), optionOperation, 1))
    )
    expect(failure.errors).toEqual([closeFailure])
    expect(subject.events).toEqual(["dial:memory://orders", "fetch", "close"])
    await client.close(background())
  })

  test("closes the owner when a raw response body cannot be observed", async () => {
    const probe = poolProbe(() => {
      const source = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.close()
        }
      })
      const response = new Response(source)
      // A locked, unread body cannot be observed; the failed exchange must not strand its owner.
      response.body?.getReader()
      return response
    })
    const client = newClient(withTransport(probe.transport), withEndpoint("memory://orders"))

    await rejected(client.call(background(), poolRequest))
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1])
    await client.close(background())
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1])
  })

  test("pools only the owner of the overlapped exchange that succeeded", async () => {
    const failure = new Error("fetch failed")
    const probe = poolProbe((owner) => {
      if (owner.serial === 1) throw failure
      return responseFrom({ node: "a" }, new Uint8Array([owner.serial]))
    })
    const client = newClient(withTransport(probe.transport), withEndpoint("memory://orders"))
    const call = (): Promise<Response> => client.call(background(), poolRequest)

    const [failed, succeeded] = await Promise.allSettled([call(), call()])
    expect(failed.status).toBe("rejected")
    if (succeeded.status !== "fulfilled") throw new Error("second overlapped call failed")
    await bodyBytes(succeeded.value)
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 0])

    // Only the successful owner is reusable: the next pair borrows it and dials one more.
    const pair = await Promise.all([call(), call()])
    await Promise.all(pair.map((response) => bodyBytes(response)))
    expect(probe.owners.map((owner) => owner.fetches)).toEqual([1, 2, 1])
    await client.close(background())
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 1, 1])
  })

  test("closes each pooled owner at its own idle expiry and removes it from the address stack", async () => {
    const probe = poolProbe()
    const client = newClient(
      withTransport(probe.transport),
      withEndpoint("memory://orders"),
      poolTtl(200)
    )
    const call = (): Promise<Response> => client.call(background(), poolRequest)

    const [first, second] = await Promise.all([call(), call()])
    await bodyBytes(first)
    await Bun.sleep(100)
    await bodyBytes(second)

    // The earlier owner expires alone; the later one is still idle and reusable.
    await eventually(() => probe.owners[0]?.closes === 1)
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 0])
    await bodyBytes(await call())
    expect(probe.owners.map((owner) => owner.fetches)).toEqual([1, 2])

    // Once released again, the later owner expires on its own timer exactly once.
    await eventually(() => probe.owners[1]?.closes === 1)
    await Bun.sleep(20)
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 1])

    // No expired owner remains on the stack: the next call dials a third owner.
    await bodyBytes(await call())
    expect(probe.owners).toHaveLength(3)
    await client.close(background())
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 1, 1])
  })

  test("keeps exactly one pending expiry timer per idle owner", async () => {
    const ttl = 86_400_000
    const timers = trackTimers(ttl)
    try {
      const probe = poolProbe()
      const client = newClient(
        withTransport(probe.transport),
        withEndpoint("memory://orders"),
        poolTtl(ttl)
      )
      const call = (): Promise<Response> => client.call(background(), poolRequest)

      // Active owners are not idle and carry no expiry.
      const first = await Promise.all([call(), call()])
      expect(timers.live.size).toBe(0)
      await Promise.all(first.map((response) => bodyBytes(response)))
      expect(timers.live.size).toBe(2)

      // Borrowing cancels the expiry; releasing arms exactly one new timer per owner.
      const second = await Promise.all([call(), call()])
      expect(probe.owners).toHaveLength(2)
      expect(timers.live.size).toBe(0)
      await Promise.all(second.map((response) => bodyBytes(response)))
      expect(timers.live.size).toBe(2)

      await client.close(background())
      expect(timers.live.size).toBe(0)
    } finally {
      timers.restore()
    }
  })

  test("closes every pooled owner across addresses exactly once on client close", async () => {
    const probe = poolProbe()
    const client = newClient(
      withTransport(probe.transport),
      withEndpoint(["memory://a", "memory://b"])
    )
    const call = (): Promise<Response> => client.call(background(), poolRequest)

    const batch = await Promise.all([call(), call(), call(), call()])
    for (const response of batch) await bodyBytes(response)
    expect(probe.owners.map((owner) => owner.address)).toEqual([
      "memory://a",
      "memory://b",
      "memory://a",
      "memory://b"
    ])
    await Bun.sleep(10)
    expect(probe.owners.map((owner) => owner.closes)).toEqual([0, 0, 0, 0])

    await Promise.all([client.close(background()), client.close(background())])
    await client.close(background())
    expect(probe.owners.map((owner) => owner.closes)).toEqual([1, 1, 1, 1])
    await expect(call()).rejects.toThrow("client is closed")
    expect(probe.owners).toHaveLength(4)
  })

  test("bounds the global idle pool by least-recently-used address and supports zero reuse", async () => {
    const closed: string[] = []
    const dialed: string[] = []
    let dials = 0
    const transport: Transport = Object.freeze({
      init(): void {
        throw new Error("unexpected init")
      },
      async dial(_ctx: Context, address: string): Promise<TransportClient> {
        dials += 1
        dialed.push(address)
        const identity = `${address}#${dials}`
        return Object.freeze({
          async fetch(): Promise<Response> {
            return responseFrom({ node: "a" }, new Uint8Array())
          },
          async close(): Promise<void> {
            closed.push(identity)
          }
        })
      },
      listen(): Promise<Listener> {
        throw new Error("unexpected listen")
      },
      options(): Options {
        throw new Error("unexpected options")
      },
      string(): string {
        return "pool-test"
      }
    })
    const addressSequence = [
      "memory://a",
      "memory://b",
      "memory://c",
      "memory://b",
      "memory://d"
    ] as const
    let selection = 0
    const selector: Selector = Object.freeze({
      select(
        _ctx: Context,
        instances: readonly ServiceInstance[]
      ): readonly [ServiceEndpoint, SelectionDone] {
        const instance = instances[0]
        const url = addressSequence[selection]
        selection += 1
        if (instance === undefined || url === undefined) throw new Error("missing selected address")
        return Object.freeze([Object.freeze({ instance, url }), function complete(): void {}])
      }
    })
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }
    const client = newClient(
      withTransport(transport),
      withEndpoint(["memory://a", "memory://b", "memory://c", "memory://d"]),
      withSelector(selector),
      poolSize(2),
      poolTtl(0)
    )

    await bodyBytes(await client.call(background(), request))
    await bodyBytes(await client.call(background(), request))
    await bodyBytes(await client.call(background(), request))
    await eventually(() => closed.length === 1)
    expect(closed).toEqual(["memory://a#1"])

    await bodyBytes(await client.call(background(), request))
    expect(dialed).toEqual(["memory://a", "memory://b", "memory://c"])
    await bodyBytes(await client.call(background(), request))
    await eventually(() => closed.length === 2)
    expect(dialed).toEqual(["memory://a", "memory://b", "memory://c", "memory://d"])
    expect(closed).toEqual(["memory://a#1", "memory://c#3"])
    await client.close(background())

    closed.length = 0
    dialed.length = 0
    dials = 0
    const defaultAddresses = Array.from(
      { length: 101 },
      (_value, index) => `memory://default-${index}`
    )
    const defaults = newClient(withTransport(transport), withEndpoint(defaultAddresses), poolTtl(0))
    for (let index = 0; index < 101; index += 1) {
      await bodyBytes(await defaults.call(background(), request))
    }
    await eventually(() => closed.length === 1)
    expect(closed).toEqual(["memory://default-0#1"])
    await defaults.close(background())

    let zeroDials = 0
    let zeroCloses = 0
    const noReuse: Transport = Object.freeze({
      init(): void {
        throw new Error("unexpected init")
      },
      async dial(): Promise<TransportClient> {
        zeroDials += 1
        return Object.freeze({
          async fetch(): Promise<Response> {
            return responseFrom({ node: "a" }, new Uint8Array())
          },
          async close(): Promise<void> {
            zeroCloses += 1
          }
        })
      },
      listen(): Promise<Listener> {
        throw new Error("unexpected listen")
      },
      options(): Options {
        throw new Error("unexpected options")
      },
      string(): string {
        return "pool-zero-test"
      }
    })
    const zero = newClient(withTransport(noReuse), withEndpoint("memory://zero"), poolSize(0))
    await bodyBytes(await zero.call(background(), request))
    await bodyBytes(await zero.call(background(), request))
    // poolSize(0) closes from the body observer, which does not await transport close.
    await eventually(() => zeroCloses === 2)
    expect([zeroDials, zeroCloses]).toEqual([2, 2])
    await zero.close(background())
  })

  test("expires idle owners without a later acquire but never expires an active lease", async () => {
    const held = Promise.withResolvers<Response>()
    let dials = 0
    let receives = 0
    let closes = 0
    const transport: Transport = Object.freeze({
      init(): void {
        throw new Error("unexpected init")
      },
      async dial(): Promise<TransportClient> {
        dials += 1
        return Object.freeze({
          async fetch(): Promise<Response> {
            receives += 1
            if (receives === 2) return held.promise
            return responseFrom({ node: "a" }, new Uint8Array())
          },
          async close(): Promise<void> {
            closes += 1
          }
        })
      },
      listen(): Promise<Listener> {
        throw new Error("unexpected listen")
      },
      options(): Options {
        throw new Error("unexpected options")
      },
      string(): string {
        return "pool-ttl-test"
      }
    })
    const client = newClient(withTransport(transport), withEndpoint("memory://ttl"), poolTtl(10))
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }
    await bodyBytes(await client.call(background(), request))
    const active = client.call(background(), request)
    await eventually(() => receives === 2)
    await Bun.sleep(25)
    expect([dials, closes]).toEqual([1, 0])
    held.resolve(responseFrom({ node: "a" }, new Uint8Array()))
    await bodyBytes(await active)
    await eventually(() => closes === 1)
    expect(dials).toBe(1)
    await client.close(background())
  })

  test("joins close, release, and idle timer races through one owner close", async () => {
    const heldResponse = Promise.withResolvers<Response>()
    const heldClose = Promise.withResolvers<void>()
    let receives = 0
    let closes = 0
    const transport: Transport = Object.freeze({
      init(): void {
        throw new Error("unexpected init")
      },
      async dial(): Promise<TransportClient> {
        return Object.freeze({
          async fetch(): Promise<Response> {
            receives += 1
            if (receives === 2) return heldResponse.promise
            return responseFrom({ node: "a" }, new Uint8Array())
          },
          close(): Promise<void> {
            closes += 1
            return heldClose.promise
          }
        })
      },
      listen(): Promise<Listener> {
        throw new Error("unexpected listen")
      },
      options(): Options {
        throw new Error("unexpected options")
      },
      string(): string {
        return "pool-race-test"
      }
    })
    const client = newClient(withTransport(transport), withEndpoint("memory://race"), poolTtl(10))
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }
    await bodyBytes(await client.call(background(), request))
    const call = client.call(background(), request)
    await eventually(() => receives === 2)
    const closing = client.close(background())
    await eventually(() => closes === 1)
    heldResponse.resolve(responseFrom({ node: "a" }, new Uint8Array()))
    heldClose.resolve()
    await bodyBytes(await call)
    await closing
    await Bun.sleep(20)
    expect(closes).toBe(1)
  })

  test("closes an active transport owner and rejects future calls", async () => {
    const subject = harness()
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    const stopped = new Error("transport owner stopped")
    let closes = 0
    Reflect.set(subject.transport, "dial", async function activeDial(): Promise<TransportClient> {
      return Object.freeze({
        async fetch(): Promise<Response> {
          started.resolve()
          return response.promise
        },
        async close(): Promise<void> {
          closes += 1
          response.reject(stopped)
        }
      })
    })
    const client = newClient(withTransport(subject.transport), withEndpoint("memory://orders"))
    const call = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    })
    void call.catch(() => {})
    await started.promise

    await client.close(background())

    expect(await rejected(call)).toBe(stopped)
    expect(closes).toBe(1)
  })

  test("joins a pending dial and closes its late owner", async () => {
    const subject = harness()
    const dialed = Promise.withResolvers<void>()
    const admission = Promise.withResolvers<TransportClient>()
    let closes = 0
    Reflect.set(subject.transport, "dial", async function pendingDial(): Promise<TransportClient> {
      dialed.resolve()
      return await admission.promise
    })
    const client = newClient(withTransport(subject.transport), withEndpoint("memory://orders"))
    const call = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    })
    void call.catch(() => {})
    await dialed.promise
    const closing = client.close(background())
    void closing.catch(() => {})
    admission.resolve(
      Object.freeze({
        async fetch(): Promise<Response> {
          return responseFrom({ node: "a" }, new Uint8Array())
        },
        async close(): Promise<void> {
          closes += 1
        }
      })
    )

    await closing
    expect(await rejected(call)).toMatchObject({ message: "client is closed" })
    expect(closes).toBe(1)
  })

  test("reports a late owner cleanup failure to both close and the admitted call", async () => {
    const subject = harness()
    const dialed = Promise.withResolvers<void>()
    const admission = Promise.withResolvers<TransportClient>()
    const cleanupFailure = new Error("late owner close failed")
    Reflect.set(subject.transport, "dial", async function pendingDial(): Promise<TransportClient> {
      dialed.resolve()
      return await admission.promise
    })
    const client = newClient(withTransport(subject.transport), withEndpoint("memory://orders"))
    const call = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    })
    void call.catch(() => {})
    await dialed.promise
    const closing = client.close(background())
    void closing.catch(() => {})
    admission.resolve(
      Object.freeze({
        async fetch(): Promise<Response> {
          return responseFrom({ node: "a" }, new Uint8Array())
        },
        async close(): Promise<void> {
          throw cleanupFailure
        }
      })
    )

    expect(await rejected(closing)).toBe(cleanupFailure)
    const failure = await rejected(call)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "client is closed" }),
      cleanupFailure
    ])
  })

  test("filters discovered instances by exact version and metadata before selection", async () => {
    const subject = harness()
    const discovered = Object.freeze([
      Object.freeze({
        id: "orders-a",
        name: "orders",
        version: "v1",
        endpoints: Object.freeze(["http://orders-a.test/"]),
        metadata: Object.freeze({ zone: "a", tier: "api" })
      }),
      Object.freeze({
        id: "orders-b",
        name: "orders",
        version: "v2",
        endpoints: Object.freeze(["http://orders-b.test/"]),
        metadata: Object.freeze({ zone: "b", tier: "api" })
      }),
      Object.freeze({
        id: "orders-c",
        name: "orders",
        version: "v2",
        endpoints: Object.freeze(["http://orders-c.test/"]),
        metadata: Object.freeze({ zone: "a", tier: "api" })
      })
    ])
    const selectedSnapshots: (readonly ServiceInstance[])[] = []
    Reflect.set(subject.discovery, "getService", async function filteredDiscovery(): Promise<
      readonly ServiceInstance[]
    > {
      subject.events.push("discover:orders")
      return discovered
    })
    Reflect.set(subject.selector, "select", function filteredSelect(_ctx: Context, instances) {
      subject.events.push("select")
      selectedSnapshots.push(instances)
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("missing filtered endpoint")
      return Object.freeze([Object.freeze({ instance, url }), function complete(): void {}])
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    await client.call(
      background(),
      {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      },
      withFilter(filterVersion("v2")),
      withFilter(filterLabel("zone", "a")),
      withFilter(filterLabel("tier", "api"))
    )

    const matching = discovered[2]
    if (matching === undefined) throw new Error("missing expected filtered instance")
    expect(selectedSnapshots).toEqual([[matching]])
    expect(subject.events).toContain("dial:http://orders-c.test/")
  })

  test("passes discovered endpoint lists unchanged and rejects a non-root node address before dial", async () => {
    const discovered = Object.freeze([
      Object.freeze({
        id: "orders-http",
        name: "orders",
        version: "v1",
        endpoints: Object.freeze([
          "not a transport URL",
          "grpc://orders",
          "https://orders.test/",
          "http://orders.test/"
        ]),
        metadata: Object.freeze({})
      }),
      Object.freeze({
        id: "orders-memory",
        name: "orders",
        version: "v1",
        endpoints: Object.freeze(["memory://orders"]),
        metadata: Object.freeze({})
      }),
      Object.freeze({
        id: "orders-custom",
        name: "orders",
        version: "v1",
        endpoints: Object.freeze(["custom+rpc://orders"]),
        metadata: Object.freeze({})
      })
    ])

    const subject = harness()
    const selectedSnapshots: (readonly ServiceInstance[])[] = []
    Reflect.set(subject.discovery, "getService", async function transportDiscovery(): Promise<
      readonly ServiceInstance[]
    > {
      subject.events.push("discover:orders")
      return discovered
    })
    Reflect.set(
      subject.selector,
      "select",
      function opaqueSelector(
        _ctx: Context,
        instances: readonly ServiceInstance[]
      ): readonly [ServiceEndpoint, SelectionDone] {
        subject.events.push("select")
        selectedSnapshots.push(instances)
        const instance = instances[0]
        const url = instance?.endpoints[0]
        if (instance === undefined || url === undefined) {
          throw new Error("missing opaque endpoint")
        }
        return Object.freeze([Object.freeze({ instance, url }), function complete(): void {}])
      }
    )
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const request = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    const failure = await rejected(client.call(background(), request))
    await client.close(background())

    expect(failure).toBeInstanceOf(TypeError)
    expect(failure.message).toBe(
      "client node address must be an absolute root URL, received not a transport URL"
    )
    expect(selectedSnapshots).toHaveLength(1)
    expect(selectedSnapshots[0]).toBe(discovered)
    expect(subject.events.some((event) => event.startsWith("dial:"))).toBe(false)
    expect(discovered[0]?.endpoints).toEqual([
      "not a transport URL",
      "grpc://orders",
      "https://orders.test/",
      "http://orders.test/"
    ])

    for (const address of [
      "grpc://orders",
      "https://orders.test/",
      "http://orders.test/",
      "memory://orders",
      "custom+rpc://orders"
    ]) {
      const direct = harness()
      const caller = newClient(withTransport(direct.transport), withEndpoint(address))
      await caller.call(background(), request)
      expect(direct.events).toContain(`dial:${address}`)
      expect(direct.sent[0]?.url).toBe(new URL("/orders/Create", address).href)
      expect(direct.sent[0]?.method).toBe("POST")
      await caller.close(background())
    }
    for (const address of ["http://orders.test/rpc", "https://orders.test/?"]) {
      const direct = harness()
      const caller = newClient(withTransport(direct.transport), withEndpoint(address))
      await expect(caller.call(background(), request)).rejects.toThrow(
        `client node address must be an absolute root URL, received ${address}`
      )
      expect(direct.events.some((event) => event.startsWith("dial:"))).toBe(false)
      await caller.close(background())
    }
    const fragment = harness()
    const fragmentClient = newClient(
      withTransport(fragment.transport),
      withEndpoint("http://example.test/#fragment")
    )
    await expect(fragmentClient.call(background(), request)).rejects.toThrow(
      "ServiceInstance endpoint must omit credentials and fragments"
    )
    expect(fragment.events.some((event) => event.startsWith("dial:"))).toBe(false)
    await fragmentClient.close(background())
  })

  test("recomputes Go-Like-Timeout-Ms from the caller deadline on each attempt", async () => {
    const request = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }
    const open = harness()
    const openClient = newClient(withTransport(open.transport), withEndpoint("memory://orders"))
    await openClient.call(background(), request)
    expect(open.sent[0]?.headers["go-like-timeout-ms"]).toBeUndefined()
    await openClient.close(background())

    const bounded = harness()
    const boundedClient = newClient(
      withTransport(bounded.transport),
      withEndpoint("memory://orders")
    )
    const [ctx, cancel] = withTimeout(background(), 5_000)
    await boundedClient.call(ctx, request)
    const header = bounded.sent[0]?.headers["go-like-timeout-ms"]
    expect(header).toMatch(/^[1-9][0-9]*$/)
    expect(Number(header)).toBeLessThanOrEqual(5_000)
    expect(Number(header)).toBeGreaterThan(4_000)
    cancel()
    await boundedClient.close(background())

    const expired = harness()
    const realDial = expired.transport.dial.bind(expired.transport)
    Reflect.set(
      expired.transport,
      "dial",
      async function delayedDial(ctx: Context, address: string): Promise<TransportClient> {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return realDial(ctx, address)
      }
    )
    const expiredClient = newClient(
      withTransport(expired.transport),
      withEndpoint("memory://orders")
    )
    const [short, cancelShort] = withTimeout(background(), 10)
    await expiredClient.call(short, request)
    expect(expired.sent[0]?.headers["go-like-timeout-ms"]).toBe("0")
    cancelShort()
    await expiredClient.close(background())
  })

  test("fails with the stable selector error when call filters remove every instance", async () => {
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(
        background(),
        {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        },
        withFilter(filterVersion("v2"))
      )
    )

    expect(failure).toMatchObject({
      name: "NoAvailableEndpointError",
      code: "GO_LIKE_NO_AVAILABLE_ENDPOINT"
    })
    expect(subject.events).toEqual(["discover:orders", "discover:orders"])
  })

  test("retries only under an explicit replay authorization and backoff policy", async () => {
    const transient = new Error("transient send failure")
    const addresses = ["memory://orders-first", "memory://orders-final"] as const
    let sends = 0
    const subject = harness({
      onFetch() {
        sends += 1
        if (sends === 1) throw transient
      }
    })
    const baseSelect = subject.selector.select
    let selections = 0
    Reflect.set(subject.selector, "select", function retrySelector(ctx: Context, instances) {
      const selection = baseSelect.call(subject.selector, ctx, instances)
      const url = addresses[selections]
      selections += 1
      if (url === undefined) throw new Error("unexpected retry selection")
      return Object.freeze([Object.freeze({ instance: selection[0].instance, url }), selection[1]])
    })
    const middlewareInfo: { value: TransportInfo | null } = { value: null }
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      middleware((next) => async (ctx, request, ...options) => {
        const info = transportFromClientContext(ctx)
        if (info === null) throw new Error("retry middleware did not receive TransportInfo")
        expect(info.endpoint()).toBe("")
        const result = await next(ctx, request, ...options)
        expect(transportFromClientContext(ctx)).toBe(info)
        middlewareInfo.value = info
        return result
      })
    )

    const response = await client.call(
      background(),
      {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array([1])
      },
      withRetry({
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry(_ctx, failure, attempt): boolean {
          expect(failure).toBe(transient)
          expect(attempt).toBe(1)
          return true
        },
        backoff(attempt): number {
          expect(attempt).toBe(1)
          return 0
        }
      })
    )

    expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
    expect(sends).toBe(2)
    expect(selections).toBe(2)
    expect(subject.outcomes).toEqual([
      expectedSelectionOutcome(transient, true, false),
      expectedSelectionOutcome(null, true, true, { node: "a" })
    ])
    expect(middlewareInfo.value).not.toBeNull()
    expect(middlewareInfo.value?.endpoint()).toBe("memory://orders-final")
    expect(middlewareInfo.value?.replyHeaders()).toEqual({ node: ["a"] })
    expect(subject.dialContexts).toHaveLength(2)
    expect(transportFromClientContext(subject.dialContexts[0] ?? background())).toBe(
      middlewareInfo.value
    )
    expect(transportFromClientContext(subject.dialContexts[1] ?? background())).toBe(
      middlewareInfo.value
    )
  })

  test("isolates circuit breakers by operation and rejects open calls before discovery or dial", async () => {
    const dependencyFailure = new Error("orders get unavailable")
    const subject = harness({
      onFetch(ctx) {
        if (transportFromClientContext(ctx)?.operation() === "orders/Get") {
          throw dependencyFailure
        }
      }
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      middleware(
        circuitBreakerMiddleware({
          failureThreshold: 1,
          resetTimeoutMs: 60_000
        })
      )
    )
    const getRequest: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    await expect(client.call(background(), getRequest)).rejects.toBe(dependencyFailure)
    const eventsBeforeOpenCall = subject.events.length
    const discoveryBeforeOpenCall = subject.discoveryContexts.length
    const dialsBeforeOpenCall = subject.dialContexts.length
    await expect(client.call(background(), getRequest)).rejects.toBe(circuitOpen)
    expect(subject.events).toHaveLength(eventsBeforeOpenCall)
    expect(subject.discoveryContexts).toHaveLength(discoveryBeforeOpenCall)
    expect(subject.dialContexts).toHaveLength(dialsBeforeOpenCall)

    await expect(
      client.call(background(), {
        service: "orders",
        endpoint: "List",
        headers: {},
        body: new Uint8Array()
      })
    ).resolves.toMatchObject({ status: 200 })
    expect(subject.dialContexts).toHaveLength(dialsBeforeOpenCall + 1)
    await client.close(background())
  })

  test("observes explicit retries as one logical breaker call", async () => {
    const transient = new Error("transient send failure")
    let sends = 0
    const subject = harness({
      onFetch() {
        sends += 1
        if (sends === 1) throw transient
      }
    })
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint("memory://orders"),
      middleware(
        circuitBreakerMiddleware({
          failureThreshold: 1,
          resetTimeoutMs: 60_000
        })
      )
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    await bodyBytes(
      await client.call(
        background(),
        request,
        withRetry({
          authorization: "idempotent",
          maxAttempts: 2,
          shouldRetry: (_ctx, failure) => failure === transient
        })
      )
    )
    await bodyBytes(await client.call(background(), request))

    expect(sends).toBe(3)
    expect(subject.dialContexts).toHaveLength(2)
    await client.close(background())
  })

  test("keeps cleanup failures healthy and preserves their identity before custom classification", async () => {
    const feedbackFailure = new Error("feedback failed")
    const subject = harness({ feedbackFailure })
    let classifications = 0
    let innerFailure: unknown = null
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      middleware(
        circuitBreakerMiddleware({
          failureThreshold: 1,
          resetTimeoutMs: 60_000,
          isFailure(): boolean {
            classifications += 1
            return true
          }
        })
      ),
      middleware((next) => async (ctx, request, ...options) => {
        try {
          return await next(ctx, request, ...options)
        } catch (failure) {
          innerFailure = failure
          throw failure
        }
      })
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    }

    const first = await rejected(client.call(background(), request))
    if (!(innerFailure instanceof Error))
      throw new Error("inner middleware did not observe failure")
    expect(first).toBe(innerFailure)
    // Feedback failed after the response existed, so the body still owns the connection.
    await bodyBytes(completedResponse(completedCallFailure(first)))
    const second = await rejected(client.call(background(), request))
    await bodyBytes(completedResponse(completedCallFailure(second)))
    expect(classifications).toBe(0)
    expect(subject.dialContexts).toHaveLength(1)
    await client.close(background())
  })

  test("keeps caller cancellation neutral to operation circuit health", async () => {
    const cancellation = new Error("caller canceled")
    const dependencyFailure = new Error("dependency failed")
    const [ctx, cancel] = withCancelCause(background())
    let sends = 0
    const subject = harness({
      onFetch() {
        sends += 1
        if (sends !== 1) return
        cancel(cancellation)
        throw dependencyFailure
      }
    })
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint("memory://orders"),
      middleware(
        circuitBreakerMiddleware({
          failureThreshold: 1,
          resetTimeoutMs: 60_000
        })
      )
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }

    await expect(client.call(ctx, request)).rejects.toBe(canceled)
    expect(cause(ctx)).toBe(cancellation)
    const succeeded = await client.call(background(), request)
    expect(succeeded.status).toBe(200)
    expect(succeeded.headers.get("node")).toBe("a")
    expect(sends).toBe(2)
    await client.close(background())
  })

  test("leaves missing operation identity to the existing call validation", async () => {
    const subject = harness()
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint("memory://orders"),
      middleware(
        circuitBreakerMiddleware({
          failureThreshold: 1,
          resetTimeoutMs: 60_000
        })
      )
    )

    await expect(
      client.call(background(), {
        service: "",
        endpoint: "Get",
        headers: {},
        body: new Uint8Array()
      })
    ).rejects.toThrow("CallRequest.service must be a URL unreserved route token")
    expect(subject.events).toEqual([])
    await client.close(background())
  })

  test("rejects exact dot-segment route tokens before transport I/O", async () => {
    const subject = harness()
    const client = newClient(withTransport(subject.transport), withEndpoint("memory://orders"))
    const call = (service: string, endpointName: string): Promise<Response> =>
      client.call(background(), {
        service,
        endpoint: endpointName,
        headers: {},
        body: new Uint8Array()
      })

    await expect(call(".", "ok")).rejects.toThrow(
      "CallRequest.service must be a URL unreserved route token"
    )
    await expect(call("..", "ok")).rejects.toThrow(
      "CallRequest.service must be a URL unreserved route token"
    )
    await expect(call("orders", ".")).rejects.toThrow(
      "CallRequest.endpoint must be a URL unreserved route token"
    )
    await expect(call("orders", "..")).rejects.toThrow(
      "CallRequest.endpoint must be a URL unreserved route token"
    )
    expect(subject.events).toEqual([])
    for (const selector of ["./ok", "../ok", "ok/.", "ok/.."]) {
      expect(() => use(selector)).toThrow(
        "client middleware selector must identify a canonical operation or trailing wildcard"
      )
    }
    expect(() => use("a.b/a..b")).not.toThrow()
    expect(() => use(".a/...")).not.toThrow()

    const accepted = await call("a.b", "a..b")
    expect(accepted.status).toBe(200)
    expect(subject.sent.at(-1)?.url).toBe(new URL("/a.b/a..b", "memory://orders").href)
    await client.close(background())
  })

  test("validates circuit breaker middleware options at construction", () => {
    expect(() => Reflect.apply(circuitBreakerMiddleware, undefined, [null])).toThrow(
      "circuit breaker options must be an object"
    )
    expect(() =>
      circuitBreakerMiddleware({
        failureThreshold: 0,
        resetTimeoutMs: 1
      })
    ).toThrow("failureThreshold must be a positive safe integer")
    expect(() =>
      Reflect.apply(circuitBreakerMiddleware, undefined, [
        {
          failureThreshold: 1,
          resetTimeoutMs: 1,
          isFailure: "invalid"
        }
      ])
    ).toThrow("isFailure must be callable")
  })

  test("preserves Context cancellation while abandoning an explicit retry backoff", async () => {
    const transient = new Error("transient")
    const cancellation = new Error("retry canceled")
    const [ctx, cancel] = withCancelCause(background())
    let sends = 0
    const subject = harness({
      onFetch() {
        sends += 1
        throw transient
      }
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(
        ctx,
        {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        },
        withRetry({
          authorization: "caller-approved",
          maxAttempts: 2,
          shouldRetry: () => true,
          backoff() {
            queueMicrotask(() => cancel(cancellation))
            return 10_000
          }
        })
      )
    )

    expect(failure).toBe(canceled)
    expect(cause(ctx)).toBe(cancellation)
    expect(sends).toBe(1)
  })

  test("bounds a hanging close, reports the timeout, and observes a late rejection", async () => {
    const late = new Error("late close rejection")
    const control: { reject: ((reason?: unknown) => void) | null } = { reject: null }
    const closing = new Promise<void>(function pending(_resolve, reject): void {
      control.reject = reject
    })
    const unhandled: unknown[] = []
    function observeUnhandled(reason: unknown): void {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", observeUnhandled)
    try {
      const subject = harness({ onClose: () => closing })
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport),
        closeTimeout(5)
      )
      const response = await client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })

      const failure = await rejected(within(client.close(background())))
      expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
      expect(failure).toMatchObject({
        message: "transport client close exceeded 5ms"
      })
      expect(subject.closeContexts).toHaveLength(1)
      const closeContext = subject.closeContexts[0]
      if (closeContext === undefined) throw new Error("close Context was not recorded")
      expect(closeContext.err()).toBe(deadlineExceeded)
      expect(cause(closeContext)).toMatchObject({
        message: "transport client close exceeded 5ms"
      })

      control.reject?.(late)
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", observeUnhandled)
    }
  })

  test("keeps the primary first and lets retry continue after close timeout", async () => {
    const transient = new Error("transient send failure")
    let sends = 0
    let closes = 0
    const subject = harness({
      onFetch() {
        sends += 1
        if (sends === 1) throw transient
      },
      onClose() {
        closes += 1
        if (closes === 1) return new Promise<void>(function neverSettles(): void {})
      }
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      closeTimeout(5)
    )
    const retryFailures: Error[] = []

    const response = await client.call(
      background(),
      {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      },
      withRetry({
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry(_ctx, failure): boolean {
          if (!(failure instanceof Error)) throw new Error("retry failure was not an Error")
          retryFailures.push(failure)
          return true
        }
      })
    )

    expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
    expect(sends).toBe(2)
    expect(retryFailures).toHaveLength(1)
    const firstFailure = retryFailures[0]
    expect(firstFailure).toBeInstanceOf(AggregateError)
    expect((firstFailure as AggregateError).errors[0]).toBe(transient)
    expect((firstFailure as AggregateError).errors[1]).toMatchObject({
      message: "transport client close exceeded 5ms"
    })
  })

  test("allows an explicit zero close timeout to retain the unbounded legacy wait", async () => {
    const control: { resolve: (() => void) | null } = { resolve: null }
    const closing = new Promise<void>(function pending(resolve): void {
      control.resolve = resolve
    })
    const subject = harness({ onClose: () => closing })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      closeTimeout(0)
    )
    let settled = false
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    const closingClient = client.close(background()).finally(() => {
      settled = true
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    expect(subject.closeContexts).toEqual([background()])
    control.resolve?.()
    await closingClient
    expect(settled).toBe(true)
  })

  test("lets a canceled close caller leave the shared transport drain running", async () => {
    const control = Promise.withResolvers<void>()
    const subject = harness({ onClose: () => control.promise })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      closeTimeout(0)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    const marker = new Error("close caller canceled")
    const [caller, cancel] = withCancelCause(background())
    cancel(marker)

    await expect(client.close(caller)).rejects.toBe(marker)
    let joined = false
    const joining = client.close(background()).finally(() => {
      joined = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(joined).toBe(false)
    control.resolve()
    await joining

    expect(subject.closeContexts).toEqual([background()])
  })

  test("normalizes bounded, unbounded, and synchronous non-Error close failures", async () => {
    const cases = Object.freeze([
      Object.freeze({ timeoutMs: 1_000, mode: "asynchronous", failure: "bounded close" }),
      Object.freeze({ timeoutMs: 0, mode: "asynchronous", failure: "unbounded close" }),
      Object.freeze({ timeoutMs: 1_000, mode: "synchronous", failure: "synchronous close" })
    ])

    for (const expected of cases) {
      const subject = harness()
      const admitted: TransportClient = {
        async fetch(): Promise<Response> {
          return responseFrom({ node: "a" }, new Uint8Array([1]))
        },
        close(): Promise<void> {
          if (expected.mode === "synchronous") throw expected.failure
          return Promise.reject(expected.failure)
        }
      }
      Reflect.set(
        subject.transport,
        "dial",
        async function dialWithFailingClose(): Promise<TransportClient> {
          return admitted
        }
      )
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport),
        closeTimeout(expected.timeoutMs)
      )

      await client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
      const failure = await rejected(client.close(background()))
      expect(failure).toMatchObject({
        message: "transport client close rejected",
        cause: expected.failure
      })
    }
  })

  test("preserves a cross-realm Error rejected by transport cleanup", async () => {
    const failure = runInNewContext('new Error("foreign close failure")') as Error
    const subject = harness({ closeFailure: failure })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })

    expect(failure instanceof Error).toBe(false)
    expect(await rejectedValue(client.close(background()))).toBe(failure)
  })

  test("validates every per-call option before service I/O", async () => {
    expect(() => withFilter(null as never)).toThrow(TypeError)
    expect(() => withFilter(filterVersion("v1"), null as never)).toThrow(TypeError)
    expect(() => Reflect.apply(withRetry, undefined, [undefined])).toThrow(TypeError)
    expect(() =>
      Reflect.apply(withRetry, undefined, [
        { authorization: "implicit", maxAttempts: 2, shouldRetry: () => true }
      ])
    ).toThrow(TypeError)
    expect(() =>
      Reflect.apply(withRetry, undefined, [
        { authorization: "idempotent", maxAttempts: 0, shouldRetry: () => true }
      ])
    ).toThrow(RangeError)
    expect(() =>
      Reflect.apply(withRetry, undefined, [
        { authorization: "idempotent", maxAttempts: 2, shouldRetry: null }
      ])
    ).toThrow(TypeError)
    expect(() =>
      Reflect.apply(withRetry, undefined, [
        { authorization: "idempotent", maxAttempts: 2, shouldRetry: () => true, backoff: 1 }
      ])
    ).toThrow(TypeError)

    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    for (const option of [
      null,
      () => null,
      () => ({ filters: null, retry: null }),
      () => ({ filters: [], retry: new Date() })
    ]) {
      await expect(
        Reflect.apply(client.call, client, [
          background(),
          {
            service: "orders",
            endpoint: "Create",
            headers: {},
            body: new Uint8Array()
          },
          option
        ])
      ).rejects.toBeInstanceOf(TypeError)
    }
    expect(subject.events).toEqual([])
  })

  test("does not retry discovery or selection failures and publishes no feedback", async () => {
    for (const stage of ["discover", "select"] as const) {
      const failure = new Error(`${stage} failed`)
      const subject = harness({ mainFailure: { stage, value: failure } })
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      expect(
        await rejected(
          client.call(background(), {
            service: "orders",
            endpoint: "Create",
            headers: {},
            body: new Uint8Array()
          })
        )
      ).toBe(failure)
      expect(subject.events).toEqual(
        stage === "discover"
          ? ["discover:orders"]
          : ["discover:orders", "discover:orders", "select"]
      )
      expect(subject.outcomes).toEqual([])
      expect(subject.closeContexts).toEqual([])
    }
  })

  test("normalizes a non-Error dial rejection and completes its selection once", async () => {
    const subject = harness({ mainFailure: { stage: "dial", value: "dial rejected" } })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure.cause).toBe("dial rejected")
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "done:error"
    ])
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(failure, false, false)])
    expect(subject.closeContexts).toEqual([])
  })

  test("preserves a cross-realm Error rejected by a call boundary", async () => {
    const failure = runInNewContext('new Error("foreign dial failure")') as Error
    const subject = harness({ mainFailure: { stage: "dial", value: failure } })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const rejected = await rejectedValue(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure instanceof Error).toBe(false)
    expect(rejected).toBe(failure)
  })

  test("preserves the primary Error and closes once without retry after send fails", async () => {
    const primary = new Error("send failed")
    const subject = harness({ mainFailure: { stage: "fetch", value: primary } })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    expect(
      await rejected(
        client.call(background(), {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        })
      )
    ).toBe(primary)
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "fetch",
      "done:error",
      "close"
    ])
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(primary, true, false)])
    expectBoundedClose(subject.closeContexts)
  })

  test("rejects a non-Response fetch result after the attempt has started", async () => {
    const subject = harness({
      response: { header: [], body: new Uint8Array() } as unknown as Response
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure).toBeInstanceOf(TypeError)
    expect(failure.message).toBe("transport fetch must return a Response")
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(failure, true, false)])
    expectBoundedClose(subject.closeContexts)
  })

  test("preserves a Context cause while publishing neutral feedback and cleaning up", async () => {
    const cancellation = new Error("caller canceled")
    const [ctx, cancel] = withCancelCause(withValue(background(), "key", "value"))
    const subject = harness({
      mainFailure: { stage: "fetch", value: cancellation },
      onFetch() {
        cancel(cancellation)
      }
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    expect(
      await rejected(
        client.call(ctx, {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        })
      )
    ).toBe(cancellation)
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(null, true, false)])
    expect(subject.feedbackContexts[0]?.done()).toBeNull()
    expect(subject.feedbackContexts[0]?.value("key")).toBe("value")
    expectBoundedClose(subject.closeContexts)
  })

  test("does not penalize an endpoint when canceled Context I/O rejects with another AbortError", async () => {
    const cancellation = new Error("caller canceled")
    const providerAbort = new DOMException("provider observed abort", "AbortError")
    const [ctx, cancel] = withCancelCause(background())
    const subject = harness({
      mainFailure: { stage: "fetch", value: providerAbort },
      onFetch() {
        cancel(cancellation)
      }
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    expect(
      await rejected(
        client.call(ctx, {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        })
      )
    ).toBe(providerAbort)
    expect(cause(ctx)).toBe(cancellation)
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(null, true, false)])
    expectBoundedClose(subject.closeContexts)
  })

  test("preserves explicit availability evidence when caller cancellation races the result", async () => {
    const cancellation = new Error("caller canceled")
    const [serviceContext, cancelService] = withCancelCause(background())
    const failureResponse = serviceErrorResponse(
      serviceError("orders.unavailable", "service unavailable", 503)
    )
    const serviceSubject = harness({
      response: failureResponse,
      onFetch() {
        cancelService(cancellation)
      }
    })
    const serviceClient = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(serviceSubject.discovery),
      withSelector(serviceSubject.selector),
      withTransport(serviceSubject.transport)
    )
    const serviceFailure = await rejected(
      serviceClient.call(serviceContext, {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )
    expect(serviceSubject.outcomes).toEqual([
      expectedSelectionOutcome(serviceFailure, true, true, { "content-type": "application/json" })
    ])

    const [statusContext, cancelStatus] = withCancelCause(background())
    const statusFailure = Object.assign(new Error("gateway unavailable"), { status: 504 })
    const statusSubject = harness({
      mainFailure: { stage: "fetch", value: statusFailure },
      onFetch() {
        cancelStatus(cancellation)
      }
    })
    const statusClient = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(statusSubject.discovery),
      withSelector(statusSubject.selector),
      withTransport(statusSubject.transport)
    )
    expect(
      await rejected(
        statusClient.call(statusContext, {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        })
      )
    ).toBe(statusFailure)
    expect(statusSubject.outcomes).toEqual([expectedSelectionOutcome(statusFailure, true, false)])
  })

  test("orders hostile feedback Context failures after the unary primary", async () => {
    for (const mode of ["inspect", "classify"] as const) {
      const primary = new Error(`send failed before ${mode}`)
      const hostile = new Error(`feedback Context ${mode} failed`)
      const controlled = lateHostileContext(mode, hostile)
      const subject = harness({
        mainFailure: { stage: "fetch", value: primary },
        onFetch() {
          controlled[1]()
        }
      })
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport),
        middleware((next) => async (_ctx, request, ...options) => {
          return await next(controlled[0], request, ...options)
        })
      )
      const failure = await rejected(
        client.call(controlled[0], {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        })
      )

      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([primary, hostile])
      expect(subject.outcomes).toEqual([])
      expectBoundedClose(subject.closeContexts)
    }
  })

  test("preserves a pre-canceled discovery cause without selecting or dialing", async () => {
    const cancellation = new Error("pre-canceled")
    const [ctx, cancel] = withCancelCause(background())
    cancel(cancellation)
    const subject = harness()
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    expect(
      await rejected(
        client.call(ctx, {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        })
      )
    ).toBe(cancellation)
    expect(subject.events).toEqual([])
    expect(subject.outcomes).toEqual([])
  })

  test("reports feedback failure after a successful exchange and closes its idle owner", async () => {
    const feedback = new Error("feedback failed")
    const subject = harness({ feedbackFailure: feedback })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )
    const cleanup = completedCallFailure(failure)

    expect(cleanup.errors).toEqual([feedback])
    expect(await bodyBytes(completedResponse(cleanup))).toEqual(new Uint8Array([9, 8]))
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(null, true, true, { node: "a" })])
    expect(subject.closeContexts).toEqual([])
    await client.close(background())
    expectBoundedClose(subject.closeContexts)
  })

  test("reports a resident transport close failure from Client close", async () => {
    const closeFailure = new Error("close failed")
    const subject = harness({ closeFailure })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })

    expect(await rejected(client.close(background()))).toBe(closeFailure)
    expectBoundedClose(subject.closeContexts)
  })

  test("aggregates resident transport close failures in admission order", async () => {
    const failures = [new Error("first close failed"), new Error("second close failed")]
    const subject = harness()
    let admitted = 0
    Reflect.set(
      subject.transport,
      "dial",
      async function failingOwnerDial(): Promise<TransportClient> {
        const failure = failures[admitted]
        admitted += 1
        if (failure === undefined) throw new Error("unexpected transport admission")
        return Object.freeze({
          async fetch(): Promise<Response> {
            return responseFrom({ node: "a" }, new Uint8Array())
          },
          async close(): Promise<void> {
            throw failure
          }
        })
      }
    )
    const client = newClient(
      withTransport(subject.transport),
      withEndpoint(["memory://orders-a", "memory://orders-b"])
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      headers: {},
      body: new Uint8Array()
    }
    await client.call(background(), request)
    await client.call(background(), request)

    const failure = await rejected(client.close(background()))

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual(failures)
  })

  test("retains a defensive response snapshot in the standard Error cause", async () => {
    const responseHeader = { node: "a" }
    const responseBody = new Uint8Array([9, 8])
    const feedback = new Error("feedback failed")
    const subject = harness({
      feedbackFailure: feedback,
      response: responseFrom(responseHeader, responseBody)
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )
    const cleanup = completedCallFailure(failure)

    responseHeader.node = "changed"
    responseBody[0] = 0
    const response = completedResponse(cleanup)
    expect(response.headers.get("node")).toBe("a")
    expect(await bodyBytes(response)).toEqual(new Uint8Array([9, 8]))
    expect(cleanup.errors).toEqual([feedback])
    expect(Object.isFrozen(cleanup)).toBeTrue()
    expect(Object.isFrozen(cleanup.errors)).toBeTrue()
  })

  test("never retries after the business exchange completed", async () => {
    const feedback = new Error("feedback failed")
    const subject = harness({ feedbackFailure: feedback })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    let retryChecks = 0
    let backoffs = 0

    const failure = await rejected(
      client.call(
        background(),
        {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        },
        withRetry({
          authorization: "caller-approved",
          maxAttempts: 3,
          shouldRetry(): boolean {
            retryChecks += 1
            return true
          },
          backoff(): number {
            backoffs += 1
            return 0
          }
        })
      )
    )

    completedCallFailure(failure)
    expect(retryChecks).toBe(0)
    expect(backoffs).toBe(0)
    expect(subject.events.filter((event) => event === "fetch")).toHaveLength(1)
    expect(subject.events.filter((event) => event === "fetch")).toHaveLength(1)
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(null, true, true, { node: "a" })])
  })

  test("preserves feedback facts when caller cancellation races a successful retry exchange", async () => {
    const feedbackFailure = new Error("feedback failed after response")
    const cancellation = new Error("caller canceled before feedback failure")
    const [ctx, cancel] = withCancelCause(background())
    const subject = harness({
      onFetch() {
        cancel(cancellation)
      },
      feedbackFailure
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    let retryChecks = 0
    let backoffs = 0
    const failure = await rejected(
      client.call(
        ctx,
        {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        },
        withRetry({
          authorization: "caller-approved",
          maxAttempts: 3,
          shouldRetry(): boolean {
            retryChecks += 1
            return true
          },
          backoff(): number {
            backoffs += 1
            return 0
          }
        })
      )
    )
    const cleanup = completedCallFailure(failure)

    expect(await bodyBytes(completedResponse(cleanup))).toEqual(new Uint8Array([9, 8]))
    expect(cleanup.errors).toEqual([feedbackFailure])
    expect(cause(ctx)).toBe(cancellation)
    expect(retryChecks).toBe(0)
    expect(backoffs).toBe(0)
    expect(subject.events.filter((event) => event === "fetch")).toHaveLength(1)
    await client.close(background())
  })

  test("does not trust a structural cleanup lookalike when deciding retries", async () => {
    const feedback = new Error("lookalike feedback")
    const lookalike = new AggregateError(
      [feedback],
      "client exchange completed but cleanup failed; do not retry",
      { cause: { header: {}, body: new Uint8Array() } }
    )
    const subject = harness({ mainFailure: { stage: "fetch", value: lookalike } })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    let retryChecks = 0
    const failure = await rejected(
      client.call(
        background(),
        {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        },
        withRetry({
          authorization: "caller-approved",
          maxAttempts: 2,
          shouldRetry(_ctx, value): boolean {
            retryChecks += 1
            expect(value).toBe(lookalike)
            return false
          }
        })
      )
    )

    expect(failure).toBe(lookalike)
    expect(retryChecks).toBe(1)
  })

  test("rejects completion thenables deterministically and observes asynchronous rejection", async () => {
    const asynchronous = new Error("async feedback rejected")
    const continuation = new Error("feedback continuation rejected")
    const hostileAccessor = new Error("feedback then accessor failed")
    const hostileMethod = new Error("feedback then method failed")
    const cases = [
      {
        create(): unknown {
          return Promise.reject(asynchronous)
        },
        cause: null
      },
      {
        create(): unknown {
          return Promise.resolve()
        },
        cause: null
      },
      {
        create(): unknown {
          return {
            then(): Promise<never> {
              return Promise.reject(continuation)
            }
          }
        },
        cause: null
      },
      {
        create(): unknown {
          return Object.defineProperty({}, "then", {
            get(): never {
              throw hostileAccessor
            }
          })
        },
        cause: hostileAccessor
      },
      {
        create(): unknown {
          return {
            then(): never {
              throw hostileMethod
            }
          }
        },
        cause: hostileMethod
      }
    ] as const
    const unhandled: unknown[] = []
    function observeUnhandled(reason: unknown): void {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", observeUnhandled)
    try {
      for (const current of cases) {
        const subject = harness({
          onFeedback() {
            return current.create()
          }
        })
        const client = newClient(
          withEndpoint("discovery:///orders"),
          withDiscovery(subject.discovery),
          withSelector(subject.selector),
          withTransport(subject.transport)
        )
        const feedbackFailure = await rejected(
          client.call(background(), {
            service: "orders",
            endpoint: "Create",
            headers: {},
            body: new Uint8Array()
          })
        )
        const cleanup = completedCallFailure(feedbackFailure)
        expect(await bodyBytes(completedResponse(cleanup))).toEqual(new Uint8Array([9, 8]))
        expect(cleanup.errors).toHaveLength(1)
        expect(cleanup.errors[0]).toMatchObject({
          name: "TypeError",
          message: "Selector.select completion callback must return void"
        })
        expect(cleanup.errors[0]?.cause).toBe(current.cause ?? undefined)
        expect(subject.outcomes).toEqual([
          expectedSelectionOutcome(null, true, true, { node: "a" })
        ])
        await client.close(background())
        expectBoundedClose(subject.closeContexts)

        const primary = new Error("send failed")
        const failedSubject = harness({
          mainFailure: { stage: "fetch", value: primary },
          onFeedback() {
            return current.create()
          }
        })
        const failedClient = newClient(
          withEndpoint("discovery:///orders"),
          withDiscovery(failedSubject.discovery),
          withSelector(failedSubject.selector),
          withTransport(failedSubject.transport)
        )
        const aggregate = await rejected(
          failedClient.call(background(), {
            service: "orders",
            endpoint: "Create",
            headers: {},
            body: new Uint8Array()
          })
        )
        expect(aggregate).toBeInstanceOf(AggregateError)
        const errors = (aggregate as AggregateError).errors
        expect(errors[0]).toBe(primary)
        expect(errors[1]).toMatchObject({
          name: "TypeError",
          message: "Selector.select completion callback must return void"
        })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", observeUnhandled)
    }
  })

  test("aggregates paired failures without losing their lifecycle order", async () => {
    const primary = new Error("send failed")
    const feedback = new Error("feedback failed")
    const close = new Error("close failed")
    const cases = [
      {
        options: { mainFailure: { stage: "fetch", value: primary }, feedbackFailure: feedback },
        expected: [primary, feedback]
      },
      {
        options: { mainFailure: { stage: "fetch", value: primary }, closeFailure: close },
        expected: [primary, close]
      }
    ] satisfies readonly {
      readonly options: HarnessOptions
      readonly expected: readonly Error[]
    }[]

    for (const current of cases) {
      const subject = harness(current.options)
      const client = newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      const failure = await rejected(
        client.call(background(), {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        })
      )
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual(current.expected)
    }
  })

  test("aggregates independent failures in primary-feedback-close order", async () => {
    const primary = new Error("recv failed")
    const feedback = new Error("feedback failed")
    const close = new Error("close failed")
    const subject = harness({
      mainFailure: { stage: "fetch", value: primary },
      feedbackFailure: feedback,
      closeFailure: close
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([primary, feedback, close])
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(primary, true, false)])
    expect(subject.events.filter((event) => event.startsWith("done:"))).toHaveLength(1)
    expect(subject.events.filter((event) => event === "close")).toHaveLength(1)
  })

  test("decodes a canonical ServiceError without penalizing the selected endpoint", async () => {
    const failureResponse = serviceErrorResponse(
      serviceError("orders.denied", "request denied", 403, { tenant: "one" })
    )
    const subject = harness({ response: failureResponse })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    let retryChecks = 0

    const failure = await rejected(
      client.call(
        background(),
        {
          service: "orders",
          endpoint: "Create",
          headers: {},
          body: new Uint8Array()
        },
        withRetry({
          authorization: "caller-approved",
          maxAttempts: 2,
          shouldRetry(_ctx, rejectedFailure): boolean {
            retryChecks += 1
            expect(isServiceError(rejectedFailure)).toBe(true)
            return false
          }
        })
      )
    )

    expect(isServiceError(failure)).toBe(true)
    expect(failure).toMatchObject({ code: "orders.denied", status: 403 })
    expect(retryChecks).toBe(1)
    expect(subject.outcomes).toEqual([
      expectedSelectionOutcome(null, true, true, { "content-type": "application/json" })
    ])
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "fetch",
      "done:ok",
      "close"
    ])
  })

  test("reports an unavailable ServiceError to selector health feedback", async () => {
    const failureResponse = serviceErrorResponse(
      serviceError("orders.unavailable", "service unavailable", 503)
    )
    const subject = harness({ response: failureResponse })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(isServiceError(failure)).toBe(true)
    expect(failure).toMatchObject({ code: "orders.unavailable", status: 503 })
    expect(subject.outcomes).toEqual([
      expectedSelectionOutcome(failure, true, true, { "content-type": "application/json" })
    ])
    expect(subject.events.filter((event) => event.startsWith("done:"))).toEqual(["done:error"])
  })

  test("reports malformed ServiceError wire as an exact selector protocol failure", async () => {
    const malformed = new Uint8Array([0])
    const subject = harness({
      response: new Response(malformed, {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    })
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: new Uint8Array()
      })
    )

    expect(failure).toMatchObject({
      name: "TransportProtocolError",
      code: "GO_LIKE_TRANSPORT_PROTOCOL"
    })
    expect(subject.outcomes).toEqual([
      expectedSelectionOutcome(failure, true, true, { "content-type": "application/json" })
    ])
    expect(subject.events.filter((event) => event.startsWith("done:"))).toEqual(["done:error"])
    expect(subject.events.filter((event) => event === "close")).toHaveLength(1)
  })

  test("composes Client middleware with the first declaration outermost", async () => {
    const subject = harness()
    Reflect.set(subject.transport, "kind", function kind(): string {
      return "http"
    })
    const events: string[] = []
    const logicalInfos: TransportInfo[] = []
    /** Creates one named observable middleware layer. */
    function layer(name: string): ClientMiddleware {
      return (next) => async (ctx, request) => {
        events.push(`${name}:before`)
        const info = transportFromClientContext(ctx)
        if (info === null)
          throw new Error("Client middleware did not receive logical TransportInfo")
        logicalInfos.push(info)
        expect(info.kind()).toBe("http")
        expect(info.endpoint()).toBe("")
        expect(info.operation()).toBe("orders/Create")
        expect(info.requestHeaders()).toEqual({})
        expect(info.replyHeaders()).toEqual({})
        const response = await next(ctx, request)
        expect(transportFromClientContext(ctx)).toBe(info)
        expect(info.endpoint()).toBe(selectedEndpoint.url)
        expect(info.requestHeaders()).toEqual({})
        expect(info.replyHeaders()).toEqual({ node: ["a"] })
        expect(info.peerIdentity()).toBeNull()
        events.push(`${name}:after`)
        return response
      }
    }
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      middleware(layer("a")),
      middleware(layer("b"))
    )

    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    await client.close(background())

    expect(events).toEqual(["a:before", "b:before", "b:after", "a:after"])
    expect(logicalInfos).toHaveLength(2)
    expect(logicalInfos[1]).toBe(logicalInfos[0])
    const logicalInfo = logicalInfos[0]
    if (logicalInfo === undefined) throw new Error("middleware TransportInfo was unavailable")
    const attemptInfo = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (attemptInfo === null) throw new Error("Transport did not receive attempt TransportInfo")
    expect(attemptInfo).toBe(logicalInfo)
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "fetch",
      "done:ok",
      "close"
    ])
  })

  test("selects exact or longest-prefix operation middleware under global middleware", async () => {
    const subject = harness()
    const events: string[] = []
    /** Creates one observable middleware layer. */
    function layer(name: string): ClientMiddleware {
      return (next) =>
        async (ctx, request, ...options) => {
          events.push(`${name}:before`)
          const response = await next(ctx, request, ...options)
          events.push(`${name}:after`)
          return response
        }
    }
    const client = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      middleware(layer("global")),
      use("orders/*", layer("orders")),
      use("orders/C*", layer("orders-c")),
      use("orders/Create", layer("exact")),
      use("orders/Get", layer("replaced")),
      use("orders/Get", layer("get"))
    )

    const calls = [
      ["orders", "Create"],
      ["orders", "Cancel"],
      ["orders", "Get"],
      ["billing", "Create"]
    ] satisfies readonly (readonly [string, string])[]
    for (const [service, endpoint] of calls) {
      await client.call(background(), {
        service,
        endpoint,
        headers: {},
        body: new Uint8Array()
      })
    }

    expect(events).toEqual([
      "global:before",
      "exact:before",
      "exact:after",
      "global:after",
      "global:before",
      "orders-c:before",
      "orders-c:after",
      "global:after",
      "global:before",
      "get:before",
      "get:after",
      "global:after",
      "global:before",
      "global:after"
    ])
  })

  test("validates operation middleware selectors and snapshots", () => {
    const subject = harness()
    for (const selector of ["*", "orders*", "orders/*", "orders/Get*", "orders/Get"]) {
      expect(() => use(selector)).not.toThrow()
    }
    expect(() => use("")).toThrow(
      "client middleware selector must be a non-empty well-formed string"
    )
    expect(() => use("orders/*/get")).toThrow(
      "client middleware selector must be exact or end with one *"
    )
    expect(() => use("orders/**")).toThrow(
      "client middleware selector must be exact or end with one *"
    )
    for (const selector of [
      "orders",
      "orders/",
      "/Get",
      "orders//Get",
      " orders/Get",
      "订单/Get"
    ]) {
      expect(() => use(selector)).toThrow(
        "client middleware selector must identify a canonical operation or trailing wildcard"
      )
    }
    expect(() => Reflect.apply(use, undefined, ["orders/*", null])).toThrow(
      "Client middleware must be a function"
    )

    const invalidCollections = [
      (options: Parameters<ClientOption>[0]) => ({
        addresses: options.addresses,
        service: options.service,
        discovery: options.discovery,
        selector: options.selector,
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: new Map([["orders/*", null]]),
        closeTimeoutMs: options.closeTimeoutMs
      }),
      (options: Parameters<ClientOption>[0]) => ({
        addresses: options.addresses,
        service: options.service,
        discovery: options.discovery,
        selector: options.selector,
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: new Map([["orders/*", [null]]]),
        closeTimeoutMs: options.closeTimeoutMs
      })
    ]
    for (const invalid of invalidCollections) {
      expect(() =>
        Reflect.apply(newClient, undefined, [
          withEndpoint("discovery:///orders"),
          withDiscovery(subject.discovery),
          withTransport(subject.transport),
          invalid
        ])
      ).toThrow(TypeError)
    }

    const malformed = use("orders/*", () => null as never)
    expect(() =>
      newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withTransport(subject.transport),
        malformed
      )
    ).toThrow("Client middleware must return a Call function")
  })

  test("validates operation middleware selectors injected by custom ClientOption values", () => {
    const subject = harness()
    expect(() =>
      newClient(
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withTransport(subject.transport),
        (options) => ({
          addresses: options.addresses,
          service: options.service,
          discovery: options.discovery,
          selector: options.selector,
          transport: options.transport,
          middleware: options.middleware,
          operationMiddleware: new Map([["orders/", Object.freeze([])]]),
          closeTimeoutMs: options.closeTimeoutMs
        })
      )
    ).toThrow("client middleware selector must identify a canonical operation or trailing wildcard")
  })

  test("lets explicit middleware short-circuit or call the base more than once", async () => {
    const shortSubject = harness()
    const short = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(shortSubject.discovery),
      withSelector(shortSubject.selector),
      withTransport(shortSubject.transport),
      middleware(() => async () => responseFrom({ cached: "yes" }, new Uint8Array([1])))
    )
    const cached = await short.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    expect(cached.headers.get("cached")).toBe("yes")
    expect(shortSubject.events).toEqual([])

    const repeatedSubject = harness()
    const repeated = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(repeatedSubject.discovery),
      withSelector(repeatedSubject.selector),
      withTransport(repeatedSubject.transport),
      middleware((next) => async (ctx, request) => {
        // The discarded attempt must release its raw body before the second dial decision.
        await bodyBytes(await next(ctx, request))
        return await next(ctx, request)
      })
    )
    await repeated.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    expect(repeatedSubject.outcomes).toEqual([
      expectedSelectionOutcome(null, true, true, { node: "a" }),
      expectedSelectionOutcome(null, true, true, { node: "a" })
    ])
    expect(repeatedSubject.events.filter((event) => event.startsWith("dial:"))).toHaveLength(1)
    await repeated.close(background())
    expect(repeatedSubject.events.filter((event) => event === "close")).toHaveLength(1)

    const replacedSubject = harness()
    const replaced = newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(replacedSubject.discovery),
      withSelector(replacedSubject.selector),
      withTransport(replacedSubject.transport),
      middleware((next) => async (_ctx, request, ...options) => {
        return await next(background(), request, ...options)
      })
    )
    await replaced.call(background(), {
      service: "orders",
      endpoint: "Create",
      headers: {},
      body: new Uint8Array()
    })
    const replacedInfo = transportFromClientContext(replacedSubject.dialContexts[0] ?? background())
    if (replacedInfo === null) throw new Error("replacement Context lost attempt TransportInfo")
    expect(replacedInfo.endpoint()).toBe(selectedEndpoint.url)
  })

  test("rejects malformed middleware before any call I/O", () => {
    const subject = harness()
    expect(() => Reflect.apply(middleware, undefined, [null])).toThrow(TypeError)
    for (const invalidOption of [() => null, () => ({ middleware: [null] })]) {
      expect(() =>
        Reflect.apply(newClient, undefined, [
          withEndpoint("discovery:///orders"),
          withDiscovery(subject.discovery),
          withSelector(subject.selector),
          withTransport(subject.transport),
          invalidOption
        ])
      ).toThrow(TypeError)
    }
    const invalidMiddleware = Reflect.apply(middleware, undefined, [() => Object.freeze({})])
    expect(() =>
      Reflect.apply(newClient, undefined, [
        withEndpoint("discovery:///orders"),
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport),
        invalidMiddleware
      ])
    ).toThrow(TypeError)
    expect(subject.events).toEqual([])
  })

  test("validates and snapshots transport close and idle pool bounds", () => {
    const subject = harness()
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => closeTimeout(invalid)).toThrow(RangeError)
      expect(() => poolSize(invalid)).toThrow(RangeError)
      expect(() => poolTtl(invalid)).toThrow(RangeError)
    }

    const defaults: { value: Parameters<ClientOption>[0] | null } = { value: null }
    newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      (options) => {
        defaults.value = options
        return options
      }
    )
    expect(defaults.value).toEqual({
      addresses: [],
      service: "orders",
      discovery: subject.discovery,
      selector: subject.selector,
      transport: subject.transport,
      block: false,
      middleware: [],
      operationMiddleware: new Map(),
      closeTimeoutMs: 1_000,
      poolSize: 100,
      poolTtlMs: 60_000
    })

    const captured: { value: Parameters<ClientOption>[0] | null } = { value: null }
    const inspect: ClientOption = (options) => {
      captured.value = options
      return options
    }
    newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      closeTimeout(25),
      poolSize(7),
      poolTtl(9),
      inspect
    )

    expect(captured.value).toEqual({
      addresses: [],
      service: "orders",
      discovery: subject.discovery,
      selector: subject.selector,
      transport: subject.transport,
      block: false,
      middleware: [],
      operationMiddleware: new Map(),
      closeTimeoutMs: 25,
      poolSize: 7,
      poolTtlMs: 9
    })
    expect(Object.isFrozen(captured.value)).toBeTrue()
    expect(subject.events).toEqual([])
  })

  test("normalizes and preserves block across every built-in Client option", () => {
    const subject = harness()
    const clientMiddleware: ClientMiddleware = (next) => next
    for (const invalid of [null, "yes", 1]) {
      expect(() =>
        Reflect.apply(newClient, undefined, [
          withEndpoint("discovery:///orders"),
          withDiscovery(subject.discovery),
          withTransport(subject.transport),
          (options: Parameters<ClientOption>[0]) => ({
            addresses: options.addresses,
            service: options.service,
            discovery: options.discovery,
            selector: options.selector,
            transport: options.transport,
            block: invalid,
            middleware: options.middleware,
            operationMiddleware: options.operationMiddleware,
            closeTimeoutMs: options.closeTimeoutMs
          })
        ])
      ).toThrow("Client block option must be a boolean")
    }

    const captured: { value: Parameters<ClientOption>[0] | null } = { value: null }
    newClient(
      withBlock(),
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      middleware(clientMiddleware),
      use("orders/*", clientMiddleware),
      closeTimeout(25),
      (options) => {
        captured.value = options
        return options
      }
    )
    expect(captured.value?.block).toBeTrue()

    const compatible: { value: Parameters<ClientOption>[0] | null } = { value: null }
    newClient(
      withEndpoint("discovery:///orders"),
      withDiscovery(subject.discovery),
      withTransport(subject.transport),
      (options) => ({
        addresses: options.addresses,
        service: options.service,
        discovery: options.discovery,
        selector: options.selector,
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: options.operationMiddleware,
        closeTimeoutMs: options.closeTimeoutMs
      }),
      (options) => {
        compatible.value = options
        return options
      }
    )
    expect(compatible.value?.block).toBeFalse()
  })

  test("rejects a lone surrogate and a raw body that is not bytes", async () => {
    expect(() => withEndpoint("discovery:///\uDC00")).toThrow(
      "withEndpoint endpoint must be well-formed"
    )
    expect(typeof withEndpoint("discovery:///\uD800\uDC00")).toBe("function")
    const subject = harness()
    const client = newClient(withTransport(subject.transport), withEndpoint("memory://orders"))
    await expect(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: "text" as never
      })
    ).rejects.toThrow("CallRequest.body must be a Uint8Array or null")
    await client.close(background())
  })

  test("abandons a non-JSON error when cancel and the fallback read both fail", async () => {
    const transportClient: TransportClient = {
      async fetch(): Promise<Response> {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller): void {
              controller.error(new Error("unreadable"))
            },
            cancel(): Promise<void> {
              return Promise.reject(new Error("cancel failed"))
            }
          }),
          { status: 503, headers: { "content-type": "text/plain" } }
        )
      },
      async close(): Promise<void> {}
    }
    const transport: Transport = {
      kind: () => "http",
      init(): void {},
      options(): Options {
        throw new Error("unused")
      },
      async dial(): Promise<TransportClient> {
        return transportClient
      },
      async listen(): Promise<Listener> {
        throw new Error("unused")
      },
      string: () => "test"
    }
    const client = newClient(withTransport(transport), withEndpoint("http://127.0.0.1:9/"))
    await expect(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        headers: {},
        body: null
      })
    ).rejects.toMatchObject({ message: "client received HTTP status 503" })
    await client.close(background())
  })
})

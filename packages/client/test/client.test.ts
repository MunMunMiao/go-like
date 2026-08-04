import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

import {
  background,
  canceled,
  cause,
  deadlineExceeded,
  withCancelCause,
  withValue,
  type Context
} from "@go-like/context"
import { fromClientContext, newMetadata, newClientContext, type Metadata } from "@go-like/metadata"
import { filterLabel, filterVersion } from "@go-like/registry"
import { struct } from "@go-like/struct"
import type {
  Discovery,
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
  Message,
  Options,
  Transport,
  TransportInfo
} from "@go-like/transport"
import { encodeMetadataHeader, encodeServiceError } from "@go-like/transport/provider"
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
  withAddress,
  withFilter,
  withRetry,
  type CallOption,
  type CallRequest,
  type ClientMiddleware,
  type ClientOption
} from "../src/index"
import { newDiscoveryResolver } from "../src/resolver"

type MainStage = "discover" | "select" | "dial" | "send" | "recv"

interface MainFailure {
  readonly stage: MainStage
  readonly value: unknown
}

interface CustomAfterContext extends Context {
  afterFunc(callback: () => void): () => boolean
}

interface HarnessOptions {
  readonly mainFailure?: MainFailure
  readonly feedbackFailure?: unknown
  readonly closeFailure?: unknown
  readonly response?: Message
  readonly onDiscover?: () => void
  readonly onSend?: (client: TransportClient) => void
  readonly onRecv?: (ctx: Context) => void
  readonly onFeedback?: (client: TransportClient) => unknown
  readonly onClose?: (ctx: Context) => void | PromiseLike<void>
}

interface Harness {
  readonly discovery: Discovery
  readonly selector: Selector
  readonly transport: Transport
  readonly events: string[]
  readonly sent: Message[]
  readonly discoveryContexts: Context[]
  readonly selectionContexts: Context[]
  readonly dialContexts: Context[]
  readonly sendContexts: Context[]
  readonly recvContexts: Context[]
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

/** Builds structural dependencies while recording every observable Client boundary. */
function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = []
  const sent: Message[] = []
  const discoveryContexts: Context[] = []
  const selectionContexts: Context[] = []
  const dialContexts: Context[] = []
  const sendContexts: Context[] = []
  const recvContexts: Context[] = []
  const feedbackContexts: Context[] = []
  const outcomes: SelectionOutcome[] = []
  const closeContexts: Context[] = []
  const instances = Object.freeze([selectedEndpoint.instance])

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
    async send(this: TransportClient, ctx, message): Promise<void> {
      expect(this).toBe(transportClient)
      events.push("send")
      sendContexts.push(ctx)
      sent.push(message)
      options.onSend?.(transportClient)
      if (options.mainFailure?.stage === "send") throw options.mainFailure.value
    },
    async recv(this: TransportClient, ctx): Promise<Message> {
      expect(this).toBe(transportClient)
      events.push("recv")
      recvContexts.push(ctx)
      options.onRecv?.(ctx)
      if (options.mainFailure?.stage === "recv") throw options.mainFailure.value
      return options.response ?? { header: { node: "a" }, body: new Uint8Array([9, 8]) }
    },
    async close(this: TransportClient, ctx): Promise<void> {
      expect(this).toBe(transportClient)
      events.push("close")
      closeContexts.push(ctx)
      await options.onClose?.(ctx)
      if (options.closeFailure !== undefined) throw options.closeFailure
    },
    local(): string {
      return "client"
    },
    remote(): string {
      return selectedEndpoint.url
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
    sendContexts,
    recvContexts,
    feedbackContexts,
    outcomes,
    closeContexts,
    instances
  }
}

/** Requires one Promise to reject with an Error and returns its exact identity. */
async function rejected(operation: PromiseLike<unknown>): Promise<Error> {
  try {
    await operation
  } catch (value) {
    if (value instanceof Error) return value
    throw new Error("Client rejection was not normalized to Error")
  }
  throw new Error("Client operation unexpectedly fulfilled")
}

/** Returns one rejected value without normalizing its JavaScript identity. */
async function rejectedValue(operation: PromiseLike<unknown>): Promise<unknown> {
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
function completedResponse(value: AggregateError): Message {
  const response = value.cause
  if (typeof response !== "object" || response === null || !("header" in response)) {
    throw new Error("completed call failure did not retain its response")
  }
  return response as Message
}

/** Bounds one test wait without retaining its guard timer after settlement. */
async function within<T>(operation: PromiseLike<T>, timeoutMs = 250): Promise<T> {
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

/** Polls one asynchronous resident-state transition under a finite test boundary. */
async function eventually(check: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("resident state did not converge")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
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
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )

    try {
      await client.call(background(), {
        service: "orders",
        endpoint: "Get",
        message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const pending = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const pending = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
              message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(source.discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
    }

    try {
      await client.call(background(), request)
      source.update(Object.freeze([second]))
      source.failWatcher(new Error("watch failed"))
      await eventually(() => source.counts.watch === 2)
      await Promise.resolve()
      subject.events.length = 0
      await client.call(background(), request)
      expect(subject.events).toContain("dial:http://127.0.0.1:9191/")
      expect(source.counts.get).toBe(2)
    } finally {
      await client.close(background())
    }
    expect(source.counts.stop).toBe(2)
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
      withDiscovery(discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Get",
        message: { header: {}, body: new Uint8Array() }
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

  test("aggregates discovery watcher close failures in service admission order", async () => {
    const first = new Error("orders watcher stop failed")
    const second = new Error("billing watcher stop failed")
    const transportFailure = new Error("transport close failed")
    const failures = new Map([
      ["orders", first],
      ["billing", second]
    ])
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
        const stopFailure = failures.get(name)
        if (stopFailure === undefined) throw new Error("unexpected service")
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
            if (name === "orders") throw stopFailure
            return Promise.reject(stopFailure)
          }
        })
      }
    })
    const subject = harness({ closeFailure: transportFailure })
    const client = newClient(
      withDiscovery(discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    for (const service of ["orders", "billing"]) {
      await client.call(background(), {
        service,
        endpoint: "Get",
        message: { header: {}, body: new Uint8Array() }
      })
    }

    const firstClose = client.close(background())
    const secondClose = client.close(background())
    const [failure, repeatedFailure] = await Promise.all([
      rejected(firstClose),
      rejected(secondClose)
    ])

    expect(failure).toBeInstanceOf(AggregateError)
    const closeFailures = (failure as AggregateError).errors
    expect(closeFailures[0]).toBeInstanceOf(AggregateError)
    expect((closeFailures[0] as AggregateError).errors).toEqual([
      transportFailure,
      transportFailure
    ])
    expect(closeFailures[1]).toBeInstanceOf(AggregateError)
    expect((closeFailures[1] as AggregateError).errors).toEqual([first, second])
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
      withDiscovery(discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
    const client = newClient(withTransport(harness().transport))
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
    const client = newClient(withTransport(subject.transport))
    await client.call(
      background(),
      {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      },
      withAddress("memory://orders")
    )
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
      withDiscovery(discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const called = client.call(background(), {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(discovery),
      withSelector(firstEndpointSelector()),
      withTransport(subject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
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
      response: { header: responseHeader, body: responseBody },
      onDiscover() {
        requestHeader.tenant = "changed"
        requestBody[0] = 99
      }
    })
    const client = newClient(
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
      message: { header: requestHeader, body: requestBody }
    })
    await client.close(background())

    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "send",
      "recv",
      "done:ok",
      "close"
    ])
    expect(subject.sent).toHaveLength(1)
    const outbound = subject.sent[0]
    if (outbound === undefined) throw new Error("Client did not send its outbound Message")
    expect(outbound.header).toEqual({
      tenant: "one",
      "Go-Like-Method": "POST",
      "Go-Like-Service": "orders",
      "Go-Like-Endpoint": "Create",
      "Go-Like-Metadata": metadataWire
    })
    expect(outbound.body).toEqual(new Uint8Array([1, 2, 3]))
    expect(Object.isFrozen(outbound)).toBe(true)
    expect(Object.isFrozen(outbound.header)).toBe(true)

    responseHeader.Node = "changed"
    responseBody[0] = 77
    expect(response.header).toEqual({ Node: "a" })
    expect(response.body).toEqual(new Uint8Array([9, 8]))
    const firstBody = response.body
    firstBody[0] = 55
    expect(response.body).toEqual(new Uint8Array([9, 8]))
    expect(Object.isFrozen(response)).toBe(true)

    expect(transportFromClientContext(rootContext)).toBeNull()
    expect(subject.dialContexts).toHaveLength(1)
    expect(subject.sendContexts).toEqual(subject.dialContexts)
    expect(subject.recvContexts).toEqual(subject.dialContexts)
    const transportInfo = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (transportInfo === null) throw new Error("Client did not inject TransportInfo")
    expect(transportInfo.kind()).toBe("http")
    expect(transportInfo.endpoint()).toBe("http://127.0.0.1:8080/")
    expect(transportInfo.operation()).toBe("orders/Create")
    expect(transportInfo.requestHeaders()).toEqual({
      "go-like-endpoint": ["Create"],
      "go-like-metadata": [metadataWire],
      "go-like-method": ["POST"],
      "go-like-service": ["orders"],
      tenant: ["one"]
    })
    expect(transportInfo.replyHeaders()).toEqual({ node: ["a"] })
    expect(fromClientContext(subject.dialContexts[0] ?? background())).toEqual({
      baggage: ["one", "two"]
    })
    expect(outbound.header).not.toHaveProperty("baggage")
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
      message: { header: {}, body: new Uint8Array() }
    })
    await client.close(background())
    expect(subject.events).toEqual([
      "discover:orders-v2",
      "discover:orders-v2",
      "select",
      "dial:http://127.0.0.1:8080/",
      "send",
      "recv",
      "done:ok",
      "close"
    ])
  })

  test("captures admitted transport client methods before borrowed callbacks can mutate them", async () => {
    let replacementRecvCalls = 0
    let replacementCloseCalls = 0
    const subject = harness({
      onSend(transportClient) {
        Reflect.set(transportClient, "recv", async function replacementRecv(): Promise<Message> {
          replacementRecvCalls += 1
          return { header: {}, body: new Uint8Array([1]) }
        })
      },
      onFeedback(transportClient) {
        Reflect.set(transportClient, "close", async function replacementClose(): Promise<void> {
          replacementCloseCalls += 1
        })
      }
    })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const response = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
    })
    await client.close(background())

    expect(response.body).toEqual(new Uint8Array([9, 8]))
    expect(replacementRecvCalls).toBe(0)
    expect(replacementCloseCalls).toBe(0)
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "send",
      "recv",
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
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
        async recv(): Promise<Message> {
          return { header: {}, body: new Uint8Array() }
        },
        async close(): Promise<void> {
          closes += 1
        }
      }
      Object.defineProperty(admitted, "send", {
        get() {
          throw accessorFailure
        }
      })
      return admitted as never
    })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
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
        send(): Promise<void> {
          return Promise.resolve()
        },
        recv(): Promise<Message> {
          return Promise.resolve({ header: {}, body: new Uint8Array() })
        }
      } as never
    })
    const missingCloseClient = newClient(
      withDiscovery(withoutClose.discovery),
      withSelector(withoutClose.selector),
      withTransport(withoutClose.transport)
    )
    await expect(
      missingCloseClient.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    ).rejects.toThrow("transport dial must return a Client with send, recv, and close")

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
      withDiscovery(withFailingClose.discovery),
      withSelector(withFailingClose.selector),
      withTransport(withFailingClose.transport)
    )
    const failure = await rejected(
      failingCloseClient.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
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
        discovery: {},
        selector: options.selector,
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: options.operationMiddleware,
        closeTimeoutMs: options.closeTimeoutMs
      }),
      (options: Parameters<ClientOption>[0]) => ({
        discovery: options.discovery,
        selector: {},
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: options.operationMiddleware,
        closeTimeoutMs: options.closeTimeoutMs
      }),
      (options: Parameters<ClientOption>[0]) => ({
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

  test("requires discovery only for calls without a direct address", async () => {
    const subject = harness()
    const client = newClient(withTransport(subject.transport))

    await expect(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    ).rejects.toThrow("client call without a direct address requires discovery")
    expect(subject.events).toEqual([])
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
      withDiscovery(firstDiscovery.discovery),
      withTransport(firstSubject.transport)
    )
    const second = newClient(
      withDiscovery(secondDiscovery.discovery),
      withTransport(secondSubject.transport)
    )
    const request: CallRequest = {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
    }

    await first.call(background(), request)
    await first.call(background(), request)
    await first.call(background(), request)
    await second.call(background(), request)

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

  test("calls one typed endpoint without replacing the raw Message API", async () => {
    const NumberValue = struct.number()
    const operation = endpoint("orders", "Create", NumberValue, NumberValue)
    const subject = harness({
      response: {
        header: { "content-type": "Application/JSON; charset=utf-8" },
        body: new TextEncoder().encode("42")
      }
    })
    const client = newClient(withDiscovery(subject.discovery), withTransport(subject.transport))

    await expect(client.call(background(), operation, 7)).resolves.toBe(42)
    expect(subject.sent).toHaveLength(1)
    expect(subject.sent[0]).toEqual({
      header: {
        "Content-Type": "application/json",
        "Go-Like-Endpoint": "Create",
        "Go-Like-Service": "orders"
      },
      body: new TextEncoder().encode("7")
    })

    const raw = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
    })
    expect(raw.body).toEqual(new TextEncoder().encode("42"))
    await client.close(background())
  })

  test("maps malformed typed responses to TransportProtocolError", async () => {
    const NumberValue = struct.number()
    const operation = endpoint("orders", "Create", NumberValue, NumberValue)
    const responses = [
      { header: {}, body: new TextEncoder().encode("1") },
      {
        header: {
          "Content-Type": "application/json",
          "content-type": "application/json"
        },
        body: new TextEncoder().encode("1")
      },
      {
        header: { "Content-Type": "application/json" },
        body: new TextEncoder().encode('"invalid"')
      }
    ]

    for (const response of responses) {
      const subject = harness({ response })
      const client = newClient(
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
        expectedSelectionOutcome(failure, true, true, response.header)
      ])
      await client.close(background())
    }
  })

  test("keeps typed response validation inside selector, retry, and operation middleware", async () => {
    const NumberValue = struct.number()
    const operation = endpoint("orders", "Create", NumberValue, NumberValue)
    const subject = harness({
      response: {
        header: { "Content-Type": "application/json" },
        body: new TextEncoder().encode('"invalid"')
      }
    })
    const observed: Error[] = []
    const client = newClient(
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
        "Content-Type": "application/json"
      }),
      expectedSelectionOutcome(failure, true, true, {
        "Content-Type": "application/json"
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
    const client = newClient(withDiscovery(subject.discovery), withTransport(subject.transport))

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
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      const request = {
        service: field === "service" ? value : "orders",
        endpoint: field === "endpoint" ? value : "Create",
        message: { header: {}, body: new Uint8Array() }
      }
      await expect(
        Reflect.apply(client.call, client, [background(), request])
      ).rejects.toBeInstanceOf(TypeError)
      expect(subject.events).toEqual([])
    }
  })

  test("rejects either reserved header case-insensitively before discovery", async () => {
    for (const header of [{ "GO-LIKE-service": "caller" }, { "go-like-ENDPOINT": "caller" }]) {
      const subject = harness()
      const client = newClient(
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      await expect(
        client.call(background(), {
          service: "orders",
          endpoint: "Create",
          message: { header, body: new Uint8Array() }
        })
      ).rejects.toBeInstanceOf(TypeError)
      expect(subject.events).toEqual([])
    }
  })

  test("projects large TransportInfo headers in one grouped snapshot without losing valid neighbors", async () => {
    const requestHeader: Record<string, string> = {
      "bad key": "still-on-wire",
      "bad-value": "contains\0control",
      "X-Duplicate": "first",
      "x-duplicate": "second",
      emoji: "😀",
      "": "empty-key",
      "\ud800": "unpaired-key",
      "bad-surrogate-value": "\ud800"
    }
    for (let index = 0; index < 2_000; index += 1) {
      requestHeader[`x-request-${index}`] = String(index)
    }
    const responseHeader: Record<string, string> = {
      "bad key": "still-on-wire",
      "bad-value": "contains\0control",
      "X-Duplicate": "first",
      "x-duplicate": "second",
      "x-oversize": "x".repeat(4_097),
      emoji: "😀",
      "": "empty-key",
      "\ud800": "unpaired-key",
      "bad-surrogate-value": "\ud800"
    }
    for (let index = 0; index < 2_000; index += 1) {
      responseHeader[`x-response-${index}`] = String(index)
    }
    const subject = harness({
      response: { header: responseHeader, body: new Uint8Array([1]) }
    })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const response = await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: requestHeader, body: new Uint8Array() }
    })

    expect(response.header).toEqual(responseHeader)
    expect(subject.events).toContain("dial:http://127.0.0.1:8080/")
    expect(subject.sent[0]?.header["bad key"]).toBe("still-on-wire")
    expect(subject.sent[0]?.header["bad-value"]).toBe("contains\0control")
    const info = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (info === null) throw new Error("Transport did not receive TransportInfo")
    const requestProjection = info.requestHeaders()
    expect(Object.keys(requestProjection)).toHaveLength(2_006)
    expect(requestProjection["go-like-service"]).toEqual(["orders"])
    expect(requestProjection["go-like-endpoint"]).toEqual(["Create"])
    expect(requestProjection["bad key"]).toEqual(["still-on-wire"])
    expect(requestProjection["bad-value"]).toEqual(["contains\0control"])
    expect(requestProjection["x-duplicate"]).toEqual(["first", "second"])
    expect(requestProjection["emoji"]).toEqual(["😀"])
    expect(requestProjection["x-request-1999"]).toEqual(["1999"])
    expect(requestProjection).not.toHaveProperty("")
    expect(requestProjection).not.toHaveProperty("\ud800")
    expect(requestProjection).not.toHaveProperty("bad-surrogate-value")
    const replyProjection = info.replyHeaders()
    expect(Object.keys(replyProjection)).toHaveLength(2_005)
    expect(replyProjection["bad key"]).toEqual(["still-on-wire"])
    expect(replyProjection["bad-value"]).toEqual(["contains\0control"])
    expect(replyProjection["x-duplicate"]).toEqual(["first", "second"])
    expect(replyProjection["emoji"]).toEqual(["😀"])
    expect(replyProjection["x-response-1999"]).toEqual(["1999"])
    expect(replyProjection["x-oversize"]).toEqual(["x".repeat(4_097)])
    expect(replyProjection).not.toHaveProperty("")
    expect(replyProjection).not.toHaveProperty("\ud800")
    expect(replyProjection).not.toHaveProperty("bad-surrogate-value")

    const unrepresentable = harness()
    const unrepresentableClient = newClient(
      withDiscovery(unrepresentable.discovery),
      withSelector(unrepresentable.selector),
      withTransport(unrepresentable.transport)
    )
    await expect(
      unrepresentableClient.call(background(), {
        service: "orders",
        endpoint: "Create\0",
        message: { header: {}, body: new Uint8Array() }
      })
    ).rejects.toThrow("CallRequest.endpoint must be a visible ASCII route token")
    expect(transportFromClientContext(unrepresentable.dialContexts[0] ?? background())).toBeNull()
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
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )

      await expect(
        client.call(background(), {
          service: "orders",
          endpoint: "Create",
          message: { header: {}, body: new Uint8Array() }
        })
      ).rejects.toBeInstanceOf(TypeError)
      expect(subject.events).toEqual(["discover:orders", "discover:orders", "select"])
      expect(subject.dialContexts).toEqual([])
      expect(subject.outcomes).toEqual([])
    }
  })

  test("uses one direct address without Discovery, Selector, or transport-scheme filtering", async () => {
    const subject = harness()
    Reflect.set(subject.transport, "kind", function invalidKind(): string {
      throw new Error("optional kind failed")
    })
    const client = newClient(
      withTransport(subject.transport),
      middleware((next) => async (ctx, request, ...options) => {
        expect(options).toHaveLength(1)
        return await next(ctx, request, ...options)
      })
    )

    const response = await client.call(
      background(),
      {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      },
      withAddress("memory://orders-direct")
    )
    await client.close(background())

    expect(response.body).toEqual(new Uint8Array([9, 8]))
    expect(subject.events).toEqual(["dial:memory://orders-direct", "send", "recv", "close"])
    expect(subject.outcomes).toEqual([])
    const transportInfo = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (transportInfo === null) throw new Error("Direct call did not inject TransportInfo")
    expect(transportInfo.kind()).toBe("transport")
    expect(transportInfo.endpoint()).toBe("memory://orders-direct")
    expect(transportInfo.operation()).toBe("orders/Create")
  })

  test("reports direct-address owner close timeout without inventing Selector feedback", async () => {
    const subject = harness({
      onClose() {
        return new Promise<void>(function neverSettles(): void {})
      }
    })
    Reflect.deleteProperty(subject.transport, "kind")
    const client = newClient(withTransport(subject.transport), closeTimeout(5))
    const response = await client.call(
      background(),
      {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      },
      withAddress("memory://orders-direct")
    )
    const failure = await rejected(client.close(background()))

    expect(response.body).toEqual(new Uint8Array([9, 8]))
    expect(failure).toMatchObject({
      message: "transport client close exceeded 5ms"
    })
    expect(subject.events).toEqual(["dial:memory://orders-direct", "send", "recv", "close"])
    expect(subject.outcomes).toEqual([])
  })

  test("keeps one idle transport owner per address without sharing an active lease", async () => {
    const subject = harness()
    let dials = 0
    let closes = 0
    Reflect.set(subject.transport, "dial", async function distinctDial(): Promise<TransportClient> {
      dials += 1
      return Object.freeze({
        async send(): Promise<void> {},
        async recv(): Promise<Message> {
          await Promise.resolve()
          return { header: {}, body: new Uint8Array([dials]) }
        },
        async close(): Promise<void> {
          closes += 1
        },
        local(): string {
          return "client"
        },
        remote(): string {
          return "memory://orders"
        }
      })
    })
    const client = newClient(withTransport(subject.transport))
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
    }
    const call = (): Promise<Message> =>
      client.call(background(), request, withAddress("memory://orders"))

    await call()
    await Promise.all([call(), call()])

    expect(dials).toBe(2)
    expect(closes).toBe(1)
    await client.close(background())
    await client.close(background())
    expect(closes).toBe(2)
    await expect(call()).rejects.toThrow("client is closed")
    expect(dials).toBe(2)
  })

  test("bounds the global idle pool by least-recently-used address and supports zero reuse", async () => {
    const closed: string[] = []
    let dials = 0
    const transport: Transport = Object.freeze({
      init(): void {
        throw new Error("unexpected init")
      },
      async dial(_ctx: Context, address: string): Promise<TransportClient> {
        dials += 1
        const identity = `${address}#${dials}`
        return Object.freeze({
          async send(): Promise<void> {},
          async recv(): Promise<Message> {
            return { header: {}, body: new Uint8Array() }
          },
          async close(): Promise<void> {
            closed.push(identity)
          },
          local(): string {
            return "client"
          },
          remote(): string {
            return address
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
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
    }
    const client = newClient(withTransport(transport), poolSize(2), poolTtl(0))
    const call = (address: string): Promise<Message> =>
      client.call(background(), request, withAddress(address))

    await call("memory://a")
    await call("memory://b")
    await call("memory://c")
    await eventually(() => closed.length === 1)
    expect(closed).toEqual(["memory://a#1"])

    await call("memory://b")
    expect(dials).toBe(3)
    await call("memory://d")
    await eventually(() => closed.length === 2)
    expect(closed).toEqual(["memory://a#1", "memory://c#3"])
    await client.close(background())

    closed.length = 0
    dials = 0
    const defaults = newClient(withTransport(transport), poolTtl(0))
    for (let index = 0; index < 101; index += 1) {
      await defaults.call(background(), request, withAddress(`memory://default-${index}`))
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
          async send(): Promise<void> {},
          async recv(): Promise<Message> {
            return { header: {}, body: new Uint8Array() }
          },
          async close(): Promise<void> {
            zeroCloses += 1
          },
          local(): string {
            return "client"
          },
          remote(): string {
            return "memory://zero"
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
    const zero = newClient(withTransport(noReuse), poolSize(0))
    await zero.call(background(), request, withAddress("memory://zero"))
    await zero.call(background(), request, withAddress("memory://zero"))
    expect([zeroDials, zeroCloses]).toEqual([2, 2])
    await zero.close(background())
  })

  test("expires idle owners without a later acquire but never expires an active lease", async () => {
    const held = Promise.withResolvers<Message>()
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
          async send(): Promise<void> {},
          recv(): Promise<Message> {
            receives += 1
            if (receives === 2) return held.promise
            return Promise.resolve({ header: {}, body: new Uint8Array() })
          },
          async close(): Promise<void> {
            closes += 1
          },
          local(): string {
            return "client"
          },
          remote(): string {
            return "memory://ttl"
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
    const client = newClient(withTransport(transport), poolTtl(10))
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
    }
    await client.call(background(), request, withAddress("memory://ttl"))
    const active = client.call(background(), request, withAddress("memory://ttl"))
    await eventually(() => receives === 2)
    await Bun.sleep(25)
    expect([dials, closes]).toEqual([1, 0])
    held.resolve({ header: {}, body: new Uint8Array() })
    await active
    await eventually(() => closes === 1)
    expect(dials).toBe(1)
    await client.close(background())
  })

  test("joins close, release, and idle timer races through one owner close", async () => {
    const heldResponse = Promise.withResolvers<Message>()
    const heldClose = Promise.withResolvers<void>()
    let receives = 0
    let closes = 0
    const transport: Transport = Object.freeze({
      init(): void {
        throw new Error("unexpected init")
      },
      async dial(): Promise<TransportClient> {
        return Object.freeze({
          async send(): Promise<void> {},
          recv(): Promise<Message> {
            receives += 1
            if (receives === 2) return heldResponse.promise
            return Promise.resolve({ header: {}, body: new Uint8Array() })
          },
          close(): Promise<void> {
            closes += 1
            return heldClose.promise
          },
          local(): string {
            return "client"
          },
          remote(): string {
            return "memory://race"
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
    const client = newClient(withTransport(transport), poolTtl(10))
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
    }
    await client.call(background(), request, withAddress("memory://race"))
    const call = client.call(background(), request, withAddress("memory://race"))
    await eventually(() => receives === 2)
    const closing = client.close(background())
    await eventually(() => closes === 1)
    heldResponse.resolve({ header: {}, body: new Uint8Array() })
    heldClose.resolve()
    await Promise.all([call, closing])
    await Bun.sleep(20)
    expect(closes).toBe(1)
  })

  test("closes an active transport owner and rejects future calls", async () => {
    const subject = harness()
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Message>()
    const stopped = new Error("transport owner stopped")
    let closes = 0
    Reflect.set(subject.transport, "dial", async function activeDial(): Promise<TransportClient> {
      return Object.freeze({
        async send(): Promise<void> {},
        recv(): Promise<Message> {
          started.resolve()
          return response.promise
        },
        async close(): Promise<void> {
          closes += 1
          response.reject(stopped)
        },
        local(): string {
          return "client"
        },
        remote(): string {
          return "memory://orders"
        }
      })
    })
    const client = newClient(withTransport(subject.transport))
    const call = client.call(
      background(),
      {
        service: "orders",
        endpoint: "Get",
        message: { header: {}, body: new Uint8Array() }
      },
      withAddress("memory://orders")
    )
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
    const client = newClient(withTransport(subject.transport))
    const call = client.call(
      background(),
      {
        service: "orders",
        endpoint: "Get",
        message: { header: {}, body: new Uint8Array() }
      },
      withAddress("memory://orders")
    )
    void call.catch(() => {})
    await dialed.promise
    const closing = client.close(background())
    void closing.catch(() => {})
    admission.resolve(
      Object.freeze({
        async send(): Promise<void> {},
        async recv(): Promise<Message> {
          return { header: {}, body: new Uint8Array() }
        },
        async close(): Promise<void> {
          closes += 1
        },
        local(): string {
          return "client"
        },
        remote(): string {
          return "memory://orders"
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
    const client = newClient(withTransport(subject.transport))
    const call = client.call(
      background(),
      {
        service: "orders",
        endpoint: "Get",
        message: { header: {}, body: new Uint8Array() }
      },
      withAddress("memory://orders")
    )
    void call.catch(() => {})
    await dialed.promise
    const closing = client.close(background())
    void closing.catch(() => {})
    admission.resolve(
      Object.freeze({
        async send(): Promise<void> {},
        async recv(): Promise<Message> {
          return { header: {}, body: new Uint8Array() }
        },
        async close(): Promise<void> {
          throw cleanupFailure
        },
        local(): string {
          return "client"
        },
        remote(): string {
          return "memory://orders"
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    await client.call(
      background(),
      {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
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

  test("passes discovered opaque endpoints unchanged through Selector to Transport", async () => {
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
    Reflect.set(subject.transport, "kind", function kind(): string {
      return "http"
    })
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
    })
    await client.close(background())

    expect(selectedSnapshots).toHaveLength(1)
    expect(selectedSnapshots[0]).toBe(discovered)
    expect(subject.events).toContain("dial:not a transport URL")
    const info = transportFromClientContext(subject.dialContexts[0] ?? background())
    if (info === null) throw new Error("Transport did not receive TransportInfo")
    expect(info.kind()).toBe("http")
    expect(info.endpoint()).toBe("not a transport URL")
    expect(discovered[0]?.endpoints).toEqual([
      "not a transport URL",
      "grpc://orders",
      "https://orders.test/",
      "http://orders.test/"
    ])
  })

  test("fails with the stable selector error when call filters remove every instance", async () => {
    const subject = harness()
    const client = newClient(
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
          message: { header: {}, body: new Uint8Array() }
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
      onSend() {
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
        message: { header: {}, body: new Uint8Array([1]) }
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

    expect(response.body).toEqual(new Uint8Array([9, 8]))
    expect(sends).toBe(2)
    expect(selections).toBe(2)
    expect(subject.outcomes).toEqual([
      expectedSelectionOutcome(transient, false, false),
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
      onRecv(ctx) {
        if (transportFromClientContext(ctx)?.operation() === "orders/Get") {
          throw dependencyFailure
        }
      }
    })
    const client = newClient(
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
      message: { header: {}, body: new Uint8Array() }
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
        message: { header: {}, body: new Uint8Array() }
      })
    ).resolves.toMatchObject({ header: { node: "a" } })
    expect(subject.dialContexts).toHaveLength(dialsBeforeOpenCall + 1)
    await client.close(background())
  })

  test("observes explicit retries as one logical breaker call", async () => {
    const transient = new Error("transient send failure")
    let sends = 0
    const subject = harness({
      onSend() {
        sends += 1
        if (sends === 1) throw transient
      }
    })
    const client = newClient(
      withTransport(subject.transport),
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
      message: { header: {}, body: new Uint8Array() }
    }

    await client.call(
      background(),
      request,
      withAddress("memory://orders"),
      withRetry({
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: (_ctx, failure) => failure === transient
      })
    )
    await client.call(background(), request, withAddress("memory://orders"))

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
      message: { header: {}, body: new Uint8Array() }
    }

    const first = await rejected(client.call(background(), request))
    if (!(innerFailure instanceof Error))
      throw new Error("inner middleware did not observe failure")
    expect(first).toBe(innerFailure)
    completedCallFailure(first)
    const second = await rejected(client.call(background(), request))
    completedCallFailure(second)
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
      onSend() {
        sends += 1
        if (sends !== 1) return
        cancel(cancellation)
        throw dependencyFailure
      }
    })
    const client = newClient(
      withTransport(subject.transport),
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
      message: { header: {}, body: new Uint8Array() }
    }

    await expect(client.call(ctx, request, withAddress("memory://orders"))).rejects.toBe(canceled)
    expect(cause(ctx)).toBe(cancellation)
    await expect(
      client.call(background(), request, withAddress("memory://orders"))
    ).resolves.toMatchObject({ header: { node: "a" } })
    expect(sends).toBe(2)
    await client.close(background())
  })

  test("leaves missing operation identity to the existing call validation", async () => {
    const subject = harness()
    const client = newClient(
      withTransport(subject.transport),
      middleware(
        circuitBreakerMiddleware({
          failureThreshold: 1,
          resetTimeoutMs: 60_000
        })
      )
    )

    await expect(
      client.call(
        background(),
        {
          service: "",
          endpoint: "Get",
          message: { header: {}, body: new Uint8Array() }
        },
        withAddress("memory://orders")
      )
    ).rejects.toThrow("CallRequest.service must be a visible ASCII route token")
    expect(subject.events).toEqual([])
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
      onSend() {
        sends += 1
        throw transient
      }
    })
    const client = newClient(
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
          message: { header: {}, body: new Uint8Array() }
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
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport),
        closeTimeout(5)
      )
      const response = await client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })

      const failure = await rejected(within(client.close(background())))
      expect(response.body).toEqual(new Uint8Array([9, 8]))
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
      onSend() {
        sends += 1
        if (sends === 1) throw transient
      },
      onClose() {
        closes += 1
        if (closes === 1) return new Promise<void>(function neverSettles(): void {})
      }
    })
    const client = newClient(
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
        message: { header: {}, body: new Uint8Array() }
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

    expect(response.body).toEqual(new Uint8Array([9, 8]))
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      closeTimeout(0)
    )
    let settled = false
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      closeTimeout(0)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
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
        async send(): Promise<void> {},
        async recv(): Promise<Message> {
          return { header: {}, body: new Uint8Array([1]) }
        },
        close(): Promise<void> {
          if (expected.mode === "synchronous") throw expected.failure
          return Promise.reject(expected.failure)
        },
        local(): string {
          return "client"
        },
        remote(): string {
          return selectedEndpoint.url
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
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport),
        closeTimeout(expected.timeoutMs)
      )

      await client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
    })

    expect(failure instanceof Error).toBe(false)
    expect(await rejectedValue(client.close(background()))).toBe(failure)
  })

  test("validates every per-call option before service I/O", async () => {
    expect(() => withAddress("")).toThrow(TypeError)
    expect(() => withAddress("\ud800")).toThrow(TypeError)
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    for (const option of [
      null,
      () => null,
      () => ({ address: null, version: null, metadata: null, retry: null }),
      () => ({ address: null, version: null, metadata: new Date(), retry: null })
    ]) {
      await expect(
        Reflect.apply(client.call, client, [
          background(),
          {
            service: "orders",
            endpoint: "Create",
            message: { header: {}, body: new Uint8Array() }
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
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      expect(
        await rejected(
          client.call(background(), {
            service: "orders",
            endpoint: "Create",
            message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const rejected = await rejectedValue(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    )

    expect(failure instanceof Error).toBe(false)
    expect(rejected).toBe(failure)
  })

  test("preserves the primary Error and closes once without retry after send fails", async () => {
    const primary = new Error("send failed")
    const subject = harness({ mainFailure: { stage: "send", value: primary } })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    expect(
      await rejected(
        client.call(background(), {
          service: "orders",
          endpoint: "Create",
          message: { header: {}, body: new Uint8Array() }
        })
      )
    ).toBe(primary)
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "send",
      "done:error",
      "close"
    ])
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(primary, false, false)])
    expectBoundedClose(subject.closeContexts)
  })

  test("reports recv fulfillment before rejecting a malformed response snapshot", async () => {
    const subject = harness({
      response: { header: [] as never, body: new Uint8Array() }
    })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    )

    expect(failure).toBeInstanceOf(TypeError)
    expect(failure.message).toBe("message header must be a string record")
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(failure, true, true)])
    expectBoundedClose(subject.closeContexts)
  })

  test("preserves a Context cause while publishing neutral feedback and cleaning up", async () => {
    const cancellation = new Error("caller canceled")
    const [ctx, cancel] = withCancelCause(withValue(background(), "key", "value"))
    const subject = harness({
      mainFailure: { stage: "recv", value: cancellation },
      onRecv() {
        cancel(cancellation)
      }
    })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    expect(
      await rejected(
        client.call(ctx, {
          service: "orders",
          endpoint: "Create",
          message: { header: {}, body: new Uint8Array() }
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
      mainFailure: { stage: "recv", value: providerAbort },
      onRecv() {
        cancel(cancellation)
      }
    })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    expect(
      await rejected(
        client.call(ctx, {
          service: "orders",
          endpoint: "Create",
          message: { header: {}, body: new Uint8Array() }
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
    const envelope = encodeServiceError(
      "unary",
      serviceError("orders.unavailable", "service unavailable", 503)
    )
    const serviceSubject = harness({
      response: { header: envelope.header, body: envelope.body },
      onRecv() {
        cancelService(cancellation)
      }
    })
    const serviceClient = newClient(
      withDiscovery(serviceSubject.discovery),
      withSelector(serviceSubject.selector),
      withTransport(serviceSubject.transport)
    )
    const serviceFailure = await rejected(
      serviceClient.call(serviceContext, {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    )
    expect(serviceSubject.outcomes).toEqual([
      expectedSelectionOutcome(serviceFailure, true, true, envelope.header)
    ])

    const [statusContext, cancelStatus] = withCancelCause(background())
    const statusFailure = Object.assign(new Error("gateway unavailable"), { status: 504 })
    const statusSubject = harness({
      mainFailure: { stage: "recv", value: statusFailure },
      onRecv() {
        cancelStatus(cancellation)
      }
    })
    const statusClient = newClient(
      withDiscovery(statusSubject.discovery),
      withSelector(statusSubject.selector),
      withTransport(statusSubject.transport)
    )
    expect(
      await rejected(
        statusClient.call(statusContext, {
          service: "orders",
          endpoint: "Create",
          message: { header: {}, body: new Uint8Array() }
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
        mainFailure: { stage: "send", value: primary },
        onSend() {
          controlled[1]()
        }
      })
      const client = newClient(
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
          message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    expect(
      await rejected(
        client.call(ctx, {
          service: "orders",
          endpoint: "Create",
          message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    )
    const cleanup = completedCallFailure(failure)

    expect(cleanup.errors).toEqual([feedback])
    expect(completedResponse(cleanup).body).toEqual(new Uint8Array([9, 8]))
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(null, true, true, { node: "a" })])
    expect(subject.closeContexts).toEqual([])
    await client.close(background())
    expectBoundedClose(subject.closeContexts)
  })

  test("reports a resident transport close failure from Client close", async () => {
    const closeFailure = new Error("close failed")
    const subject = harness({ closeFailure })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
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
          async send(): Promise<void> {},
          async recv(): Promise<Message> {
            return { header: {}, body: new Uint8Array() }
          },
          async close(): Promise<void> {
            throw failure
          },
          local(): string {
            return "client"
          },
          remote(): string {
            return "memory://orders"
          }
        })
      }
    )
    const client = newClient(withTransport(subject.transport))
    const request: CallRequest = {
      service: "orders",
      endpoint: "Get",
      message: { header: {}, body: new Uint8Array() }
    }
    await client.call(background(), request, withAddress("memory://orders-a"))
    await client.call(background(), request, withAddress("memory://orders-b"))

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
      response: { header: responseHeader, body: responseBody }
    })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    )
    const cleanup = completedCallFailure(failure)

    responseHeader.node = "changed"
    responseBody[0] = 0
    const response = completedResponse(cleanup)
    const exposed = response.body
    exposed[1] = 0
    expect(response.header).toEqual({ node: "a" })
    expect(response.body).toEqual(new Uint8Array([9, 8]))
    expect(cleanup.errors).toEqual([feedback])
    expect(Object.isFrozen(cleanup)).toBeTrue()
    expect(Object.isFrozen(cleanup.errors)).toBeTrue()
  })

  test("never retries after the business exchange completed", async () => {
    const feedback = new Error("feedback failed")
    const subject = harness({ feedbackFailure: feedback })
    const client = newClient(
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
          message: { header: {}, body: new Uint8Array() }
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
    expect(subject.events.filter((event) => event === "send")).toHaveLength(1)
    expect(subject.events.filter((event) => event === "recv")).toHaveLength(1)
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(null, true, true, { node: "a" })])
  })

  test("preserves feedback facts when caller cancellation races a successful retry exchange", async () => {
    const feedbackFailure = new Error("feedback failed after response")
    const cancellation = new Error("caller canceled before feedback failure")
    const [ctx, cancel] = withCancelCause(background())
    const subject = harness({
      onRecv() {
        cancel(cancellation)
      },
      feedbackFailure
    })
    const client = newClient(
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
          message: { header: {}, body: new Uint8Array() }
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

    expect(completedResponse(cleanup).body).toEqual(new Uint8Array([9, 8]))
    expect(cleanup.errors).toEqual([feedbackFailure])
    expect(cause(ctx)).toBe(cancellation)
    expect(retryChecks).toBe(0)
    expect(backoffs).toBe(0)
    expect(subject.events.filter((event) => event === "recv")).toHaveLength(1)
    await client.close(background())
  })

  test("does not trust a structural cleanup lookalike when deciding retries", async () => {
    const feedback = new Error("lookalike feedback")
    const lookalike = new AggregateError(
      [feedback],
      "client exchange completed but cleanup failed; do not retry",
      { cause: { header: {}, body: new Uint8Array() } }
    )
    const subject = harness({ mainFailure: { stage: "send", value: lookalike } })
    const client = newClient(
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
          message: { header: {}, body: new Uint8Array() }
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
          withDiscovery(subject.discovery),
          withSelector(subject.selector),
          withTransport(subject.transport)
        )
        const feedbackFailure = await rejected(
          client.call(background(), {
            service: "orders",
            endpoint: "Create",
            message: { header: {}, body: new Uint8Array() }
          })
        )
        const cleanup = completedCallFailure(feedbackFailure)
        expect(completedResponse(cleanup).body).toEqual(new Uint8Array([9, 8]))
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
          mainFailure: { stage: "send", value: primary },
          onFeedback() {
            return current.create()
          }
        })
        const failedClient = newClient(
          withDiscovery(failedSubject.discovery),
          withSelector(failedSubject.selector),
          withTransport(failedSubject.transport)
        )
        const aggregate = await rejected(
          failedClient.call(background(), {
            service: "orders",
            endpoint: "Create",
            message: { header: {}, body: new Uint8Array() }
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
        options: { mainFailure: { stage: "send", value: primary }, feedbackFailure: feedback },
        expected: [primary, feedback]
      },
      {
        options: { mainFailure: { stage: "send", value: primary }, closeFailure: close },
        expected: [primary, close]
      }
    ] satisfies readonly {
      readonly options: HarnessOptions
      readonly expected: readonly Error[]
    }[]

    for (const current of cases) {
      const subject = harness(current.options)
      const client = newClient(
        withDiscovery(subject.discovery),
        withSelector(subject.selector),
        withTransport(subject.transport)
      )
      const failure = await rejected(
        client.call(background(), {
          service: "orders",
          endpoint: "Create",
          message: { header: {}, body: new Uint8Array() }
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
      mainFailure: { stage: "recv", value: primary },
      feedbackFailure: feedback,
      closeFailure: close
    })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )
    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([primary, feedback, close])
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(primary, true, false)])
    expect(subject.events.filter((event) => event.startsWith("done:"))).toHaveLength(1)
    expect(subject.events.filter((event) => event === "close")).toHaveLength(1)
  })

  test("decodes a canonical ServiceError without penalizing the selected endpoint", async () => {
    const envelope = encodeServiceError(
      "unary",
      serviceError("orders.denied", "request denied", 403, { tenant: "one" })
    )
    const subject = harness({ response: { header: envelope.header, body: envelope.body } })
    const client = newClient(
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
          message: { header: {}, body: new Uint8Array() }
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
    expect(subject.outcomes).toEqual([expectedSelectionOutcome(null, true, true, envelope.header)])
    expect(subject.events).toEqual([
      "discover:orders",
      "discover:orders",
      "select",
      "dial:http://127.0.0.1:8080/",
      "send",
      "recv",
      "done:ok",
      "close"
    ])
  })

  test("reports an unavailable ServiceError to selector health feedback", async () => {
    const envelope = encodeServiceError(
      "unary",
      serviceError("orders.unavailable", "service unavailable", 503)
    )
    const subject = harness({ response: { header: envelope.header, body: envelope.body } })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    )

    expect(isServiceError(failure)).toBe(true)
    expect(failure).toMatchObject({ code: "orders.unavailable", status: 503 })
    expect(subject.outcomes).toEqual([
      expectedSelectionOutcome(failure, true, true, envelope.header)
    ])
    expect(subject.events.filter((event) => event.startsWith("done:"))).toEqual(["done:error"])
  })

  test("reports malformed ServiceError wire as an exact selector protocol failure", async () => {
    const envelope = encodeServiceError(
      "unary",
      serviceError("orders.denied", "request denied", 403)
    )
    const malformed = envelope.body
    malformed[0] = 0
    const subject = harness({ response: { header: envelope.header, body: malformed } })
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport)
    )

    const failure = await rejected(
      client.call(background(), {
        service: "orders",
        endpoint: "Create",
        message: { header: {}, body: new Uint8Array() }
      })
    )

    expect(failure).toMatchObject({
      name: "TransportProtocolError",
      code: "GO_LIKE_TRANSPORT_PROTOCOL"
    })
    expect(subject.outcomes).toEqual([
      expectedSelectionOutcome(failure, true, true, envelope.header)
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
        expect(info.requestHeaders()).toEqual({
          "go-like-endpoint": ["Create"],
          "go-like-service": ["orders"]
        })
        expect(info.replyHeaders()).toEqual({ node: ["a"] })
        events.push(`${name}:after`)
        return response
      }
    }
    const client = newClient(
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      middleware(layer("a")),
      middleware(layer("b"))
    )

    await client.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
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
      "send",
      "recv",
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
        message: { header: {}, body: new Uint8Array() }
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
        discovery: options.discovery,
        selector: options.selector,
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: new Map([["orders/*", null]]),
        closeTimeoutMs: options.closeTimeoutMs
      }),
      (options: Parameters<ClientOption>[0]) => ({
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
          withDiscovery(subject.discovery),
          withTransport(subject.transport),
          invalid
        ])
      ).toThrow(TypeError)
    }

    const malformed = use("orders/*", () => null as never)
    expect(() =>
      newClient(withDiscovery(subject.discovery), withTransport(subject.transport), malformed)
    ).toThrow("Client middleware must return a Call function")
  })

  test("validates operation middleware selectors injected by custom ClientOption values", () => {
    const subject = harness()
    expect(() =>
      newClient(withDiscovery(subject.discovery), withTransport(subject.transport), (options) => ({
        discovery: options.discovery,
        selector: options.selector,
        transport: options.transport,
        middleware: options.middleware,
        operationMiddleware: new Map([["orders/", Object.freeze([])]]),
        closeTimeoutMs: options.closeTimeoutMs
      }))
    ).toThrow("client middleware selector must identify a canonical operation or trailing wildcard")
  })

  test("lets explicit middleware short-circuit or call the base more than once", async () => {
    const shortSubject = harness()
    const short = newClient(
      withDiscovery(shortSubject.discovery),
      withSelector(shortSubject.selector),
      withTransport(shortSubject.transport),
      middleware(() => async () => ({ header: { cached: "yes" }, body: new Uint8Array([1]) }))
    )
    const cached = await short.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
    })
    expect(cached.header).toEqual({ cached: "yes" })
    expect(shortSubject.events).toEqual([])

    const repeatedSubject = harness()
    const repeated = newClient(
      withDiscovery(repeatedSubject.discovery),
      withSelector(repeatedSubject.selector),
      withTransport(repeatedSubject.transport),
      middleware((next) => async (ctx, request) => {
        await next(ctx, request)
        return await next(ctx, request)
      })
    )
    await repeated.call(background(), {
      service: "orders",
      endpoint: "Create",
      message: { header: {}, body: new Uint8Array() }
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
      message: { header: {}, body: new Uint8Array() }
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      (options) => {
        defaults.value = options
        return options
      }
    )
    expect(defaults.value).toEqual({
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
      withDiscovery(subject.discovery),
      withSelector(subject.selector),
      withTransport(subject.transport),
      closeTimeout(25),
      poolSize(7),
      poolTtl(9),
      inspect
    )

    expect(captured.value).toEqual({
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
          withDiscovery(subject.discovery),
          withTransport(subject.transport),
          (options: Parameters<ClientOption>[0]) => ({
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
      withDiscovery(subject.discovery),
      withTransport(subject.transport),
      (options) => ({
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
})

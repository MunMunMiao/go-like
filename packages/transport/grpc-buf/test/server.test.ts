import { EventEmitter } from "node:events"
import type { AddressInfo } from "node:net"

import { expect, test } from "bun:test"
import { createConnectRouter, type Interceptor } from "@connectrpc/connect"
import { connectNodeAdapter, type ConnectNodeAdapterOptions } from "@connectrpc/connect-node"
import { background, canceled, withCancelCause, withTimeout, type Context } from "@go-like/context"
import { fromServerContext, newClientContext, newMetadata } from "@go-like/metadata"
import { fromServerContext as fromServerTransportContext, type TLSConfig } from "@go-like/transport"

import { OrderService } from "../.artifacts/gen/order/v1/order_pb.js"
import {
  newOrderServiceClient,
  registerOrderServiceHandler,
  type OrderServiceHandler
} from "../.artifacts/gen/order/v1/order_like.js"
import {
  address,
  advertise,
  clientAuth,
  newClient,
  newServer,
  tlsConfig,
  withAddress
} from "../src/native"
import { serverOptions } from "../src/options"
import {
  newServerForTest,
  type NativeHTTP2Server,
  type NativeHTTP2Session,
  type ServerFactories,
  type ServerTLSOptions
} from "../src/server"

const textEncoder = new TextEncoder()

function pem(label: string, body = "test"): NonNullable<TLSConfig["certificateChain"]> {
  return Object.freeze({
    encoding: "pem",
    bytes: textEncoder.encode(`-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`)
  })
}

function tls(overrides: Partial<TLSConfig> = {}): TLSConfig {
  return {
    serverName: null,
    caCertificate: null,
    certificateChain: pem("CERTIFICATE"),
    privateKey: pem("PRIVATE KEY"),
    ...overrides
  }
}

class FakeSession extends EventEmitter implements NativeHTTP2Session {
  closeCalls = 0
  destroyCalls = 0
  destroyReason: Error | undefined

  close(): void {
    this.closeCalls += 1
  }

  destroy(reason?: Error): void {
    this.destroyCalls += 1
    this.destroyReason = reason
    this.emit("close")
  }

  finish(): void {
    this.emit("close")
  }
}

class FakeNativeServer extends EventEmitter implements NativeHTTP2Server {
  listenCalls = 0
  closeCalls = 0
  listenOptions: { readonly host: string; readonly port: number } | null = null
  private bound: AddressInfo | string | null = null
  private closeCallback: ((error?: Error) => void) | null = null

  constructor(
    private readonly failures: { readonly listen?: unknown; readonly close?: unknown } = {}
  ) {
    super()
  }

  listen(options: { readonly host: string; readonly port: number }): this {
    this.listenCalls += 1
    this.listenOptions = options
    if (Object.hasOwn(this.failures, "listen")) throw this.failures.listen
    return this
  }

  address(): AddressInfo | string | null {
    return this.bound
  }

  close(callback: (error?: Error) => void): this {
    this.closeCalls += 1
    if (Object.hasOwn(this.failures, "close")) throw this.failures.close
    this.closeCallback = callback
    return this
  }

  emitListening(addressInfo: AddressInfo): void {
    this.bound = addressInfo
    this.emit("listening")
  }

  emitFailure(error: Error): void {
    this.emit("error", error)
  }

  admit(session: NativeHTTP2Session): void {
    this.emit("session", session)
  }

  finishClose(error?: Error): void {
    this.bound = null
    const callback = this.closeCallback
    this.closeCallback = null
    callback?.(error)
    this.emit("close")
  }
}

interface RuntimeCapture {
  readonly factories: ServerFactories
  readonly adapterOptions: ConnectNodeAdapterOptions[]
  readonly protocols: string[][]
  readonly tlsOptions: Array<ServerTLSOptions | null>
  readonly shutdownSignals: AbortSignal[]
  readonly requestHandlers: Array<ReturnType<typeof connectNodeAdapter>>
  readonly serverCreations: () => number
}

function runtime(
  native: FakeNativeServer,
  options: {
    readonly mutateAdapter?: boolean
    readonly officialAdapter?: boolean
    readonly createAdapterFailure?: unknown
    readonly createServerFailure?: unknown
  } = {}
): RuntimeCapture {
  const adapterOptions: ConnectNodeAdapterOptions[] = []
  const protocols: string[][] = []
  const tlsOptions: Array<ServerTLSOptions | null> = []
  const shutdownSignals: AbortSignal[] = []
  const requestHandlers: Array<ReturnType<typeof connectNodeAdapter>> = []
  let serverCreations = 0
  const factories: ServerFactories = {
    createAdapter(adapterCall) {
      adapterOptions.push(adapterCall)
      if (Object.hasOwn(options, "createAdapterFailure")) throw options.createAdapterFailure
      if (adapterCall.shutdownSignal !== undefined) {
        shutdownSignals.push(adapterCall.shutdownSignal)
      }
      if (options.mutateAdapter === true) adapterCall.acceptCompression = []
      if (options.officialAdapter === true) {
        const handler = connectNodeAdapter(adapterCall)
        requestHandlers.push(handler)
        return handler
      }
      const grpc = adapterCall.grpc
      const grpcWeb = adapterCall.grpcWeb
      const connect = adapterCall.connect
      if (grpc === undefined || grpcWeb === undefined || connect === undefined) {
        throw new TypeError("test adapter requires explicit protocol flags")
      }
      const router = createConnectRouter({
        grpc,
        grpcWeb,
        connect
      })
      adapterCall.routes(router)
      protocols.push(...router.handlers.map((handler) => [...handler.protocolNames]))
      const handler = (() => {}) as ReturnType<typeof connectNodeAdapter>
      requestHandlers.push(handler)
      return handler
    },
    createServer(serverTLS, handler) {
      serverCreations += 1
      if (Object.hasOwn(options, "createServerFailure")) throw options.createServerFailure
      tlsOptions.push(serverTLS)
      requestHandlers.push(handler)
      return native
    }
  }
  return {
    factories,
    adapterOptions,
    protocols,
    tlsOptions,
    shutdownSignals,
    requestHandlers,
    serverCreations: () => serverCreations
  }
}

const service = {
  getOrder(_ctx, request) {
    return { id: request.id, state: "READY" }
  },
  delete$(_ctx, request) {
    return { id: request.id, state: "DELETED" }
  },
  async *watchOrders(_ctx, request) {
    yield { orderId: request.customerId, type: "READY", sequence: 1 }
  },
  async uploadEvents(_ctx, request) {
    let accepted = 0
    for await (const _event of request) accepted += 1
    return { count: accepted }
  },
  async *syncOrders(_ctx, request) {
    for await (const command of request) {
      yield { orderId: command.orderId, type: command.action, sequence: 1 }
    }
  }
} satisfies OrderServiceHandler

function ipv4(address: string, port: number): AddressInfo {
  return { address, family: "IPv4", port }
}

async function observeSettlement(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  return settled
}

test("newServer defaults without native I/O and reports the grpc protocol", () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)

  expect(server.protocol()).toBe("grpc")
  expect(captured.adapterOptions).toHaveLength(0)
  expect(captured.serverCreations()).toBe(0)
  expect(native.listenCalls).toBe(0)
})

test("already-canceled first lifecycle callers seal without creating a native owner", async () => {
  for (const operation of ["endpoint", "start"] as const) {
    const native = new FakeNativeServer()
    const captured = runtime(native)
    const server = newServerForTest(captured.factories)
    registerOrderServiceHandler(server, service)
    const canceledContext = withCancelCause(background())
    canceledContext[1](canceled)

    const rejected = server[operation](canceledContext[0])
    const rejection = expect(rejected).rejects.toBe(canceled)

    expect(() => registerOrderServiceHandler(server, service)).toThrow("sealed")
    expect(captured.adapterOptions).toHaveLength(0)
    expect(captured.serverCreations()).toBe(0)
    expect(native.listenCalls).toBe(0)
    await rejection
    expect(captured.adapterOptions).toHaveLength(0)
    expect(captured.serverCreations()).toBe(0)
    expect(native.listenCalls).toBe(0)

    const admitted = server[operation](background())
    expect(native.listenCalls).toBe(1)
    native.emitListening(ipv4("127.0.0.1", operation === "endpoint" ? 43113 : 43114))
    if (operation === "endpoint") {
      await expect(admitted).resolves.toBe("http://127.0.0.1:43113/")
    }
    const stopped = server.stop(background())
    native.finishClose()
    await stopped
    if (operation === "start") await admitted
  }
})

test("a thrown first Context inspection is wrapped before native I/O", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const inspectionFailure = "broken Context.err"
  const inspected = {
    ...background(),
    err(): never {
      throw inspectionFailure
    }
  } satisfies Context

  const failure = await Promise.resolve(server.endpoint(inspected)).then(
    () => null,
    (error: unknown) => error
  )

  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error("expected a wrapped Context inspection Error")
  expect(failure.message).toBe("gRPC server Context inspection failed")
  expect(failure.cause).toBe(inspectionFailure)
  expect(captured.adapterOptions).toHaveLength(0)
  expect(captured.serverCreations()).toBe(0)
  expect(native.listenCalls).toBe(0)
})

test("generated registration serves a real standard-gRPC request and Context bridge", async () => {
  const observed: { context?: Context } = {}
  const cancellationEntered = Promise.withResolvers<void>()
  const cancellationObserved = Promise.withResolvers<void>()
  const implementation = {
    ...service,
    getOrder(ctx, request) {
      observed.context = ctx
      return { id: request.id, state: "NATIVE" }
    },
    async delete$(ctx, request) {
      observed.context = ctx
      cancellationEntered.resolve()
      const signal = ctx.done()
      if (signal === null) throw new Error("native handler requires cancellation")
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      cancellationObserved.resolve()
      return { id: request.id, state: "CANCELED" }
    }
  } satisfies OrderServiceHandler
  const server = newServer()
  registerOrderServiceHandler(server, implementation)
  const endpoint = await server.endpoint(background())
  const client = newClient(withAddress(endpoint))
  const orders = newOrderServiceClient(client)
  const metadataContext = newClientContext(
    background(),
    newMetadata({ "X-Native-Trace": "trace-7" })
  )
  const timed = withTimeout(metadataContext, 10_000)

  try {
    const reply = await orders.getOrder(timed[0], { id: "native-order" })
    const handlerContext = observed.context
    if (handlerContext === undefined) throw new Error("native handler Context was not observed")
    const metadata = fromServerContext(handlerContext)
    const transport = fromServerTransportContext(handlerContext)
    expect(reply.state).toBe("NATIVE")
    expect(metadata?.["x-native-trace"]).toEqual(["trace-7"])
    expect(handlerContext.deadline()[1]).toBe(true)
    expect(transport?.kind()).toBe("grpc")
    expect(endpoint.startsWith("http://")).toBe(true)

    const cancelContext = withCancelCause(background())
    const canceledCall = orders.delete$(cancelContext[0], { id: "cancel-order" })
    await cancellationEntered.promise
    cancelContext[1](canceled)
    await expect(canceledCall).rejects.toThrow()
    await cancellationObserved.promise
    expect(observed.context?.err()).toBe(canceled)
  } finally {
    timed[1]()
    await client.close(background())
    await server.stop(background())
  }
})

test("endpoint and start share one seal, adapter, native server, and bind", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)

  const endpoint = server.endpoint(background())
  const started = server.start(background())
  expect(native.listenCalls).toBe(1)
  expect(native.listenOptions).toEqual({ host: "127.0.0.1", port: 0 })
  expect(captured.adapterOptions).toHaveLength(1)
  expect(captured.serverCreations()).toBe(1)
  await expect(server.start(background())).rejects.toThrow("only be started once")

  native.emitListening(ipv4("127.0.0.1", 43101))
  await expect(endpoint).resolves.toBe("http://127.0.0.1:43101/")
  expect(await observeSettlement(started)).toBe(false)

  const stopped = server.stop(background())
  expect(native.closeCalls).toBe(1)
  native.finishClose()
  await stopped
  await started
})

test("empty, duplicate, and late registration seal before native I/O", async () => {
  const emptyNative = new FakeNativeServer()
  const emptyRuntime = runtime(emptyNative)
  const emptyServer = newServerForTest(emptyRuntime.factories)
  let firstFailure: unknown
  try {
    await emptyServer.endpoint(background())
  } catch (error) {
    firstFailure = error
  }
  expect(firstFailure).toBeInstanceOf(TypeError)
  await expect(emptyServer.endpoint(background())).rejects.toBe(firstFailure)
  expect(() => registerOrderServiceHandler(emptyServer, service)).toThrow("sealed")
  expect(emptyRuntime.adapterOptions).toHaveLength(0)
  expect(emptyRuntime.serverCreations()).toBe(0)
  expect(emptyNative.listenCalls).toBe(0)

  const duplicateNative = new FakeNativeServer()
  const duplicateRuntime = runtime(duplicateNative)
  const duplicateServer = newServerForTest(duplicateRuntime.factories)
  registerOrderServiceHandler(duplicateServer, service)
  expect(() => registerOrderServiceHandler(duplicateServer, service)).toThrow(
    "order.v1.OrderService"
  )
  expect(duplicateNative.listenCalls).toBe(0)

  const invalidNative = new FakeNativeServer()
  const invalidRuntime = runtime(invalidNative)
  const invalidServer = newServerForTest(invalidRuntime.factories)
  const nonStringDescriptor = { ...OrderService, typeName: 7 }
  expect(() =>
    Reflect.apply(invalidServer.service, invalidServer, [nonStringDescriptor, {}])
  ).toThrow("typeName")
  const emptyDescriptor = { ...OrderService, typeName: "" }
  expect(() => invalidServer.service(emptyDescriptor, {})).toThrow("typeName")
  expect(() => invalidServer.service(emptyDescriptor, {})).toThrow("typeName")
  registerOrderServiceHandler(invalidServer, service)
  expect(invalidRuntime.adapterOptions).toHaveLength(0)
  expect(invalidRuntime.serverCreations()).toBe(0)
  expect(invalidNative.listenCalls).toBe(0)

  const lateNative = new FakeNativeServer()
  const lateRuntime = runtime(lateNative)
  const lateServer = newServerForTest(lateRuntime.factories)
  registerOrderServiceHandler(lateServer, service)
  const pending = lateServer.endpoint(background())
  expect(() => lateServer.service(OrderService, {})).toThrow("sealed")
  lateNative.emitListening(ipv4("127.0.0.1", 43102))
  await pending
  const stopped = lateServer.stop(background())
  lateNative.finishClose()
  await stopped
})

test("pending and failed bind remain sealed and late cleanup is owned", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())
  expect(() => server.service(OrderService, {})).toThrow("sealed")

  const stopped = server.stop(background())
  expect(native.closeCalls).toBe(0)
  native.emitListening(ipv4("127.0.0.1", 43103))
  expect(native.closeCalls).toBe(1)
  native.finishClose()
  await stopped
  await endpoint

  const failedNative = new FakeNativeServer()
  const failedRuntime = runtime(failedNative)
  const failedServer = newServerForTest(failedRuntime.factories)
  registerOrderServiceHandler(failedServer, service)
  const failedEndpoint = failedServer.endpoint(background())
  const bindFailure = new Error("native bind failed")
  failedNative.emitFailure(bindFailure)
  await expect(failedEndpoint).rejects.toBe(bindFailure)
  expect(() => failedServer.service(OrderService, {})).toThrow("sealed")
  expect(failedNative.listenCalls).toBe(1)

  const failedStop = failedServer.stop(background())
  expect(failedNative.closeCalls).toBe(1)
  expect(await observeSettlement(failedStop)).toBe(false)
  failedNative.finishClose()
  await failedStop
})

test("stop owns native rollback when a pending bind later fails", async () => {
  for (const failure of [new Error("late bind error"), "invalid-address"] as const) {
    const native = new FakeNativeServer()
    const captured = runtime(native)
    const server = newServerForTest(captured.factories)
    registerOrderServiceHandler(server, service)
    const endpoint = server.endpoint(background())
    const stopped = server.stop(background())

    if (failure instanceof Error) native.emitFailure(failure)
    else Reflect.apply(native.emitListening, native, [failure])

    if (failure instanceof Error) await expect(endpoint).rejects.toBe(failure)
    else await expect(endpoint).rejects.toThrow("AddressInfo")
    expect(native.closeCalls).toBe(1)
    expect(await observeSettlement(stopped)).toBe(false)
    native.finishClose()
    await stopped
    expect(native.closeCalls).toBe(1)
  }
})

test("invalid listening address rolls back the created native owner exactly once", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())

  Reflect.apply(native.emitListening, native, ["not-an-address-info"])
  await expect(endpoint).rejects.toThrow("AddressInfo")
  expect(() => server.service(OrderService, {})).toThrow("sealed")

  const first = server.stop(background())
  const second = server.stop(background())
  expect(native.closeCalls).toBe(1)
  expect(await observeSettlement(first)).toBe(false)
  native.finishClose()
  await Promise.all([first, second])
  expect(native.closeCalls).toBe(1)
})

test("unpublishable assigned addresses roll back the native owner exactly once", async () => {
  const cases = [
    { bound: ipv4("127.0.0.1", 0), message: "assigned TCP port" },
    { bound: ipv4("0.0.0.0", 43116), message: "wildcard endpoint" }
  ] as const

  for (const scenario of cases) {
    const native = new FakeNativeServer()
    const captured = runtime(native)
    const server = newServerForTest(captured.factories)
    registerOrderServiceHandler(server, service)
    const endpoint = server.endpoint(background())

    native.emitListening(scenario.bound)

    await expect(endpoint).rejects.toThrow(scenario.message)
    expect(native.closeCalls).toBe(1)
    const stopped = server.stop(background())
    expect(await observeSettlement(stopped)).toBe(false)
    native.finishClose()
    await stopped
    expect(native.closeCalls).toBe(1)
  }
})

test("native close racing a pending bind settles start and owner cleanup", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const started = server.start(background())
  const stopped = server.stop(background())

  native.finishClose()

  expect(await observeSettlement(started)).toBe(true)
  expect(await observeSettlement(stopped)).toBe(true)
  await expect(started).rejects.toThrow("closed before listening")
  await stopped
})

test("an unexpected close of a bound owner rejects start and completes cleanup", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const started = server.start(background())
  native.emitListening(ipv4("127.0.0.1", 43117))

  native.finishClose()

  await expect(started).rejects.toThrow("closed unexpectedly")
  expect(captured.shutdownSignals[0]?.aborted).toBe(true)
  expect(captured.shutdownSignals[0]?.reason).toBeInstanceOf(Error)
  expect(native.closeCalls).toBe(0)
  await server.stop(background())
})

test("synchronous adapter and native owner construction failures are cached", async () => {
  const adapterFailure = new Error("adapter construction failed")
  const serverFailure = new Error("native owner construction failed")
  const cases = [
    {
      failure: adapterFailure,
      options: { createAdapterFailure: adapterFailure },
      serverCreations: 0
    },
    {
      failure: serverFailure,
      options: { createServerFailure: serverFailure },
      serverCreations: 1
    }
  ] as const

  for (const scenario of cases) {
    const native = new FakeNativeServer()
    const captured = runtime(native, scenario.options)
    const server = newServerForTest(captured.factories)
    registerOrderServiceHandler(server, service)

    const failure = await Promise.resolve(server.endpoint(background())).then(
      () => null,
      (error: unknown) => error
    )

    expect(failure).toBe(scenario.failure)
    await expect(server.endpoint(background())).rejects.toBe(failure)
    await server.stop(background())
    expect(captured.serverCreations()).toBe(scenario.serverCreations)
    expect(native.listenCalls).toBe(0)
    expect(native.closeCalls).toBe(0)
  }
})

test("a synchronous listen failure is wrapped and rolls back the native owner", async () => {
  const listenFailure = "native listen failed"
  const native = new FakeNativeServer({ listen: listenFailure })
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)

  const failure = await Promise.resolve(server.endpoint(background())).then(
    () => null,
    (error: unknown) => error
  )

  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error("expected a wrapped native listen Error")
  expect(failure.message).toBe("gRPC server listen failed")
  expect(failure.cause).toBe(listenFailure)
  expect(native.listenCalls).toBe(1)
  expect(native.closeCalls).toBe(1)
  const stopped = server.stop(background())
  native.finishClose()
  await stopped
})

test("stop before start seals without creating a native owner", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)

  await server.stop(background())
  const endpointFailure = await Promise.resolve(server.endpoint(background())).then(
    () => null,
    (error: unknown) => error
  )
  const startFailure = await server.start(background()).then(
    () => null,
    (error: unknown) => error
  )

  expect(endpointFailure).toBeInstanceOf(Error)
  expect(startFailure).toBe(endpointFailure)
  expect(captured.adapterOptions).toHaveLength(0)
  expect(captured.serverCreations()).toBe(0)
  expect(native.listenCalls).toBe(0)
  expect(native.closeCalls).toBe(0)
})

test("idempotent stop waits for one native close", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())
  native.emitListening(ipv4("127.0.0.1", 43104))
  await endpoint

  const first = server.stop(background())
  const second = server.stop(background())
  expect(native.closeCalls).toBe(1)
  expect(await observeSettlement(first)).toBe(false)
  expect(await observeSettlement(second)).toBe(false)
  native.finishClose()
  await Promise.all([first, second])
  await server.stop(background())
  expect(native.closeCalls).toBe(1)
})

test("a native close callback failure rejects cleanup and the start terminal", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const started = server.start(background())
  native.emitListening(ipv4("127.0.0.1", 43118))
  const closeFailure = new Error("native close callback failed")
  const stopped = server.stop(background())
  const stoppedOutcome = stopped.then(
    () => null,
    (error: unknown) => error
  )
  const startedOutcome = started.then(
    () => null,
    (error: unknown) => error
  )

  native.finishClose(closeFailure)

  expect(await observeSettlement(stoppedOutcome)).toBe(true)
  expect(await observeSettlement(startedOutcome)).toBe(true)
  expect(await stoppedOutcome).toBe(closeFailure)
  expect(await startedOutcome).toBe(closeFailure)
  await expect(server.stop(background())).rejects.toBe(closeFailure)
  expect(native.closeCalls).toBe(1)
})

test("a synchronous native close failure is wrapped and owns terminal cleanup", async () => {
  const closeFailure = "native close threw"
  const native = new FakeNativeServer({ close: closeFailure })
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const started = server.start(background())
  native.emitListening(ipv4("127.0.0.1", 43119))

  const failure = await server.stop(background()).then(
    () => null,
    (error: unknown) => error
  )

  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error("expected a wrapped native close Error")
  expect(failure.message).toBe("gRPC server close failed")
  expect(failure.cause).toBe(closeFailure)
  await expect(started).rejects.toBe(failure)
  expect(native.closeCalls).toBe(1)
})

test("a stop cleanup failure survives a second throwing Context inspection", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())
  native.emitListening(ipv4("127.0.0.1", 43120))
  await endpoint
  const inspectionFailure = new Error("second Context inspection failed")
  let inspections = 0
  const inspected = {
    ...background(),
    err(): null {
      inspections += 1
      if (inspections > 1) throw inspectionFailure
      return null
    }
  } satisfies Context
  const closeFailure = new Error("cleanup failed")
  const stopped = server.stop(inspected)

  native.finishClose(closeFailure)

  await expect(stopped).rejects.toBe(closeFailure)
  expect(inspections).toBe(2)
  expect(captured.shutdownSignals[0]?.aborted).toBe(false)
  expect(native.closeCalls).toBe(1)
})

test("a stopped bound owner rejects first start and later endpoint with one stable error", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const firstEndpoint = server.endpoint(background())
  native.emitListening(ipv4("127.0.0.1", 43115))
  await expect(firstEndpoint).resolves.toBe("http://127.0.0.1:43115/")
  const stopped = server.stop(background())
  native.finishClose()
  await stopped

  const [startFailure, endpointFailure] = await Promise.all([
    server.start(background()).then(
      () => null,
      (error: unknown) => error
    ),
    Promise.resolve(server.endpoint(background())).then(
      () => null,
      (error: unknown) => error
    )
  ])

  expect(startFailure).toBeInstanceOf(Error)
  expect(endpointFailure).toBe(startFailure)
  expect((startFailure as Error).message).toContain("stopped")
  expect(native.listenCalls).toBe(1)
})

test("TLS maps private PEM copies, publishes https, and validates client auth before I/O", async () => {
  const certificateBytes = textEncoder.encode(
    "-----BEGIN CERTIFICATE-----\nserver\n-----END CERTIFICATE-----"
  )
  const keyBytes = textEncoder.encode(
    "-----BEGIN PRIVATE KEY-----\nserver\n-----END PRIVATE KEY-----"
  )
  const caBytes = textEncoder.encode("-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----")
  const source: TLSConfig = {
    serverName: null,
    caCertificate: { encoding: "pem", bytes: caBytes },
    certificateChain: { encoding: "pem", bytes: certificateBytes },
    privateKey: { encoding: "pem", bytes: keyBytes }
  }
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories, tlsConfig(source), clientAuth("require"))
  certificateBytes.fill(0)
  keyBytes.fill(0)
  caBytes.fill(0)
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())
  native.emitListening(ipv4("127.0.0.1", 43105))

  await expect(endpoint).resolves.toBe("https://127.0.0.1:43105/")
  expect(captured.tlsOptions).toHaveLength(1)
  expect(captured.tlsOptions[0]?.cert.toString()).toContain("BEGIN CERTIFICATE")
  expect(captured.tlsOptions[0]?.key.toString()).toContain("BEGIN PRIVATE KEY")
  expect(captured.tlsOptions[0]?.ca?.toString()).toContain("BEGIN CERTIFICATE")
  expect(captured.tlsOptions[0]?.requestCert).toBe(true)
  expect(captured.tlsOptions[0]?.rejectUnauthorized).toBe(true)
  expect(captured.tlsOptions[0]?.allowHTTP1).toBe(false)
  const stopped = server.stop(background())
  native.finishClose()
  await stopped

  const invalidNative = new FakeNativeServer()
  const invalidRuntime = runtime(invalidNative)
  expect(() =>
    newServerForTest(invalidRuntime.factories, tlsConfig(tls({ certificateChain: null })))
  ).toThrow("certificate and private key")
  expect(() => newServerForTest(invalidRuntime.factories, clientAuth("require"))).toThrow("TLS")
  expect(() =>
    newServerForTest(invalidRuntime.factories, tlsConfig(tls()), clientAuth("require"))
  ).toThrow("CA")
  expect(invalidRuntime.adapterOptions).toHaveLength(0)
  expect(invalidRuntime.serverCreations()).toBe(0)
  expect(invalidNative.listenCalls).toBe(0)
})

test("server TLS rejects DER, serverName, missing identity, and h2c client auth before I/O", () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const der = { encoding: "der" as const, bytes: new Uint8Array([1, 2, 3]) }

  expect(() =>
    newServerForTest(captured.factories, tlsConfig(tls({ certificateChain: der, privateKey: der })))
  ).toThrow("PEM")
  expect(() =>
    newServerForTest(captured.factories, tlsConfig(tls({ serverName: "rpc.example.test" })))
  ).toThrow("serverName")
  expect(() =>
    newServerForTest(
      captured.factories,
      tlsConfig({
        serverName: null,
        caCertificate: pem("CERTIFICATE"),
        certificateChain: null,
        privateKey: null
      })
    )
  ).toThrow("certificate and private key")
  expect(() =>
    newServerForTest(captured.factories, tlsConfig(null), clientAuth("require"))
  ).toThrow("TLS")
  expect(captured.adapterOptions).toHaveLength(0)
  expect(captured.serverCreations()).toBe(0)
  expect(native.listenCalls).toBe(0)
})

test("wildcard bind requires advertise and host-only advertise keeps the ephemeral port", async () => {
  const invalidNative = new FakeNativeServer()
  const invalidRuntime = runtime(invalidNative)
  expect(serverOptions([advertise("orders.internal:9000")]).advertise).toBe("orders.internal:9000")
  for (const wildcard of ["0.0.0.0", "[::]"]) {
    expect(() => newServerForTest(invalidRuntime.factories, address(`${wildcard}:0`))).toThrow(
      "advertise"
    )
    expect(() =>
      newServerForTest(invalidRuntime.factories, address("127.0.0.1:0"), advertise(wildcard))
    ).toThrow("wildcard")
  }
  expect(() =>
    newServerForTest(invalidRuntime.factories, advertise("https://public.example.test"))
  ).toThrow("scheme")
  expect(() =>
    newServerForTest(
      invalidRuntime.factories,
      tlsConfig(tls()),
      advertise("http://public.example.test")
    )
  ).toThrow("scheme")
  expect(invalidNative.listenCalls).toBe(0)

  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(
    captured.factories,
    address("0.0.0.0:0"),
    advertise("public.example.test")
  )
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())
  expect(native.listenOptions).toEqual({ host: "0.0.0.0", port: 0 })
  native.emitListening(ipv4("0.0.0.0", 43106))
  await expect(endpoint).resolves.toBe("http://public.example.test:43106/")
  const stopped = server.stop(background())
  native.finishClose()
  await stopped

  const absoluteNative = new FakeNativeServer()
  const absoluteRuntime = runtime(absoluteNative)
  const absoluteServer = newServerForTest(
    absoluteRuntime.factories,
    advertise("http://public.example.test:8443")
  )
  registerOrderServiceHandler(absoluteServer, service)
  const absoluteEndpoint = absoluteServer.endpoint(background())
  absoluteNative.emitListening(ipv4("127.0.0.1", 43107))
  await expect(absoluteEndpoint).resolves.toBe("http://public.example.test:8443/")
  const absoluteStop = absoluteServer.stop(background())
  absoluteNative.finishClose()
  await absoluteStop
})

test("non-empty service options remain standard-gRPC only", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  const identity: Interceptor = (next) => (request) => next(request)
  server.service(OrderService, {}, { interceptors: [identity] })

  const endpoint = server.endpoint(background())
  expect(captured.adapterOptions).toHaveLength(1)
  expect(captured.adapterOptions[0]?.grpc).toBe(true)
  expect(captured.adapterOptions[0]?.grpcWeb).toBe(false)
  expect(captured.adapterOptions[0]?.connect).toBe(false)
  expect(captured.protocols).toHaveLength(Object.keys(OrderService.method).length)
  expect(captured.protocols.every((names) => names.length === 1 && names[0] === "grpc")).toBe(true)
  native.emitListening(ipv4("127.0.0.1", 43108))
  await endpoint
  const stopped = server.stop(background())
  native.finishClose()
  await stopped
})

test("deferred route replay snapshots service option properties at registration", async () => {
  let registeredInterceptorCalls = 0
  let laterInterceptorCalls = 0
  const registered: Interceptor = (next) => async (request) => {
    registeredInterceptorCalls += 1
    return next(request)
  }
  const later: Interceptor = (next) => async (request) => {
    laterInterceptorCalls += 1
    return next(request)
  }
  const serviceOptions = { interceptors: [registered] }
  const server = newServer()
  server.service(
    OrderService,
    {
      getOrder(request) {
        return { id: request.id, state: "SNAPSHOT" }
      }
    },
    serviceOptions
  )
  serviceOptions.interceptors = [later]
  const endpoint = await server.endpoint(background())
  const client = newClient(withAddress(endpoint))
  const orders = newOrderServiceClient(client)

  try {
    const reply = await orders.getOrder(background(), { id: "route-options" })
    expect(reply.state).toBe("SNAPSHOT")
    expect(registeredInterceptorCalls).toBe(1)
    expect(laterInterceptorCalls).toBe(0)
  } finally {
    await client.close(background())
    await server.stop(background())
  }
})

test("frozen public options stay unchanged while the official adapter mutates a fresh object", async () => {
  const snapshot = serverOptions([])
  const before = {
    address: snapshot.address,
    advertise: snapshot.advertise,
    clientAuth: snapshot.clientAuth,
    tlsConfig: snapshot.tlsConfig
  }
  expect(Object.isFrozen(snapshot)).toBe(true)

  const native = new FakeNativeServer()
  const captured = runtime(native, { officialAdapter: true })
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())

  expect(captured.adapterOptions).toHaveLength(1)
  expect(Object.isExtensible(captured.adapterOptions[0])).toBe(true)
  expect(captured.adapterOptions[0]?.acceptCompression?.length).toBeGreaterThan(0)
  expect({
    address: snapshot.address,
    advertise: snapshot.advertise,
    clientAuth: snapshot.clientAuth,
    tlsConfig: snapshot.tlsConfig
  }).toEqual(before)
  native.emitListening(ipv4("127.0.0.1", 43109))
  await endpoint
  const stopped = server.stop(background())
  native.finishClose()
  await stopped
})

test("graceful stop closes admission and sessions without aborting handlers", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())
  native.emitListening(ipv4("127.0.0.1", 43110))
  await endpoint
  const active = new FakeSession()
  native.admit(active)

  const stopped = server.stop(background())
  expect(native.closeCalls).toBe(1)
  expect(active.closeCalls).toBe(1)
  expect(active.destroyCalls).toBe(0)
  expect(captured.shutdownSignals[0]?.aborted).toBe(false)
  expect(await observeSettlement(stopped)).toBe(false)

  const late = new FakeSession()
  native.admit(late)
  expect(late.closeCalls).toBe(1)
  expect(late.destroyCalls).toBe(0)
  active.finish()
  late.finish()
  native.finishClose()
  await stopped
})

test("an expired stop waiter forces remaining sessions once while owner cleanup continues", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const endpoint = server.endpoint(background())
  native.emitListening(ipv4("127.0.0.1", 43111))
  await endpoint
  const active = new FakeSession()
  native.admit(active)
  const stopContext = withCancelCause(background())

  const bounded = server.stop(stopContext[0])
  expect(active.closeCalls).toBe(1)
  stopContext[1](canceled)
  await expect(bounded).rejects.toBe(canceled)
  expect(captured.shutdownSignals[0]?.aborted).toBe(true)
  expect(active.destroyCalls).toBe(1)
  expect(native.closeCalls).toBe(1)

  const joining = server.stop(background())
  expect(active.destroyCalls).toBe(1)
  native.finishClose()
  await joining
  expect(native.closeCalls).toBe(1)
})

test("a runtime error rejects start and force-terminates active sessions exactly once", async () => {
  const native = new FakeNativeServer()
  const captured = runtime(native)
  const server = newServerForTest(captured.factories)
  registerOrderServiceHandler(server, service)
  const started = server.start(background())
  native.emitListening(ipv4("127.0.0.1", 43112))
  await Promise.resolve()
  const active = new FakeSession()
  native.admit(active)
  const runtimeFailure = new Error("native server failed")

  native.emitFailure(runtimeFailure)

  await expect(started).rejects.toBe(runtimeFailure)
  expect(captured.shutdownSignals[0]?.aborted).toBe(true)
  expect(captured.shutdownSignals[0]?.reason).toBe(runtimeFailure)
  expect(native.closeCalls).toBe(1)
  expect(active.destroyCalls).toBe(1)
  expect(active.destroyReason).toBe(runtimeFailure)
  const stopped = server.stop(background())
  expect(active.destroyCalls).toBe(1)
  expect(await observeSettlement(stopped)).toBe(false)
  native.emitFailure(new Error("duplicate runtime failure"))
  expect(active.destroyCalls).toBe(1)
  native.finishClose()
  await stopped
  expect(active.destroyCalls).toBe(1)
})

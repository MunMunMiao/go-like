import { EventEmitter } from "node:events"
import type { AddressInfo } from "node:net"

import { expect, test } from "bun:test"
import {
  Code,
  ConnectError,
  createConnectRouter,
  createContextValues,
  type Transport,
  type UnaryResponse
} from "@connectrpc/connect"
import type { ConnectNodeAdapterOptions } from "@connectrpc/connect-node"
import { createTransport as createConnectProtocolTransport } from "@connectrpc/connect/protocol-connect"
import { createTransport as createGrpcProtocolTransport } from "@connectrpc/connect/protocol-grpc"
import { createTransport as createGrpcWebProtocolTransport } from "@connectrpc/connect/protocol-grpc-web"
import {
  createUniversalHandlerClient,
  universalClientResponseFromFetch,
  type UniversalClientFn,
  type UniversalClientRequest
} from "@connectrpc/connect/protocol"
import { background, canceled, type Context } from "@go-like/core/context"
import type { Selector } from "@go-like/core/registry"
import { spanFromContext } from "@go-like/core/trace"
import {
  AttributeKey,
  LogEvent,
  MetricName,
  SemconvValue,
  newTelemetry,
  withTelemetry
} from "@go-like/core/telemetry"
import { beginUnit, withRemoteSpanContext } from "@go-like/core/telemetry/provider"
import {
  newTelemetryRecorder,
  type RecordedSpan,
  type TelemetryRecorder
} from "@go-like/core/testing"

import { OrderService } from "../.artifacts/gen/order/v1/order_pb.js"
import {
  newOrderServiceClient,
  registerOrderServiceHandler,
  type OrderServiceClient,
  type OrderServiceHandler
} from "../.artifacts/gen/order/v1/order_like.js"
import { callOptions, newHandler, telemetryInterceptor } from "../src/index"
import { newClientForTest, type ClientFactories } from "../src/client"
import { address, withEndpoint, withSelector } from "../src/node"
import { newServerForTest, type NativeHTTP2Server } from "../src/server"
import { bindRequestContext } from "../../core/src/web/request-context"

const serviceType = "order.v1.OrderService"
const remoteTraceId = "22222222222222222222222222222222"
const remoteSpanId = "2222222222222222"
const staleTraceId = "11111111111111111111111111111111"
const staleSpanId = "1111111111111111"

const callerFaults = [
  [Code.InvalidArgument, "INVALID_ARGUMENT"],
  [Code.NotFound, "NOT_FOUND"],
  [Code.AlreadyExists, "ALREADY_EXISTS"],
  [Code.PermissionDenied, "PERMISSION_DENIED"],
  [Code.ResourceExhausted, "RESOURCE_EXHAUSTED"],
  [Code.FailedPrecondition, "FAILED_PRECONDITION"],
  [Code.Aborted, "ABORTED"],
  [Code.OutOfRange, "OUT_OF_RANGE"],
  [Code.Unauthenticated, "UNAUTHENTICATED"]
] as const

const serverFaults = [
  [Code.Unknown, "UNKNOWN"],
  [Code.DeadlineExceeded, "DEADLINE_EXCEEDED"],
  [Code.Unimplemented, "UNIMPLEMENTED"],
  [Code.Internal, "INTERNAL"],
  [Code.Unavailable, "UNAVAILABLE"],
  [Code.DataLoss, "DATA_LOSS"]
] as const

type Target = "connect" | "grpc-web" | "grpc"

/** Formats one W3C traceparent for a known remote span. */
function traceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`
}

/** Returns the one recorded span of this RPC method and its one duration sample. */
function serverUnit(recorder: TelemetryRecorder, method: string): RecordedSpan {
  const name = `${serviceType}/${method}`
  const found = recorder.spans().filter((span) => span.name === name)
  if (found.length !== 1) throw new Error(`${name} opened ${found.length} spans`)
  const span = found[0]
  if (span === undefined) throw new Error(`missing ${name}`)
  const samples = recorder.measurements().filter((item) => {
    return (
      item.descriptor.name === MetricName.rpcServerCallDuration &&
      item.attributes[AttributeKey.rpcMethod] === name
    )
  })
  if (samples.length !== 1) throw new Error(`${name} recorded ${samples.length} durations`)
  const logs = recorder.logs().filter((item) => item.record.event === LogEvent.rpcServerCompleted)
  if (logs.length !== 1) throw new Error(`${name} wrote ${logs.length} completion logs`)
  return span
}

/** Asserts the D18 server attributes shared by every completed rpc.server unit. */
function expectServerSpan(
  span: RecordedSpan,
  method: string,
  system: string,
  outcome: string,
  statusCode: string,
  spanStatus: "unset" | "error"
): void {
  expect(span.ended).toBe(true)
  expect(span.kind).toBe("server")
  expect(span.status).toBe(spanStatus)
  expect(span.name).toBe(`${serviceType}/${method}`)
  expect(span.attributes[AttributeKey.rpcSystemName]).toBe(system)
  expect(span.attributes[AttributeKey.rpcMethod]).toBe(`${serviceType}/${method}`)
  expect(span.attributes[AttributeKey.rpcStatusCode]).toBe(statusCode)
  expect(span.attributes[AttributeKey.outcome]).toBe(outcome)
}

/** Observing context whose current span must not leak into an empty carrier. */
function staleHost(recorder: TelemetryRecorder): Context {
  const base = withTelemetry(background(), recorder.telemetry)
  const stale = withRemoteSpanContext(base, {
    traceId: staleTraceId,
    spanId: staleSpanId,
    traceFlags: 1,
    traceState: "",
    isRemote: true
  })
  return beginUnit(stale, {
    kind: "job.enqueue",
    system: "memory",
    name: "hold",
    queue: "hold"
  }).ctx
}

/** Resolves when the handler signal aborts, and fails instead of hanging. */
async function untilAborted(ctx: Context): Promise<void> {
  const signal = ctx.done()
  if (signal === null) throw new Error("handler Context has no cancellation signal")
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("handler abort was not observed")), 1_000)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/** Client context whose only job is to abort the Connect call. */
function abortContext(controller: AbortController): Context {
  return Object.freeze({
    deadline: () => [new Date(-62_135_596_800_000), false] as const,
    done: () => controller.signal,
    err: () => (controller.signal.aborted ? canceled : null),
    value: () => null
  })
}

/** Successful portable handlers for every RPC shape. */
function readyService(): OrderServiceHandler {
  return {
    getOrder(_ctx, request) {
      return { id: request.id, state: "READY" }
    },
    delete$(_ctx, request) {
      return { id: request.id, state: "DELETED" }
    },
    async *watchOrders(_ctx, request) {
      yield { orderId: request.customerId, type: "READY", sequence: 1 }
      yield { orderId: request.customerId, type: "GONE", sequence: 2 }
    },
    async uploadEvents(_ctx, request) {
      let count = 0
      for await (const _event of request) count += 1
      return { count }
    },
    async *syncOrders(_ctx, request) {
      for await (const command of request) {
        yield { orderId: command.orderId, type: command.action, sequence: 1 }
      }
    }
  }
}

/** Handler that throws one error from every method. */
function failingService(error: unknown): OrderServiceHandler {
  const fail = (): never => {
    throw error
  }
  return {
    getOrder: fail,
    delete$: fail,
    watchOrders: fail,
    uploadEvents: fail,
    syncOrders: fail
  }
}

class FakeNativeServer extends EventEmitter implements NativeHTTP2Server {
  listen(options: { readonly host: string; readonly port: number }): this {
    void options
    return this
  }

  address(): AddressInfo | string | null {
    return this.bound
  }

  close(callback: (error?: Error) => void): this {
    this.closeCallback = callback
    return this
  }

  /** Publishes one bound address and completes the listen wait. */
  emitListening(info: AddressInfo): void {
    this.bound = info
    this.emit("listening")
  }

  /** Completes the Node close callback. */
  finishClose(): void {
    this.bound = null
    const callback = this.closeCallback
    this.closeCallback = null
    callback?.()
    this.emit("close")
  }

  private bound: AddressInfo | null = null
  private closeCallback: ((error?: Error) => void) | null = null
}

/** In-memory gRPC client over the routes and interceptors newServer installed. */
async function grpcClient(
  impl: OrderServiceHandler,
  host: Context
): Promise<{
  readonly client: OrderServiceClient
  readonly transport: Transport
  readonly stop: () => Promise<void>
}> {
  const native = new FakeNativeServer()
  let adapter: ConnectNodeAdapterOptions | undefined
  const server = newServerForTest(
    {
      createAdapter(options) {
        adapter = options
        return (() => undefined) as never
      },
      createServer() {
        return native
      }
    },
    address("127.0.0.1:0")
  )
  registerOrderServiceHandler(server, impl)
  const pending = server.endpoint(host)
  native.emitListening({ address: "127.0.0.1", family: "IPv4", port: 50051 })
  await pending
  if (adapter === undefined) throw new Error("gRPC server did not build an adapter")
  const router = createConnectRouter({
    ...(adapter.grpc === undefined ? {} : { grpc: adapter.grpc }),
    ...(adapter.grpcWeb === undefined ? {} : { grpcWeb: adapter.grpcWeb }),
    ...(adapter.connect === undefined ? {} : { connect: adapter.connect }),
    ...(adapter.interceptors === undefined ? {} : { interceptors: adapter.interceptors }),
    ...(adapter.shutdownSignal === undefined ? {} : { shutdownSignal: adapter.shutdownSignal })
  })
  adapter.routes(router)
  const transport = createGrpcProtocolTransport({
    httpClient: createUniversalHandlerClient(router.handlers),
    baseUrl: "https://grpc.invalid",
    useBinaryFormat: true,
    interceptors: [],
    acceptCompression: [],
    sendCompression: null,
    compressMinBytes: Number.MAX_SAFE_INTEGER,
    readMaxBytes: Number.MAX_SAFE_INTEGER,
    writeMaxBytes: Number.MAX_SAFE_INTEGER
  })
  return {
    client: newOrderServiceClient(transport),
    transport,
    stop: async () => {
      const stopping = server.stop(background())
      native.finishClose()
      await stopping
    }
  }
}

/** Reads one universal request body as a fetch stream. `duplex` lets Bun send it. */
function requestStream(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done === true) {
        controller.close()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel() {
      await iterator.return?.()
    }
  })
}

/** Universal client that calls `newHandler` and can carry a streaming request body. */
function handlerClient(
  handler: (request: Request) => Promise<Response>,
  host: Context,
  prepare?: (request: Request) => void
): UniversalClientFn {
  return async (request: UniversalClientRequest) => {
    const body = request.body === undefined ? null : requestStream(request.body)
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: request.header,
      body
    }
    if (request.signal !== undefined) init.signal = request.signal
    if (body !== null) init.duplex = "half"
    const fetchRequest = new Request(request.url, init)
    prepare?.(fetchRequest)
    bindRequestContext(fetchRequest, host)
    return universalClientResponseFromFetch(await handler(fetchRequest))
  }
}

/** Options shared by the in-memory Connect, gRPC-Web, and gRPC transports. */
function protocolOptions(httpClient: UniversalClientFn) {
  return {
    httpClient,
    baseUrl: "https://rpc.test",
    useBinaryFormat: true,
    interceptors: [],
    acceptCompression: [],
    sendCompression: null,
    compressMinBytes: Number.MAX_SAFE_INTEGER,
    readMaxBytes: Number.MAX_SAFE_INTEGER,
    writeMaxBytes: Number.MAX_SAFE_INTEGER
  }
}

/** Connect or gRPC-Web client whose Request carries the host Context. */
function webClient(
  impl: OrderServiceHandler,
  host: Context,
  protocol: "connect" | "grpc-web",
  prepare?: (request: Request) => void
): OrderServiceClient {
  const handler = newHandler((server) => registerOrderServiceHandler(server, impl))
  const httpClient = handlerClient(handler, host, prepare)
  const transport =
    protocol === "connect"
      ? createConnectProtocolTransport(protocolOptions(httpClient))
      : createGrpcWebProtocolTransport(protocolOptions(httpClient))
  return newOrderServiceClient(transport)
}

/** Runs one assertion against Connect, gRPC-Web, and the managed gRPC server. */
async function eachTarget(
  recorder: TelemetryRecorder,
  impl: OrderServiceHandler,
  targets: readonly Target[],
  check: (client: OrderServiceClient, system: string) => Promise<void>
): Promise<void> {
  const host = withTelemetry(background(), recorder.telemetry)
  for (const target of targets) {
    recorder.reset()
    if (target === "grpc") {
      const session = await grpcClient(impl, host)
      try {
        await check(session.client, "grpc")
      } finally {
        await session.stop()
      }
      continue
    }
    await check(webClient(impl, host, target), "connectrpc")
  }
}

test("newHandler and newServer record one rpc.server unit for every successful shape", async () => {
  const recorder = newTelemetryRecorder()
  await eachTarget(
    recorder,
    readyService(),
    ["connect", "grpc-web", "grpc"],
    async (client, system) => {
      recorder.reset()
      const order = await client.getOrder(background(), { id: "unary" })
      expect(order.id).toBe("unary")
      const unary = serverUnit(recorder, "GetOrder")
      expectServerSpan(unary, "GetOrder", system, SemconvValue.outcomeSuccess, "OK", "unset")
      expect(unary.attributes[AttributeKey.rpcStream]).toBe(false)
      expect(unary.root).toBe(true)
      expect(unary.parent).toBeNull()

      recorder.reset()
      const events = []
      for await (const event of client.watchOrders(background(), { customerId: "watch" })) {
        events.push(event.sequence)
      }
      expect(events).toEqual([1, 2])
      const watched = serverUnit(recorder, "WatchOrders")
      expectServerSpan(watched, "WatchOrders", system, SemconvValue.outcomeSuccess, "OK", "unset")
      expect(watched.attributes[AttributeKey.rpcStream]).toBe(true)
      expect(watched.attributes[AttributeKey.rpcStreamMessages]).toBe(2)
      expect(watched.attributes[AttributeKey.rpcStreamStatus]).toBe("success")
      expect(watched.attributes[AttributeKey.rpcStreamHandshakeMs]).toBe(0)
      expect(
        recorder.measurements().some((item) => {
          return (
            item.descriptor.name === MetricName.rpcStreamMessages &&
            item.value === 2 &&
            item.attributes[AttributeKey.rpcDirection] === SemconvValue.directionSent &&
            item.attributes[AttributeKey.rpcSystemName] === system
          )
        })
      ).toBe(true)

      recorder.reset()
      async function* uploads() {
        yield { orderId: "u1", type: "READY" }
        yield { orderId: "u2", type: "GONE" }
      }
      const uploaded = await client.uploadEvents(background(), uploads())
      expect(uploaded.count).toBe(2)
      const upload = serverUnit(recorder, "UploadEvents")
      expectServerSpan(upload, "UploadEvents", system, SemconvValue.outcomeSuccess, "OK", "unset")
      expect(upload.attributes[AttributeKey.rpcStream]).toBe(true)
      expect(upload.attributes[AttributeKey.rpcStreamStatus]).toBe("success")

      recorder.reset()
      async function* commands() {
        yield { orderId: "s1", action: "HOLD" }
      }
      const synced = []
      for await (const event of client.syncOrders(background(), commands())) synced.push(event.type)
      expect(synced).toEqual(["HOLD"])
      const sync = serverUnit(recorder, "SyncOrders")
      expectServerSpan(sync, "SyncOrders", system, SemconvValue.outcomeSuccess, "OK", "unset")
      expect(sync.attributes[AttributeKey.rpcStreamMessages]).toBe(1)
      expect(sync.attributes[AttributeKey.rpcStreamStatus]).toBe("success")
    }
  )
})

test("empty and malformed carriers do not keep a stale parent", async () => {
  const recorder = newTelemetryRecorder()
  const host = staleHost(recorder)
  const impl = readyService()
  const cases = [
    { label: "empty", carrier: null },
    { label: "malformed", carrier: "00-not-a-traceparent" },
    { label: "zero", carrier: "00-00000000000000000000000000000000-0000000000000000-01" }
  ] as const
  for (const item of cases) {
    recorder.reset()
    const client = webClient(impl, host, "connect", (request) => {
      if (item.carrier === null) request.headers.delete("traceparent")
      else request.headers.set("traceparent", item.carrier)
    })
    await client.getOrder(background(), { id: item.label })
    const connectSpan = serverUnit(recorder, "GetOrder")
    expect(connectSpan.root).toBe(true)
    expect(connectSpan.parent).toBeNull()
    expect(connectSpan.context.traceId).not.toBe(staleTraceId)

    recorder.reset()
    const session = await grpcClient(impl, host)
    try {
      const header = new Headers()
      if (item.carrier !== null) header.set("traceparent", item.carrier)
      await session.transport.unary(OrderService.method.getOrder, undefined, undefined, header, {
        id: item.label
      })
    } finally {
      await session.stop()
    }
    const grpcSpan = serverUnit(recorder, "GetOrder")
    expect(grpcSpan.root).toBe(true)
    expect(grpcSpan.parent).toBeNull()
    expect(grpcSpan.context.traceId).not.toBe(staleTraceId)
    expect(grpcSpan.attributes[AttributeKey.rpcSystemName]).toBe("grpc")
  }
})

test("a valid traceparent becomes the rpc.server parent", async () => {
  const recorder = newTelemetryRecorder()
  const host = staleHost(recorder)
  const parent = traceparent(remoteTraceId, remoteSpanId)
  const connectClient = webClient(readyService(), host, "connect", (request) => {
    request.headers.set("traceparent", parent)
  })
  recorder.reset()
  await connectClient.getOrder(background(), { id: "remote" })
  const connectSpan = serverUnit(recorder, "GetOrder")
  expect(connectSpan.root).toBe(false)
  expect(connectSpan.parent?.traceId).toBe(remoteTraceId)
  expect(connectSpan.parent?.spanId).toBe(remoteSpanId)
  expect(connectSpan.context.traceId).toBe(remoteTraceId)
  expect(connectSpan.attributes[AttributeKey.rpcSystemName]).toBe("connectrpc")

  recorder.reset()
  const session = await grpcClient(readyService(), host)
  try {
    await session.transport.unary(
      OrderService.method.getOrder,
      undefined,
      undefined,
      new Headers({ traceparent: parent }),
      { id: "remote-grpc" }
    )
  } finally {
    await session.stop()
  }
  const grpcSpan = serverUnit(recorder, "GetOrder")
  expect(grpcSpan.root).toBe(false)
  expect(grpcSpan.parent?.traceId).toBe(remoteTraceId)
  expect(grpcSpan.parent?.spanId).toBe(remoteSpanId)
  expect(grpcSpan.context.traceId).toBe(remoteTraceId)
  expect(grpcSpan.attributes[AttributeKey.rpcSystemName]).toBe("grpc")
})

test("the handler Context parents downstream calls", async () => {
  const recorder = newTelemetryRecorder()
  let injected = ""
  const impl: OrderServiceHandler = {
    ...readyService(),
    async getOrder(ctx, request) {
      const header = new Headers()
      const invoke = telemetryInterceptor()(async (req) => {
        injected = req.header.get("traceparent") ?? ""
        return {
          stream: false,
          header: new Headers(),
          trailer: new Headers(),
          message: {}
        } as unknown as UnaryResponse
      })
      const values = callOptions(ctx).contextValues
      if (values === undefined) throw new Error("callOptions must carry the handler Context")
      await invoke({
        stream: false,
        service: { typeName: serviceType },
        method: { name: "Downstream", methodKind: "unary" },
        requestMethod: "POST",
        url: "https://rpc.test/downstream",
        signal: new AbortController().signal,
        header,
        contextValues: values,
        message: {}
      } as Parameters<typeof invoke>[0])
      return { id: request.id, state: "READY" }
    }
  }
  await eachTarget(recorder, impl, ["connect", "grpc"], async (client) => {
    recorder.reset()
    injected = ""
    await client.getOrder(background(), { id: "child" })
    const server = serverUnit(recorder, "GetOrder")
    const child = recorder.spans().find((span) => span.name === `${serviceType}/Downstream`)
    if (child === undefined) throw new Error("downstream rpc.client span was not recorded")
    expect(child.parent?.spanId).toBe(server.context.spanId)
    expect(child.context.traceId).toBe(server.context.traceId)
    expect(child.kind).toBe("client")
    expect(injected.includes(child.context.spanId)).toBe(true)
  })
})

test("Connect server failures mirror rpcFailure caller and server faults", async () => {
  const recorder = newTelemetryRecorder()
  let thrown: unknown = null
  const impl = failingService(new Error("replaced"))
  const service: OrderServiceHandler = {
    ...impl,
    getOrder() {
      if (thrown === null) throw new Error("classification error was not armed")
      throw thrown
    }
  }
  await eachTarget(recorder, service, ["connect", "grpc"], async (client, system) => {
    for (const [code, statusCode] of callerFaults) {
      recorder.reset()
      thrown = new ConnectError("caller-secret", code)
      await client.getOrder(background(), { id: statusCode }).catch((error: unknown) => error)
      const span = serverUnit(recorder, "GetOrder")
      expectServerSpan(
        span,
        "GetOrder",
        system,
        SemconvValue.outcomeCallerFault,
        statusCode,
        "unset"
      )
      expect(span.attributes[AttributeKey.errorType]).toBeUndefined()
      const logged = recorder
        .logs()
        .find((item) => item.record.event === LogEvent.rpcServerCompleted)
      expect(logged?.record.level).toBe("info")
      expect(logged?.record.message.includes("caller-secret")).toBe(false)
    }
    for (const [code, statusCode] of serverFaults) {
      recorder.reset()
      thrown = new ConnectError("server-secret", code)
      await client.getOrder(background(), { id: statusCode }).catch((error: unknown) => error)
      const span = serverUnit(recorder, "GetOrder")
      expectServerSpan(span, "GetOrder", system, SemconvValue.outcomeFailure, statusCode, "error")
      expect(span.attributes[AttributeKey.errorType]).toBe("ConnectError")
      const logged = recorder
        .logs()
        .find((item) => item.record.event === LogEvent.rpcServerCompleted)
      expect(logged?.record.level).toBe("error")
      expect(logged?.record.message.includes("server-secret")).toBe(false)
    }
    recorder.reset()
    thrown = new Error("plain-secret")
    await client.getOrder(background(), { id: "plain" }).catch((error: unknown) => error)
    const plain = serverUnit(recorder, "GetOrder")
    expectServerSpan(plain, "GetOrder", system, SemconvValue.outcomeFailure, "UNKNOWN", "error")
    expect(plain.attributes[AttributeKey.errorType]).toBe("Error")
    const plainLog = recorder
      .logs()
      .find((item) => item.record.event === LogEvent.rpcServerCompleted)
    expect(plainLog?.record.message.includes("plain-secret")).toBe(false)
  })
})

test("handler errors complete every streaming shape once", async () => {
  const recorder = newTelemetryRecorder()
  const failure = new ConnectError("stream-secret", Code.Unavailable)
  const impl: OrderServiceHandler = {
    ...readyService(),
    getOrder() {
      throw failure
    },
    async *watchOrders() {
      yield { orderId: "watch", type: "READY", sequence: 1 }
      throw failure
    },
    async uploadEvents() {
      throw failure
    },
    async *syncOrders() {
      yield { orderId: "sync", type: "HOLD", sequence: 1 }
      throw failure
    }
  }
  await eachTarget(recorder, impl, ["connect", "grpc"], async (client, system) => {
    recorder.reset()
    const unaryError = await client
      .getOrder(background(), { id: "bad" })
      .catch((error: unknown) => error)
    expect(unaryError).toBeInstanceOf(ConnectError)
    const unary = serverUnit(recorder, "GetOrder")
    expectServerSpan(unary, "GetOrder", system, SemconvValue.outcomeFailure, "UNAVAILABLE", "error")
    expect(recorder.logs().some((item) => item.record.message.includes("stream-secret"))).toBe(
      false
    )

    recorder.reset()
    let watched = 0
    const watchError = await (async () => {
      try {
        for await (const _event of client.watchOrders(background(), { customerId: "watch" })) {
          watched += 1
        }
        return null
      } catch (error) {
        return error
      }
    })()
    // The in-memory gRPC client copies trailers when the response starts, so a later
    // stream error is visible on the server unit and on the Connect body, not as a gRPC throw.
    if (system === "connectrpc") {
      expect(watchError).toBeInstanceOf(ConnectError)
      if (!(watchError instanceof ConnectError)) throw new Error("missing watch failure")
      expect(watchError.code).toBe(Code.Unavailable)
    }
    expect(watched).toBe(1)
    const watch = serverUnit(recorder, "WatchOrders")
    expectServerSpan(
      watch,
      "WatchOrders",
      system,
      SemconvValue.outcomeFailure,
      "UNAVAILABLE",
      "error"
    )
    expect(watch.attributes[AttributeKey.rpcStreamMessages]).toBe(1)
    expect(watch.attributes[AttributeKey.rpcStreamStatus]).toBe("error")
    expect(watch.attributes[AttributeKey.rpcStreamHandshakeMs]).toBe(0)

    recorder.reset()
    const uploadError = await client
      .uploadEvents(background(), (async function* uploads() {})())
      .catch((error: unknown) => error)
    expect(uploadError).toBeInstanceOf(ConnectError)
    const upload = serverUnit(recorder, "UploadEvents")
    expectServerSpan(
      upload,
      "UploadEvents",
      system,
      SemconvValue.outcomeFailure,
      "UNAVAILABLE",
      "error"
    )
    expect(upload.attributes[AttributeKey.rpcStream]).toBe(true)

    recorder.reset()
    let synced = 0
    const syncError = await (async () => {
      try {
        for await (const _event of client.syncOrders(
          background(),
          (async function* commands() {
            yield { orderId: "sync", action: "HOLD" }
          })()
        )) {
          synced += 1
        }
        return null
      } catch (error) {
        return error
      }
    })()
    if (system === "connectrpc") {
      expect(syncError).toBeInstanceOf(ConnectError)
      if (!(syncError instanceof ConnectError)) throw new Error("missing sync failure")
      expect(syncError.code).toBe(Code.Unavailable)
    }
    expect(synced).toBe(1)
    const sync = serverUnit(recorder, "SyncOrders")
    expectServerSpan(
      sync,
      "SyncOrders",
      system,
      SemconvValue.outcomeFailure,
      "UNAVAILABLE",
      "error"
    )
    expect(sync.attributes[AttributeKey.rpcStreamMessages]).toBe(1)
    expect(sync.attributes[AttributeKey.rpcStreamStatus]).toBe("error")
  })
})

test("client abort completes every shape as canceled exactly once", async () => {
  const recorder = newTelemetryRecorder()
  let notifyEntered = (): void => {}
  const impl: OrderServiceHandler = {
    async getOrder(ctx, request) {
      notifyEntered()
      await untilAborted(ctx)
      return { id: request.id, state: "CANCELED" }
    },
    delete$(_ctx, request) {
      return { id: request.id, state: "DELETED" }
    },
    async *watchOrders(ctx, request) {
      notifyEntered()
      yield { orderId: request.customerId, type: "READY", sequence: 1 }
      await untilAborted(ctx)
    },
    async uploadEvents(ctx) {
      notifyEntered()
      await untilAborted(ctx)
      return { count: 0 }
    },
    async *syncOrders(ctx) {
      notifyEntered()
      yield { orderId: "sync", type: "HOLD", sequence: 1 }
      await untilAborted(ctx)
    }
  }
  await eachTarget(recorder, impl, ["connect", "grpc"], async (client, system) => {
    const shapes = ["GetOrder", "WatchOrders", "UploadEvents", "SyncOrders"] as const
    for (const shape of shapes) {
      recorder.reset()
      const controller = new AbortController()
      const ctx = abortContext(controller)
      const entered = new Promise<void>((resolve) => {
        notifyEntered = resolve
      })
      const finished = (async () => {
        if (shape === "GetOrder") return client.getOrder(ctx, { id: "abort" })
        if (shape === "WatchOrders") {
          const iterator = client.watchOrders(ctx, { customerId: "abort" })[Symbol.asyncIterator]()
          await iterator.next()
          controller.abort()
          await iterator.return?.()
          return undefined
        }
        if (shape === "UploadEvents") {
          return client.uploadEvents(
            ctx,
            (async function* uploads() {
              yield { orderId: "abort", type: "READY" }
            })()
          )
        }
        const iterator = client
          .syncOrders(
            ctx,
            (async function* commands() {
              yield { orderId: "abort", action: "HOLD" }
            })()
          )
          [Symbol.asyncIterator]()
        await iterator.next()
        controller.abort()
        await iterator.return?.()
        return undefined
      })()
      await Promise.race([
        entered,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${shape} did not enter`)), 1_000)
        )
      ])
      if (shape === "GetOrder" || shape === "UploadEvents") controller.abort()
      await finished.catch((error: unknown) => error)
      const span = serverUnit(recorder, shape)
      expectServerSpan(span, shape, system, SemconvValue.outcomeCanceled, "CANCELED", "unset")
      expect(span.attributes[AttributeKey.errorType]).toBe(SemconvValue.errorCanceled)
    }
  })
})

test("a thrown cancel and a broken stream are canceled once", async () => {
  const recorder = newTelemetryRecorder()
  const impl: OrderServiceHandler = {
    ...readyService(),
    getOrder() {
      throw new ConnectError("gone", Code.Canceled)
    },
    async *watchOrders(requestCtx, request) {
      yield { orderId: request.customerId, type: "READY", sequence: 1 }
      await untilAborted(requestCtx)
    }
  }
  await eachTarget(recorder, impl, ["connect", "grpc"], async (client, system) => {
    recorder.reset()
    await client.getOrder(background(), { id: "cancel" }).catch((error: unknown) => error)
    const unary = serverUnit(recorder, "GetOrder")
    expectServerSpan(unary, "GetOrder", system, SemconvValue.outcomeCanceled, "CANCELED", "unset")

    recorder.reset()
    const iterator = client
      .watchOrders(background(), { customerId: "break" })
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    await iterator.return?.()
    const watched = serverUnit(recorder, "WatchOrders")
    expectServerSpan(
      watched,
      "WatchOrders",
      system,
      SemconvValue.outcomeCanceled,
      "CANCELED",
      "unset"
    )
    expect(watched.attributes[AttributeKey.rpcStreamStatus]).toBe("canceled")
    expect(watched.attributes[AttributeKey.rpcStreamMessages]).toBe(1)
  })
})

test("an unknown path records no rpc.server unit", async () => {
  const recorder = newTelemetryRecorder()
  const handler = newHandler((server) => registerOrderServiceHandler(server, readyService()))
  const request = new Request("https://rpc.test/missing")
  bindRequestContext(request, withTelemetry(background(), recorder.telemetry))
  expect((await handler(request)).status).toBe(404)
  expect(recorder.spans()).toHaveLength(0)
})

function unaryReply(id: string) {
  return {
    stream: false as const,
    service: OrderService,
    method: OrderService.method.getOrder,
    header: new Headers(),
    trailer: new Headers(),
    message: { $typeName: "order.v1.Order" as const, id, state: "READY" }
  }
}

function clientRuntime(transport: Transport): ClientFactories {
  return {
    createManager(endpoint: string) {
      return {
        authority: endpoint,
        request: async () => {
          throw new Error("manager request is not used")
        },
        notifyResponseByteRead() {},
        abort() {}
      }
    },
    createTransport() {
      return transport
    }
  }
}

/** Applies telemetryInterceptor the way an application-built transport would. */
function withClientUnits(inner: Transport): Transport {
  return {
    unary(method, signal, timeoutMs, header, input, contextValues) {
      const invoke = telemetryInterceptor("grpc")(async (req) => {
        return inner.unary(method, req.signal, timeoutMs, req.header, input, req.contextValues)
      })
      return invoke({
        stream: false,
        service: method.parent,
        method,
        requestMethod: "POST",
        url: "https://grpc.invalid/unary",
        signal: signal ?? new AbortController().signal,
        header: new Headers(header),
        contextValues: contextValues ?? createContextValues(),
        message: input
      } as Parameters<typeof invoke>[0])
    },
    stream(method, signal, timeoutMs, header, input, contextValues) {
      const invoke = telemetryInterceptor("grpc")(async (req) => {
        return inner.stream(
          method,
          req.signal,
          timeoutMs,
          req.header,
          req.message as never,
          req.contextValues
        )
      })
      return invoke({
        stream: true,
        service: method.parent,
        method,
        requestMethod: "POST",
        url: "https://grpc.invalid/stream",
        signal: signal ?? new AbortController().signal,
        header: new Headers(header),
        contextValues: contextValues ?? createContextValues(),
        message: input
      } as Parameters<typeof invoke>[0])
    }
  } as Transport
}

test("newClient opens one grpc rpc.client unit and injects its traceparent", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  let injected = ""
  const transport = {
    unary: async (_method, _signal, _timeout, header) => {
      const headers = new Headers(header)
      injected = headers.get("traceparent") ?? ""
      return unaryReply("selected")
    },
    stream: async () => {
      throw new Error("unexpected stream")
    }
  } as Transport
  const client = newClientForTest(
    clientRuntime(transport),
    withEndpoint("https://rpc.example.test/")
  )
  const values = callOptions(ctx).contextValues
  const reply = await client.unary(
    OrderService.method.getOrder,
    undefined,
    undefined,
    new Headers({ traceparent: traceparent(staleTraceId, staleSpanId) }),
    { id: "one" },
    values
  )
  expect(reply.message.id).toBe("selected")
  const span = recorder.spans().find((item) => item.name === `${serviceType}/GetOrder`)
  if (span === undefined) throw new Error("rpc.client span was not recorded")
  expect(recorder.spans().filter((item) => item.name === span.name)).toHaveLength(1)
  expect(span.kind).toBe("client")
  expect(span.attributes[AttributeKey.rpcSystemName]).toBe(SemconvValue.rpcSystemGrpc)
  expect(span.attributes[AttributeKey.rpcMethod]).toBe(`${serviceType}/GetOrder`)
  expect(span.attributes[AttributeKey.rpcStatusCode]).toBe("OK")
  expect(span.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeSuccess)
  expect(injected.includes(span.context.spanId)).toBe(true)
  expect(injected.includes(staleSpanId)).toBe(false)
  expect(
    recorder.measurements().filter((item) => {
      return (
        item.descriptor.name === MetricName.rpcClientCallDuration &&
        item.attributes[AttributeKey.rpcMethod] === `${serviceType}/GetOrder`
      )
    })
  ).toHaveLength(1)
})

test("newClient propagates the caller traceparent when no tracer is installed", async () => {
  const ctx = withRemoteSpanContext(withTelemetry(background(), newTelemetry({})), {
    traceId: remoteTraceId,
    spanId: remoteSpanId,
    traceFlags: 1,
    traceState: "",
    isRemote: true
  })
  let injected = ""
  const transport = {
    unary: async (_method, _signal, _timeout, header) => {
      injected = new Headers(header).get("traceparent") ?? ""
      return unaryReply("remote")
    },
    stream: async () => {
      throw new Error("unexpected stream")
    }
  } as Transport
  const client = newClientForTest(
    clientRuntime(transport),
    withEndpoint("https://rpc.example.test/")
  )
  await client.unary(
    OrderService.method.getOrder,
    undefined,
    undefined,
    new Headers({ traceparent: traceparent(staleTraceId, staleSpanId), "x-request-id": "kept" }),
    { id: "one" },
    callOptions(ctx).contextValues
  )
  expect(injected).toBe(traceparent(remoteTraceId, remoteSpanId))
})

test("newClient does not open a second unit when the transport already has one", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  let selectorSpanId = ""
  const selector: Selector = {
    select(selectCtx, instances) {
      const active = spanFromContext(selectCtx)
      selectorSpanId = active.isRecording() ? active.spanContext().spanId : ""
      const instance = instances[0]
      const url = instance?.endpoints[0]
      if (instance === undefined || url === undefined) throw new Error("missing direct endpoint")
      return [{ instance, url }, () => {}]
    }
  }
  const inner = {
    unary: async () => unaryReply("once"),
    stream: async () => {
      throw new Error("unexpected stream")
    }
  } as Transport
  const client = newClientForTest(
    clientRuntime(withClientUnits(inner)),
    withEndpoint("https://rpc.example.test/"),
    withSelector(selector)
  )
  await client.unary(
    OrderService.method.getOrder,
    undefined,
    undefined,
    undefined,
    { id: "one" },
    callOptions(ctx).contextValues
  )
  const spans = recorder.spans().filter((span) => span.name === `${serviceType}/GetOrder`)
  expect(spans).toHaveLength(1)
  const span = spans[0]
  if (span === undefined) throw new Error("missing rpc.client span")
  expect(span.attributes[AttributeKey.rpcSystemName]).toBe("grpc")
  expect(selectorSpanId).toBe(span.context.spanId)
  expect(
    recorder
      .measurements()
      .filter((item) => item.descriptor.name === MetricName.rpcClientCallDuration)
  ).toHaveLength(1)
})

test("stacked telemetryInterceptor calls record one rpc.client unit", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const response = unaryReply("stacked") as unknown as UnaryResponse
  const inner = telemetryInterceptor("grpc")(async () => response)
  const outer = telemetryInterceptor("grpc")(inner)
  const values = callOptions(ctx).contextValues
  if (values === undefined) throw new Error("callOptions must carry contextValues")
  await outer({
    stream: false,
    service: { typeName: serviceType },
    method: { name: "GetOrder", methodKind: "unary" },
    requestMethod: "POST",
    url: "https://rpc.test/GetOrder",
    signal: new AbortController().signal,
    header: new Headers(),
    contextValues: values,
    message: {}
  } as Parameters<typeof outer>[0])
  expect(recorder.spans().filter((span) => span.name === `${serviceType}/GetOrder`)).toHaveLength(1)
})

test("newClient stream success, failure, and cancel complete one unit", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const values = callOptions(ctx).contextValues
  async function* messages(valuesToYield: readonly string[], failure: ConnectError | null) {
    for (const value of valuesToYield) yield value
    if (failure !== null) throw failure
  }
  const transport = {
    unary: async () => {
      throw new Error("unexpected unary")
    },
    stream: async () => {
      return {
        stream: true,
        service: OrderService,
        method: OrderService.method.watchOrders,
        header: new Headers(),
        trailer: new Headers(),
        message: messages(["ready", "gone"], null)
      }
    }
  } as Transport
  const client = newClientForTest(
    clientRuntime(transport),
    withEndpoint("https://rpc.example.test/")
  )
  const watched: string[] = []
  const streamed = (
    await client.stream(
      OrderService.method.watchOrders,
      undefined,
      undefined,
      undefined,
      (async function* empty() {})(),
      values
    )
  ).message as AsyncIterable<string>
  for await (const message of streamed) watched.push(message)
  expect(watched).toEqual(["ready", "gone"])
  const span = recorder.spans().find((item) => item.name === `${serviceType}/WatchOrders`)
  expect(span?.attributes[AttributeKey.rpcStatusCode]).toBe("OK")
  expect(span?.attributes[AttributeKey.rpcStreamMessages]).toBe(2)
  expect(
    recorder.spans().filter((item) => item.name === `${serviceType}/WatchOrders`)
  ).toHaveLength(1)

  recorder.reset()
  const failing = {
    unary: async () => {
      throw new Error("unexpected unary")
    },
    stream: async () => {
      return {
        stream: true,
        service: OrderService,
        method: OrderService.method.watchOrders,
        header: new Headers(),
        trailer: new Headers(),
        message: messages(["ready"], new ConnectError("stream-secret", Code.Unavailable))
      }
    }
  } as Transport
  const failingClient = newClientForTest(
    clientRuntime(failing),
    withEndpoint("https://rpc.example.test/")
  )
  const failed = await failingClient.stream(
    OrderService.method.watchOrders,
    undefined,
    undefined,
    undefined,
    (async function* empty() {})(),
    values
  )
  let thrown: unknown = null
  try {
    for await (const _message of failed.message) void _message
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ConnectError)
  const failedSpan = recorder.spans().find((item) => item.name === `${serviceType}/WatchOrders`)
  expect(failedSpan?.status).toBe("error")
  expect(failedSpan?.attributes[AttributeKey.rpcStatusCode]).toBe("UNAVAILABLE")
  expect(
    recorder.spans().filter((item) => item.name === `${serviceType}/WatchOrders`)
  ).toHaveLength(1)

  recorder.reset()
  const cancelClient = newClientForTest(
    clientRuntime(transport),
    withEndpoint("https://rpc.example.test/")
  )
  const canceledStream = await cancelClient.stream(
    OrderService.method.watchOrders,
    undefined,
    undefined,
    undefined,
    (async function* empty() {})(),
    values
  )
  const iterator = canceledStream.message[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return?.()
  const canceledSpan = recorder.spans().find((item) => item.name === `${serviceType}/WatchOrders`)
  expect(canceledSpan?.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeCanceled)
  expect(
    recorder.spans().filter((item) => item.name === `${serviceType}/WatchOrders`)
  ).toHaveLength(1)
})

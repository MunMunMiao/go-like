import { expect, test } from "bun:test"
import { background, canceled, type Context } from "@go-like/context"
import { createConnectTransport, createGrpcWebTransport } from "@connectrpc/connect-web"
import { Code, ConnectError } from "@connectrpc/connect"

import { OrderSchema } from "../.artifacts/gen/order/v1/order_pb.js"

import { newHandler } from "../src/index"
import {
  newOrderServiceClient,
  registerOrderServiceHandler,
  type OrderServiceHandler
} from "../.artifacts/gen/order/v1/order_like.js"

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
  async uploadEvents() {
    throw new Error("request streaming is outside the portable Fetch tests")
  },
  async *syncOrders() {
    yield* []
    throw new Error("bidi streaming is outside the portable Fetch tests")
  }
} satisfies OrderServiceHandler

type FetchHandler = (request: Request) => Promise<Response>

function fetchThrough(handler: FetchHandler): typeof fetch {
  const adapter = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    handler(new Request(input, init))
  return Object.assign(adapter, globalThis.fetch)
}

function connectClient(handler: FetchHandler) {
  return newOrderServiceClient(
    createConnectTransport({ baseUrl: "https://rpc.test", fetch: fetchThrough(handler) })
  )
}

function grpcWebClient(handler: FetchHandler) {
  return newOrderServiceClient(
    createGrpcWebTransport({ baseUrl: "https://rpc.test", fetch: fetchThrough(handler) })
  )
}

test("newHandler constructs routes once and returns 404 for an unknown pathname", async () => {
  let routeCalls = 0
  const handler = newHandler((server) => {
    routeCalls += 1
    registerOrderServiceHandler(server, service)
  })

  expect(routeCalls).toBe(1)
  expect((await handler(new Request("https://rpc.test/not-found"))).status).toBe(404)
  expect(routeCalls).toBe(1)
})

test("Connect unary and server-streaming decode generated protobuf shapes", async () => {
  const handler = newHandler((server) => registerOrderServiceHandler(server, service))
  const client = connectClient(handler)

  const order = await client.getOrder(background(), { id: "connect-order" })
  expect({ id: order.id, state: order.state, type: order.$typeName }).toEqual({
    id: "connect-order",
    state: "READY",
    type: "order.v1.Order"
  })

  const events = []
  for await (const event of client.watchOrders(background(), { customerId: "connect-customer" })) {
    events.push({
      orderId: event.orderId,
      type: event.type,
      sequence: event.sequence,
      messageType: event.$typeName
    })
  }
  expect(events).toEqual([
    {
      orderId: "connect-customer",
      type: "READY",
      sequence: 1,
      messageType: "order.v1.OrderEvent"
    }
  ])
})

test("gRPC-Web unary and server-streaming decode generated protobuf shapes", async () => {
  const handler = newHandler((server) => registerOrderServiceHandler(server, service))
  const client = grpcWebClient(handler)

  const order = await client.getOrder(background(), { id: "grpc-web-order" })
  expect({ id: order.id, state: order.state, type: order.$typeName }).toEqual({
    id: "grpc-web-order",
    state: "READY",
    type: "order.v1.Order"
  })

  const events = []
  for await (const event of client.watchOrders(background(), { customerId: "grpc-web-customer" })) {
    events.push({
      orderId: event.orderId,
      type: event.type,
      sequence: event.sequence,
      messageType: event.$typeName
    })
  }
  expect(events).toEqual([
    {
      orderId: "grpc-web-customer",
      type: "READY",
      sequence: 1,
      messageType: "order.v1.OrderEvent"
    }
  ])
})

test("an aborted Request signal reaches the generated handler Like Context", async () => {
  let enterHandler = () => {}
  const handlerEntered = new Promise<void>((resolve) => {
    enterHandler = resolve
  })
  const observed: { context?: Context; requestSignal?: AbortSignal } = {}
  const cancellationHandler = {
    ...service,
    async getOrder(ctx, request) {
      observed.context = ctx
      const signal = ctx.done()
      if (signal === null) throw new Error("request cancellation signal is missing")
      enterHandler()
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      return { id: request.id, state: "canceled" }
    }
  } satisfies OrderServiceHandler
  const handler = newHandler((server) => registerOrderServiceHandler(server, cancellationHandler))
  const controller = new AbortController()
  const cancellationFetch = fetchThrough((request) => {
    observed.requestSignal = request.signal
    return handler(request)
  })
  const client = newOrderServiceClient(
    createConnectTransport({
      baseUrl: "https://rpc.test",
      fetch: cancellationFetch
    })
  )
  const context: Context = Object.freeze({
    deadline: () => [new Date(-62_135_596_800_000), false] as const,
    done: () => controller.signal,
    err: () => (controller.signal.aborted ? canceled : null),
    value: () => null
  })

  const call = client.getOrder(context, { id: "cancel-order" })
  await handlerEntered
  controller.abort("client canceled")
  await call.catch(() => {})

  const businessContext = observed.context
  const requestSignal = observed.requestSignal
  if (businessContext === undefined || requestSignal === undefined) {
    throw new Error("request and business Context must both be observed")
  }
  expect(requestSignal.aborted).toBe(true)
  expect(businessContext.done()?.aborted).toBe(true)
  expect(businessContext.err()).toBe(canceled)
})

test("generated handlers preserve explicit business error codes and protobuf details", async () => {
  const handler = newHandler((server) =>
    registerOrderServiceHandler(server, {
      ...service,
      getOrder() {
        throw new ConnectError("order validation failed", Code.InvalidArgument, undefined, [
          { desc: OrderSchema, value: { id: "invalid-order", state: "REJECTED" } }
        ])
      },
      delete$() {
        throw new Error("unexpected handler failure")
      }
    })
  )
  for (const client of [connectClient(handler), grpcWebClient(handler)]) {
    const error = await client
      .getOrder(background(), { id: "invalid-order" })
      .catch((value: unknown) => value)
    expect(error).toBeInstanceOf(ConnectError)
    if (!(error instanceof ConnectError)) throw new Error("expected a Connect business error")
    expect(error.code).toBe(Code.InvalidArgument)
    expect(error.rawMessage).toBe("order validation failed")
    expect(error.findDetails(OrderSchema)).toEqual([
      { $typeName: "order.v1.Order", id: "invalid-order", state: "REJECTED" }
    ])
    await expect(client.delete$(background(), { id: "unexpected" })).rejects.toMatchObject({
      code: Code.Internal
    })
  }
})

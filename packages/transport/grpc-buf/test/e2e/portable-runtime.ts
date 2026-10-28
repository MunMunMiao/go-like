import { createConnectTransport, createGrpcWebTransport } from "@connectrpc/connect-web"
import { background } from "@go-like/context"
import { newHandler } from "@go-like/transport-grpc-buf"

import {
  newOrderServiceClient,
  registerOrderServiceHandler,
  type OrderServiceClient,
  type OrderServiceHandler
} from "../../.artifacts/gen/order/v1/order_like.js"

const runtime = "Bun" in globalThis ? "bun" : "Deno" in globalThis ? "deno" : "node"
const handlerEntries = { clientStreaming: 0, bidi: 0 }
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
    handlerEntries.clientStreaming += 1
    throw new Error("request streaming is outside the portable runtime lane")
  },
  async *syncOrders() {
    handlerEntries.bidi += 1
    yield* []
    throw new Error("bidi streaming is outside the portable runtime lane")
  }
} satisfies OrderServiceHandler
const handler = newHandler((server) => registerOrderServiceHandler(server, service))
const portableFetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    handler(new Request(input, init)),
  globalThis.fetch
)

async function exercise(client: OrderServiceClient) {
  const order = await client.getOrder(background(), { id: `${runtime}-order` })
  const events = []
  for await (const event of client.watchOrders(background(), {
    customerId: `${runtime}-customer`
  })) {
    events.push({
      orderId: event.orderId,
      type: event.type,
      sequence: event.sequence,
      messageType: event.$typeName
    })
  }
  const result = {
    unary: { id: order.id, state: order.state, messageType: order.$typeName },
    serverStreaming: events
  }
  const expected = JSON.stringify({
    unary: { id: `${runtime}-order`, state: "READY", messageType: "order.v1.Order" },
    serverStreaming: [
      {
        orderId: `${runtime}-customer`,
        type: "READY",
        sequence: 1,
        messageType: "order.v1.OrderEvent"
      }
    ]
  })
  if (JSON.stringify(result) !== expected)
    throw new Error(`${runtime} portable RPC result mismatch`)
  return result
}

async function* uploadEvents() {
  yield { orderId: `${runtime}-upload`, type: "CREATED" }
}

async function* syncCommands() {
  yield { orderId: `${runtime}-sync`, action: "CREATE" }
}

async function rejection(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error.message
    throw new Error(`${runtime} portable request-streaming rejection was not an Error`)
  }
  throw new Error(`${runtime} portable request-streaming call unexpectedly succeeded`)
}

async function boundaries(client: OrderServiceClient) {
  return {
    clientStreaming: await rejection(client.uploadEvents(background(), uploadEvents())),
    bidi: await rejection(
      client.syncOrders(background(), syncCommands())[Symbol.asyncIterator]().next()
    )
  }
}

const connectClient = newOrderServiceClient(
  createConnectTransport({ baseUrl: "https://rpc.test", fetch: portableFetch })
)
const grpcWebClient = newOrderServiceClient(
  createGrpcWebTransport({ baseUrl: "https://rpc.test", fetch: portableFetch })
)
const connect = await exercise(connectClient)
const grpcWeb = await exercise(grpcWebClient)
const requestStreaming = {
  connect: await boundaries(connectClient),
  grpcWeb: await boundaries(grpcWebClient),
  handlerEntries
}
if (handlerEntries.clientStreaming !== 0 || handlerEntries.bidi !== 0) {
  throw new Error(`${runtime} portable request-streaming reached the Fetch handler`)
}

console.log(JSON.stringify({ runtime, connect, grpcWeb, boundaries: requestStreaming }))

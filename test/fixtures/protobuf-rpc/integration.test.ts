import { expect, test } from "bun:test"
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect"
import { background, withTimeout } from "@go-like/context"
import { newClientContext, newMetadata } from "@go-like/metadata"

import {
  newOrderServiceClient,
  registerOrderServiceHandler
} from "./.artifacts/gen/order/v1/order_like.js"
import { handler } from "./handler.js"

const transport = createRouterTransport((server) => {
  registerOrderServiceHandler(server, handler)
})
const client = newOrderServiceClient(transport)

test("generated unary and reserved-name calls preserve ctx-first metadata and deadline", async () => {
  const startedAt = Date.now()
  const [ctx, cancel] = withTimeout(
    newClientContext(background(), newMetadata({ "x-like-metadata": "received" })),
    10_000
  )
  try {
    const order = await client.getOrder(ctx, { id: "order-1" })
    const [metadata, deadline, requestType] = order.state.split(":")
    expect({ id: order.id, metadata, requestType, type: order.$typeName }).toEqual({
      id: "order-1",
      metadata: "received",
      requestType: "order.v1.GetOrderRequest",
      type: "order.v1.Order"
    })
    expect(Number(deadline)).toBeGreaterThanOrEqual(startedAt + 9_000)
    expect(Number(deadline)).toBeLessThanOrEqual(Date.now() + 10_000)
  } finally {
    cancel()
  }

  const deleted = await client.delete$(background(), { id: "order-2" })
  expect({ id: deleted.id, state: deleted.state, type: deleted.$typeName }).toEqual({
    id: "order-2",
    state: "DELETED",
    type: "order.v1.Order"
  })
})

test("generated server-streaming exchanges concrete message shapes", async () => {
  const received = []
  for await (const event of client.watchOrders(background(), { customerId: "customer-1" })) {
    received.push({
      orderId: event.orderId,
      type: event.type,
      sequence: event.sequence,
      messageType: event.$typeName
    })
  }
  expect(received).toEqual([
    {
      orderId: "customer-1",
      type: "READY",
      sequence: 1,
      messageType: "order.v1.OrderEvent"
    }
  ])
})

test("generated client-streaming exchanges concrete message shapes", async () => {
  async function* events() {
    yield { orderId: "order-1", type: "READY" }
    yield { orderId: "order-2", type: "DELETED" }
  }

  const summary = await client.uploadEvents(background(), events())
  expect({ count: summary.count, type: summary.$typeName }).toEqual({
    count: 2,
    type: "order.v1.UploadSummary"
  })
})

test("generated bidi-streaming exchanges concrete message shapes", async () => {
  async function* commands() {
    yield { orderId: "order-1", action: "PACK" }
    yield { orderId: "order-2", action: "SHIP" }
  }

  const received = []
  for await (const event of client.syncOrders(background(), commands())) {
    received.push({
      orderId: event.orderId,
      type: event.type,
      sequence: event.sequence,
      messageType: event.$typeName
    })
  }
  expect(received).toEqual([
    {
      orderId: "order-1",
      type: "PACK",
      sequence: 1,
      messageType: "order.v1.OrderEvent"
    },
    {
      orderId: "order-2",
      type: "SHIP",
      sequence: 1,
      messageType: "order.v1.OrderEvent"
    }
  ])
})

test("thrown handler errors reject as internal ConnectError", async () => {
  const error = await client.getOrder(background(), { id: "throw" }).then(
    () => null,
    (error: unknown) => error
  )
  expect(error).toBeInstanceOf(ConnectError)
  expect(error).toHaveProperty("code", Code.Internal)
})

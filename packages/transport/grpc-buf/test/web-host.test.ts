import { expect, test } from "bun:test"
import { createConnectTransport } from "@connectrpc/connect-web"
import { background } from "@go-like/context"
import { name, newApp, registrar, server } from "@go-like/core"
import { newNodeServer } from "@go-like/web/node"

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
    throw new Error("request streaming is outside this Web host test")
  },
  async *syncOrders() {
    yield* []
    throw new Error("bidi streaming is outside this Web host test")
  }
} satisfies OrderServiceHandler

test("existing Web and Core lifecycle binds, serves RPC, and stops the endpoint", async () => {
  let publishEndpoint = (_endpoint: string) => {}
  const registeredEndpoint = new Promise<string>((resolve) => {
    publishEndpoint = resolve
  })
  const host = newNodeServer(newHandler((server) => registerOrderServiceHandler(server, service)))
  const app = newApp(
    name("orders"),
    server(host),
    registrar({
      async register(_ctx, instance) {
        const endpoint = instance.endpoints[0]
        if (endpoint === undefined) throw new Error("registered endpoint is missing")
        publishEndpoint(endpoint)
      },
      async deregister() {}
    })
  )
  const running = app.run()
  void running.catch(() => {})

  try {
    const endpoint = await Promise.race([
      registeredEndpoint,
      running.then(() => {
        throw new Error("application stopped before endpoint registration")
      })
    ])
    const url = new URL(endpoint)
    expect(url.protocol).toBe("http:")
    expect(Number(url.port)).toBeGreaterThan(0)

    const client = newOrderServiceClient(createConnectTransport({ baseUrl: endpoint }))
    const order = await client.getOrder(background(), { id: "host-order" })
    expect({ id: order.id, type: order.$typeName }).toEqual({
      id: "host-order",
      type: "order.v1.Order"
    })

    await app.stop()
    await running
    await expect(client.getOrder(background(), { id: "after-stop" })).rejects.toBeInstanceOf(Error)
  } finally {
    await app.stop()
    await running
  }
})

import { fromServerContext } from "@go-like/metadata"

import type { OrderServiceHandler } from "./.artifacts/gen/order/v1/order_like.js"

export const handler = {
  getOrder(ctx, req) {
    if (req.id === "throw") throw new Error("fixture handler failure")
    const metadata = fromServerContext(ctx)
    const [deadline, hasDeadline] = ctx.deadline()
    return {
      id: req.id,
      state: `${metadata?.["x-like-metadata"]?.[0] ?? "missing"}:${hasDeadline ? deadline.getTime() : "none"}:${req.$typeName}`
    }
  },
  delete$(_ctx, req) {
    if (req.$typeName !== "order.v1.GetOrderRequest")
      throw new Error("decoded Delete request expected")
    return { id: req.id, state: "DELETED" }
  },
  async *watchOrders(_ctx, req) {
    if (req.$typeName !== "order.v1.WatchOrdersRequest") {
      throw new Error("decoded WatchOrders request expected")
    }
    yield { orderId: req.customerId, type: "READY", sequence: 1 }
  },
  async uploadEvents(_ctx, requests) {
    let count = 0
    for await (const request of requests) {
      if (request.$typeName !== "order.v1.UploadEvent" || !request.orderId || !request.type) {
        throw new Error("decoded UploadEvents request expected")
      }
      count += 1
    }
    return { count }
  },
  async *syncOrders(_ctx, requests) {
    for await (const request of requests) {
      if (request.$typeName !== "order.v1.OrderCommand") {
        throw new Error("decoded SyncOrders request expected")
      }
      yield { orderId: request.orderId, type: request.action, sequence: 1 }
    }
  }
} satisfies OrderServiceHandler

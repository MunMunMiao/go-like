import type { Context } from "@go-like/context"
import { withRetry, type Client } from "@go-like/client"
import type { Server } from "@go-like/server"
import { struct } from "@go-like/struct"
import { defineService, type ServiceClient, type ServiceHandler } from "@go-like/transport"

const amount = struct.object({
  amount: struct.number(),
  currency: struct.string(),
  memo: struct.string().optional()
})
const paid = struct.object({ id: struct.string() })
const channels = struct.object({ channels: struct.array(struct.string()) })
const event = struct.object({ type: struct.string() })
const payment = defineService("payment.v1", {
  pay: { request: amount, response: paid },
  listChannels: { response: channels },
  watch: { request: paid, response: event, stream: true }
})

declare const ctx: Context
declare const hs: Server
declare const conn: Client

const handler: ServiceHandler<typeof payment> = {
  async pay(_ctx, req) {
    const memo: string | undefined = req.memo
    return { id: `${req.currency}:${req.amount}:${memo ?? ""}` }
  },
  async listChannels(_ctx) {
    return { channels: ["card"] }
  },
  async *watch(_ctx, req) {
    yield { type: req.id }
  }
}

payment.registerHandler(hs, handler)

const proxy: ServiceClient<typeof payment> = payment.newClient(conn)
const retry = withRetry({
  authorization: "idempotent",
  maxAttempts: 2,
  shouldRetry: () => false
})
const response: Promise<{ id: string }> = proxy.pay(ctx, { amount: 100, currency: "USD" }, retry)
const listed: Promise<{ channels: string[] }> = proxy.listChannels(ctx, retry)
const raw: Promise<{ id: string }> = conn.call(ctx, payment.endpoints.pay, {
  amount: 1,
  currency: "USD"
})
const rawChannels: Promise<{ channels: string[] }> = conn.call(
  ctx,
  payment.endpoints.listChannels,
  {}
)

void [handler, response, listed, raw, rawChannels]

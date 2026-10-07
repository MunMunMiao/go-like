import { expect, test } from "bun:test"

import type { Client } from "@go-like/client"
import { background, type Context } from "@go-like/context"
import { newMetadata } from "@go-like/metadata"
import { struct, type Infer, type Struct } from "@go-like/struct"
import {
  applyResponseObservers,
  endpoint,
  newServerContext,
  type Endpoint,
  type ServerStream,
  type TransportInfo
} from "@go-like/transport"
import { Registry } from "prom-client"

import {
  measureClient,
  measureUnaryMiddleware,
  measureWebHandler,
  newRequestMetrics
} from "../src/index"

const Item = struct.object({ n: struct.number() })
const watch = endpoint("orders", "watch", Item, Item, true)
const encoder = new TextEncoder()
const payload = encoder.encode(':\n\ndata: {"n":1}\n\nevent: end\ndata: {}\n\n')

/** Builds TransportInfo whose operation is independent of request headers. */
function transportInfo(operation: string): TransportInfo {
  const headers = newMetadata()
  return {
    kind: () => "http",
    endpoint: () => "",
    operation: () => operation,
    requestHeaders: () => headers,
    replyHeaders: () => headers,
    peerIdentity: () => null
  }
}

/** Returns one unread SSE response. */
function eventResponse(): Response {
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })
}

/** Reads the wrapped body only when the caller iterates. */
function streamingClient(): Client {
  return {
    async call(): Promise<Response> {
      return new Response(null, { status: 204 })
    },
    async stream<Request extends Struct, ResponseSchema extends Struct>(
      ctx: Context,
      _endpoint: Endpoint<Request, ResponseSchema, true>,
      _request: Infer<Request>
    ): Promise<ServerStream<Infer<ResponseSchema>>> {
      const response = applyResponseObservers(ctx, eventResponse())
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error("missing body")
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<Infer<ResponseSchema>> {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) return
            yield { n: 1 } as Infer<ResponseSchema>
          }
        },
        async close(): Promise<void> {
          await reader.cancel()
        },
        async [Symbol.asyncDispose](): Promise<void> {
          await reader.cancel()
        }
      }
    },
    async close(): Promise<void> {}
  }
}

test("records client and server stream metrics when the body ends", async () => {
  const registry = new Registry()
  const metrics = newRequestMetrics(registry)
  const client = measureClient(streamingClient(), metrics)
  const events = await client.stream(background(), watch, { n: 1 })
  expect(await registry.metrics()).not.toContain("orders/watch")
  const values: number[] = []
  for await (const event of events) values.push(event.n)
  expect(values).toEqual([1])
  const received = await registry.metrics()
  expect(received).toContain(
    'go_like_requests_total{component="client",operation="orders/watch",outcome="success"} 1'
  )
  expect(received).toContain(
    'go_like_stream_messages_total{component="client",operation="orders/watch",direction="received"} 1'
  )

  const middleware = measureUnaryMiddleware(metrics)
  const handler = middleware(async () => eventResponse())
  const response = await handler(
    newServerContext(background(), transportInfo("orders/watch")),
    new Request("http://127.0.0.1/orders/watch", { method: "POST" })
  )
  const beforeSend = await registry.metrics()
  expect(beforeSend).not.toContain('component="server",operation="orders/watch"')
  expect(await response.text()).toContain("event: end")
  const sent = await registry.metrics()
  expect(sent).toContain(
    'go_like_requests_total{component="server",operation="orders/watch",outcome="success"} 1'
  )
  expect(sent).toContain(
    'go_like_stream_messages_total{component="server",operation="orders/watch",direction="sent"} 1'
  )
})

test("records a failed web event stream when the terminal event is an error", async () => {
  const registry = new Registry()
  const metrics = newRequestMetrics(registry)
  const handler = measureWebHandler(
    () =>
      new Response(
        encoder.encode(
          'event: error\ndata: {"code":"internal","message":"nope","status":500,"metadata":{}}\n\n'
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      ),
    metrics
  )
  const response = await handler(new Request("http://127.0.0.1/orders/watch"))
  expect(await response.text()).toContain("event: error")
  expect(await registry.metrics()).toContain('outcome="failure"')
})

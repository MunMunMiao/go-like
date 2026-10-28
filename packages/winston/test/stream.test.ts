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
import type { Logger } from "winston"

import { logClient, logUnaryMiddleware } from "../src/index"

const Item = struct.object({ n: struct.number() })
const watch = endpoint("orders", "watch", Item, Item, true)
const payload = new TextEncoder().encode(':\n\ndata: {"n":1}\n\nevent: end\ndata: {}\n\n')

interface LogEntry {
  readonly level: "info" | "error"
  readonly message: string
  readonly fields: Readonly<Record<string, unknown>>
}

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

/** Captures Winston's message-then-fields call order. */
class CaptureLogger {
  readonly entries: LogEntry[] = []

  info(message: string, fields: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: "info", message, fields })
  }

  error(message: string, fields: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: "error", message, fields })
  }

  official(): Logger {
    return this as unknown as Logger
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

test("logs one client and server stream record when the body ends", async () => {
  const captured = new CaptureLogger()
  const client = logClient(streamingClient(), captured.official())
  const events = await client.stream(background(), watch, { n: 1 })
  expect(captured.entries).toHaveLength(0)
  const values: number[] = []
  for await (const event of events) values.push(event.n)
  expect(values).toEqual([1])
  expect(captured.entries).toHaveLength(1)
  expect(captured.entries[0]?.message).toBe("go-like operation completed")
  expect(captured.entries[0]?.fields).toMatchObject({
    component: "client",
    operation: "orders/watch",
    outcome: "success",
    messageCount: 1,
    streamStatus: "success"
  })

  const middleware = logUnaryMiddleware(captured.official())
  const handler = middleware(async () => eventResponse())
  const response = await handler(
    newServerContext(background(), transportInfo("orders/watch")),
    new Request("http://127.0.0.1/orders/watch", { method: "POST" })
  )
  expect(captured.entries).toHaveLength(1)
  expect(await response.text()).toContain("event: end")
  expect(captured.entries).toHaveLength(2)
  expect(captured.entries[1]?.fields).toMatchObject({
    component: "server",
    operation: "orders/watch",
    outcome: "success",
    messageCount: 1,
    streamStatus: "success"
  })
})

test("logs a non-Response server result when the handler returns", async () => {
  const captured = new CaptureLogger()
  const handler = logUnaryMiddleware(captured.official())(
    async () => "plain" as unknown as Response
  )
  const result: unknown = await handler(
    newServerContext(background(), transportInfo("orders/watch")),
    new Request("http://127.0.0.1/orders/watch", { method: "POST" })
  )
  expect(result).toBe("plain")
  expect(captured.entries).toHaveLength(1)
  expect(captured.entries[0]?.fields).toMatchObject({
    component: "server",
    operation: "orders/watch",
    outcome: "success"
  })
})

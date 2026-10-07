import { expect, test } from "bun:test"

import type { CallOption, CallRequest, Client } from "@go-like/client"
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
import type { Logger } from "pino"

import { logClient, logUnaryMiddleware } from "../src/index"

const Item = struct.object({ n: struct.number() })
const watch = endpoint("orders", "watch", Item, Item, true)
const payload = new TextEncoder().encode(':\n\ndata: {"n":1}\n\nevent: end\ndata: {}\n\n')

interface LoggedRecord {
  readonly level: "info" | "error"
  readonly fields: Readonly<Record<string, unknown>>
  readonly message: string
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

/** Captures one completion record per native logger call. */
function capturedLogger(): { logger: Logger; records: LoggedRecord[] } {
  const records: LoggedRecord[] = []
  const native = {
    info(fields: Readonly<Record<string, unknown>>, message: string): void {
      records.push({ level: "info", fields, message })
    },
    error(fields: Readonly<Record<string, unknown>>, message: string): void {
      records.push({ level: "error", fields, message })
    }
  }
  return { logger: native as unknown as Logger, records }
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
    async call(
      _ctx: Context,
      _request: CallRequest,
      ..._options: readonly CallOption[]
    ): Promise<Response> {
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
  } as unknown as Client
}

test("logs one client and server stream record when the body ends", async () => {
  const captured = capturedLogger()
  const client = logClient(streamingClient(), captured.logger)
  const events = await client.stream(background(), watch, { n: 1 })
  expect(captured.records).toHaveLength(0)
  const values: number[] = []
  for await (const event of events) values.push(event.n)
  expect(values).toEqual([1])
  expect(captured.records).toHaveLength(1)
  expect(captured.records[0]?.message).toBe("go-like operation completed")
  expect(captured.records[0]?.fields).toMatchObject({
    component: "client",
    operation: "orders/watch",
    outcome: "success",
    messageCount: 1,
    streamStatus: "success"
  })

  const middleware = logUnaryMiddleware(captured.logger)
  const handler = middleware(async () => eventResponse())
  const response = await handler(
    newServerContext(background(), transportInfo("orders/watch")),
    new Request("http://127.0.0.1/orders/watch", { method: "POST" })
  )
  expect(captured.records).toHaveLength(1)
  expect(await response.text()).toContain("event: end")
  expect(captured.records).toHaveLength(2)
  expect(captured.records[1]?.fields).toMatchObject({
    component: "server",
    operation: "orders/watch",
    outcome: "success",
    messageCount: 1,
    streamStatus: "success"
  })
})

test("logs a non-Response server result when the handler returns", async () => {
  const captured = capturedLogger()
  const handler = logUnaryMiddleware(captured.logger)(async () => "plain" as unknown as Response)
  const result: unknown = await handler(
    newServerContext(background(), transportInfo("orders/watch")),
    new Request("http://127.0.0.1/orders/watch", { method: "POST" })
  )
  expect(result).toBe("plain")
  expect(captured.records).toHaveLength(1)
  expect(captured.records[0]?.fields).toMatchObject({
    component: "server",
    operation: "orders/watch",
    outcome: "success"
  })
})

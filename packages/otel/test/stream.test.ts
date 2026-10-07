import { expect, test } from "bun:test"

import type { CallRequest, Client } from "@go-like/client"
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
import { SpanStatusCode } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"

import { annotateBodySpan } from "../src/instrumentation"
import {
  measureClient,
  measureClientMiddleware,
  measureUnaryMiddleware,
  traceClient,
  traceUnaryMiddleware,
  type RequestMetrics
} from "../src/index"

const Item = struct.object({ n: struct.number() })
const watch = endpoint("orders", "watch", Item, Item, true)
const payload = new TextEncoder().encode(':\n\ndata: {"n":1}\n\nevent: end\ndata: {}\n\n')

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

test("ends client and server spans when the stream body ends", async () => {
  const exporter = new InMemorySpanExporter()
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })]
  })
  try {
    const tracer = provider.getTracer("go-like-stream-test")
    const client = traceClient(streamingClient(), tracer)
    const events = await client.stream(background(), watch, { n: 1 })
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    const values: number[] = []
    for await (const event of events) values.push(event.n)
    expect(values).toEqual([1])
    const clientSpans = exporter.getFinishedSpans()
    expect(clientSpans).toHaveLength(1)
    expect(clientSpans[0]?.attributes["go-like.stream"]).toBe(true)
    expect(clientSpans[0]?.attributes["go-like.message_count"]).toBe(1)
    expect(clientSpans[0]?.status.code).toBe(SpanStatusCode.OK)
    expect(clientSpans[0]?.endTime).toBeDefined()

    const middleware = traceUnaryMiddleware(tracer)
    const handler = middleware(async () => eventResponse())
    const response = await handler(
      newServerContext(background(), transportInfo("orders/watch")),
      new Request("http://127.0.0.1/orders/watch", { method: "POST" })
    )
    expect(exporter.getFinishedSpans()).toHaveLength(1)
    expect(await response.text()).toContain("event: end")
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(2)
    expect(spans[1]?.attributes["go-like.kind"]).toBe("server")
    expect(spans[1]?.attributes["go-like.message_count"]).toBe(1)
    expect(spans[1]?.status.code).toBe(SpanStatusCode.OK)
  } finally {
    await provider.shutdown()
  }
})

/** Records metric outcomes without standing up an SDK exporter. */
function capturedMetrics(): { readonly metrics: RequestMetrics; readonly outcomes: string[] } {
  const outcomes: string[] = []
  const metrics = {
    requestsTotal: {
      add(_value: number, attributes: { readonly outcome: string }): void {
        outcomes.push(attributes.outcome)
      }
    },
    requestDurationSeconds: {
      record(): void {}
    }
  } as RequestMetrics
  return { metrics, outcomes }
}

/** Builds one SSE body with a terminal error event. */
function errorStream(): Response {
  return new Response(
    new TextEncoder().encode(
      'event: error\ndata: {"code":"internal","message":"nope","status":500,"metadata":{}}\n\n'
    ),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  )
}

const rawRequest: CallRequest = {
  service: "orders",
  endpoint: "watch",
  headers: {},
  body: null
}

test("traceClient requires the wrapped client to implement stream", async () => {
  const provider = new TracerProvider()
  try {
    const client = traceClient(
      {
        async call(): Promise<Response> {
          return new Response(null, { status: 204 })
        },
        async close(): Promise<void> {}
      } as unknown as Client,
      provider.getTracer("go-like-stream-guard")
    )
    await expect(client.stream(background(), watch, { n: 1 })).rejects.toThrow(
      "client must implement stream"
    )
  } finally {
    await provider.shutdown()
  }
})

test("annotates canceled, failed, and truncated stream spans", async () => {
  const exporter = new InMemorySpanExporter()
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })]
  })
  try {
    const tracer = provider.getTracer("go-like-body-span")
    const cases = [
      {
        name: "canceled",
        reason: "cancel" as const,
        status: { kind: "canceled" as const },
        stream: false
      },
      {
        name: "service_error",
        reason: "end" as const,
        status: { kind: "error" as const, code: "internal", status: 500 },
        stream: true
      },
      {
        name: "protocol_error",
        reason: "end" as const,
        status: { kind: "truncated" as const },
        stream: true
      }
    ]
    for (const item of cases) {
      const span = tracer.startSpan(item.name)
      annotateBodySpan(
        span,
        {
          reason: item.reason,
          cause: null,
          durationMs: 1,
          handshakeMs: 1,
          messageCount: 0,
          httpStatus: 200,
          stream: item.stream,
          status: item.status
        },
        false
      )
      span.end()
    }
    await provider.forceFlush()
    expect(exporter.getFinishedSpans().map((span) => span.attributes["go-like.outcome"])).toEqual([
      "canceled",
      "service_error",
      "protocol_error"
    ])
  } finally {
    await provider.shutdown()
  }
})

test("records canceled and failed streams for client, raw, and server metrics", async () => {
  const { metrics, outcomes } = capturedMetrics()
  const client = measureClient(streamingClient(), metrics)
  const events = await client.stream(background(), watch, { n: 1 })
  await events.close()
  expect(outcomes).toEqual(["canceled"])

  const failedClient = measureClient(
    {
      async call(): Promise<Response> {
        return new Response(null, { status: 204 })
      },
      async stream(ctx: Context): Promise<ServerStream<{ n: number }>> {
        const response = applyResponseObservers(ctx, errorStream())
        const reader = response.body?.getReader()
        if (reader === undefined) throw new Error("missing body")
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<{ n: number }> {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) return
              yield { n: 1 }
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
    } as Client,
    metrics
  )
  const failedEvents = await failedClient.stream(background(), watch, { n: 1 })
  const failedValues: number[] = []
  for await (const event of failedEvents) failedValues.push(event.n)
  expect(failedValues).toEqual([1])
  expect(outcomes).toEqual(["canceled", "failure"])

  const raw = measureClientMiddleware(metrics)(async () => errorStream())
  expect(await (await raw(background(), rawRequest)).text()).toContain("event: error")
  const canceledRaw = measureClientMiddleware(metrics)(async () => new Response("pending"))
  await (await canceledRaw(background(), rawRequest)).body?.cancel()
  expect(outcomes.slice(2)).toEqual(["failure", "canceled"])

  const server = measureUnaryMiddleware(metrics)
  const failedServer = await server(async () => errorStream())(
    newServerContext(background(), transportInfo("orders/watch")),
    new Request("http://127.0.0.1/orders/watch", { method: "POST" })
  )
  expect(await failedServer.text()).toContain("event: error")
  const canceledServer = await server(async () => new Response("pending"))(
    newServerContext(background(), transportInfo("orders/watch")),
    new Request("http://127.0.0.1/orders/watch", { method: "POST" })
  )
  await canceledServer.body?.cancel()
  expect(outcomes.slice(4)).toEqual(["failure", "canceled"])
})

# Streaming

go-like has three streaming boundaries.

1. **Public Web streaming** uses the Fetch `Request` and `Response` body and the Web Streams API.
2. **Internal service calls** use one Fetch request and one Fetch response. A unary call carries one JSON body. A server stream sets `stream: true` and returns `text/event-stream`. There is no client-stream or bidirectional SPI on this path.
3. **Generated Protobuf RPC** uses `@go-like/connectrpc` for Connect and gRPC-Web on Fetch, and `@go-like/connectrpc/node` for managed standard gRPC. Portable Fetch covers unary and server-streaming. The Node entry covers unary, server-streaming, client-streaming, and bidi. `@go-like/protoc-gen-like` generates the ctx-first client and handler glue.

A `ReadableStream`, a framework SSE response, or a WebSocket upgrade is Web streaming. An internal server stream is SSE on `POST /<service>/<endpoint>` with `accept: text/event-stream`.

Managed gRPC slow-consumer drain on Node 26.12.1 and Bun 1.4.4 is recorded in the [native gRPC drain matrix](/reference/claims#native-grpc-drain-status). Earlier Connect 2.1.2 and Bun 1.4.2 Fetch cancellation observations remain in the [claims ledger](/reference/claims#stream-cancellation-limits). Generated RPC does not add stream replay.

## Public Web streaming

```ts
import { contextHandler, type Handler } from "@go-like/core/web"

export const streamHandler: Handler = contextHandler(async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("first\n"))
      controller.enqueue(encoder.encode("second\n"))
      controller.close()
    }
  })
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" }
  })
})
```

The application or framework owns the stream format, flush, SSE conventions, WebSocket upgrade, and disconnect policy. `contextHandler` ends its Context when the handler returns the `Response`. A long-lived body should also observe `request.signal`. An internal RPC Context lives until the response body ends.

Hono, Elysia, and H3 keep their own stream and WebSocket APIs. Pass `app.fetch` to `@go-like/core/web/node` or `@go-like/core/web/bun` when you want the App lifecycle.

## Internal server streams

Declare `stream: true`. The handler is an async generator. The client reads a `ServerStream` with `for await`. `close()`, `await using`, `break`, and caller cancellation abort the request.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const orders = defineService("orders", {
  watch: {
    request: struct.object({ after: struct.string() }),
    response: struct.object({ id: struct.string() }),
    stream: true
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://orders"))
orders.registerHandler(rpc, {
  async *watch(_ctx, request) {
    yield { id: request.after }
  }
})

const api = orders.newClient(newClient(withTransport(transport), withEndpoint("memory://orders")))
const stream = await api.watch(background(), { after: "0" })
for await (const event of stream) {
  console.log(event.id)
  break
}
await stream.close()
```

`streamKeepAlive` and `maxSendMessageBytes` on `@go-like/core/server` bound the SSE comment interval and the frame size. They do not change the cardinality. There is still one request body and a sequence of response events.

## Generated RPC

`@go-like/connectrpc` exports `newHandler`, `callOptions`, and `fromHandlerContext`. The handler is a Fetch `Handler` for Connect and gRPC-Web. Mount it on a core Web host the same way as any other handler.

`@go-like/connectrpc/node` exports `newServer`, `newClient`, and the address, advertise, and TLS options. That server is a lifecycle `Server` and an `Endpointer` for the server tier. The Node client consumes `Discovery` and `Selector` when you pass them. Standard gRPC on this entry is the path that covers client-streaming and bidi.

`@go-like/protoc-gen-like` is the Buf plugin. Generated code imports `@go-like/core/context` and `@go-like/connectrpc`. The generator has no runtime socket.

Browser standard gRPC, official gRPC health and reflection, and a future-runtime guarantee are outside this matrix. The tested managed drain is the [claims record](/reference/claims#native-grpc-drain-status).

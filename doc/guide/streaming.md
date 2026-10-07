# Streaming

go-like has three distinct streaming boundaries:

1. **Public Web streaming** uses the standard Fetch `Request`/`Response` body and Web Streams APIs.
2. **Internal service calls** use one Fetch `Request` and one Fetch `Response`. A unary call carries one JSON body. A server stream sets `stream: true` and returns SSE. This is not a general bidirectional multi-frame protocol, and it has no client-stream or bidi SPI.
3. **Generated Protobuf RPC** uses `@go-like/transport-grpc-buf`: portable Fetch supports Connect/gRPC-Web unary and server-streaming; `/native` supports standard gRPC unary, server-streaming, client-streaming, and bidi. `@go-like/protoc-gen-like` generates ctx-first client and handler glue over upstream Protobuf-ES descriptors.

> [!IMPORTANT]
> A public `ReadableStream`, framework SSE response, WebSocket upgrade, or long-lived Fetch response is Web streaming. It is not an internal RPC. An internal server stream is SSE on `POST /<service>/<endpoint>`, with `accept: text/event-stream`. Client-streaming and bidi stay on `@go-like/transport-grpc-buf/native`.

See the [observed cancellation and drain limits](/reference/claims#stream-cancellation-limits) for Connect 2.1.2, Bun 1.4.2 Fetch, and Deno native HTTP/2. Interoperability alone does not prove stream cleanup. Generated RPC does not add automatic retries or stream replay.

## Public Web streaming

A standard Handler may return a Response whose body is a Web Stream:

```ts
import type { Handler } from "@go-like/web"

export const streamHandler: Handler = () => {
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
}
```

The application or Web framework owns stream format, flushing, SSE conventions, WebSocket upgrades, and client disconnect policy. `@go-like/web` preserves the standard Handler ABI and can bridge request cancellation into a Context with `contextHandler`:

```ts
import { contextHandler } from "@go-like/web"

declare function buildStream(request: Request): Promise<ReadableStream<Uint8Array>>

const handler = contextHandler(async (_ctx, request) => {
  const body = await buildStream(request)
  return new Response(body)
})
void handler
```

The application must decide how a canceled request affects its generator, upstream subscription, or native socket. A stream body is one-shot; middleware that consumes a body must replace it if downstream code still needs to read it. `contextHandler` cleans its private Context when the handler returns the `Response`; that Context does not automatically live for the whole body stream. A long-lived public producer should therefore observe `request.signal` or own a separate cancellation scope. That cleanup rule is only for the public Web bridge. An internal RPC request Context lives until the response body ends.

Hono, Elysia, and H3 can create streamed responses or runtime-specific WebSocket behavior through their own native APIs. Pass their Fetch handler to `@go-like/web` when you want the go-like host and lifecycle boundary. Do not describe that composition as a go-like WebSocket or SSE framework.

## Internal server streams

Declare `stream: true` on the contract. The handler is an `async` generator. The client awaits the `ServerStream`, then reads it with `for await`. `ServerStream.close()` and `await using` both stop the call. `break`, `close`, disposal, and caller cancellation abort the request.

```ts
/// <reference lib="esnext.disposable" />

import { newClient, withEndpoint, withTransport } from "@go-like/client"
import { background } from "@go-like/context"
import {
  address,
  maxSendMessageBytes,
  newServer,
  streamKeepAlive,
  transport as serverTransport
} from "@go-like/server"
import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

const orders = defineService("orders", {
  watch: {
    request: struct.object({ after: struct.string() }),
    response: struct.object({ id: struct.string() }),
    stream: true
  }
})

const wire = newMemoryTransport()
const rpc = newServer(
  serverTransport(wire),
  address("memory://orders"),
  streamKeepAlive(15_000),
  maxSendMessageBytes(4 * 1024 * 1024)
)
orders.registerHandler(rpc, {
  async *watch(_ctx, request) {
    yield { id: request.after }
  }
})

const client = newClient(withTransport(wire), withEndpoint("memory://orders"))
const api = orders.newClient(client)
const ctx = background()
const opened = await api.watch(ctx, { after: "0" })
try {
  for await (const event of opened) {
    void event.id
  }
} finally {
  await opened.close()
}

await using stream = await api.watch(ctx, { after: "0" })
for await (const event of stream) {
  void event.id
}
await client.close(ctx)
void rpc
```

The server must be started before `watch` can complete. The snippet shows the types and the ownership shape.

- The request is the same POST JSON call as unary, plus `accept: text/event-stream`. A successful response is `text/event-stream`.
- The handshake, response headers and the initial comment, is sent when the handler returns an async iterable. Routing, decode, and middleware failures before that return are ordinary HTTP `ServiceError` responses. Failures inside the generator, including before the first `yield`, arrive as SSE `error` events and are thrown by `for await`.
- `streamKeepAlive(intervalMs)` defaults to `15000`. `streamKeepAlive(0)` disables later comments and still sends the initial comment.
- `maxSendMessageBytes` defaults to 4 MiB. The counted size is the full UTF-8 SSE event, including prefixes and the trailing blank line. There is no total stream size limit. The client receive ceiling is the transport `maxMessageBytes`. An oversize event uses code `resource_exhausted` and HTTP 429. The message includes the actual byte count, the limit, and which side rejected it.
- A stream is one-shot. go-like does not reconnect, and it ignores SSE `id` and `retry`. Resuming is a business cursor on the next explicit call.
- Retry applies only before the handshake. A failure after headers and the initial comment is not replayed.
- The server writes a pull-mode `ReadableStream`. Memory maps one client read to one server pull and stays at most one event ahead. HTTP may prefetch a bounded number of events because of the runtime and socket buffers. That prefetch does not promise a one-to-one match with `for await`.
- Do not perform a side effect in the generator that assumes the client has received the event. A client that stops can leave a prefetched event undelivered after the side effect has already run. Confirm delivery with a later unary call that commits a cursor.
- The request Context lives until the stream ends, errors, the client cancels, the deadline fires, or the server shuts down. It is tied to the response body. Then go-like cancels that Context, calls the iterator `return()`, and releases the deadline timer.

## Why the distinction matters

| Question      | Public Web stream                                          | Internal server stream                                      |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| Message shape | Web `Request`/`Response` body                              | POST JSON request and `text/event-stream` response          |
| Direction     | Request body and response body; framework may add upgrades | One request, then server events only                        |
| Framing       | Web/runtime/framework-defined                              | SSE events from `@go-like/transport/sse`                    |
| Cancellation  | `Request.signal`; `contextHandler` ends when it returns    | Request Context until the response body ends                |
| Retry         | Application decides whether a Web request can be replayed  | `withRetry` only before the SSE handshake                   |
| Backpressure  | Web Streams/framework/runtime contract                     | Memory is at most one ahead; HTTP prefetch is bounded       |
| Full duplex   | Possible through a framework or Web API                    | Not this SPI; use grpc-buf `/native` for client-stream/bidi |

## Cancellation and cleanup

Use the operation Context as the first argument for internal work. For public Web work, `contextHandler` maps `Request.signal` to a private Context and cleans its listeners and timeout when the handler settles. For a long-lived public stream, keep the source owner explicit and observe the request signal instead of the settled Handler Context:

```ts
async function buildStream(request: Request): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder()
  let remaining = 3
  return new ReadableStream({
    pull(controller) {
      if (request.signal.aborted || remaining === 0) {
        controller.close()
        return
      }
      remaining -= 1
      controller.enqueue(encoder.encode(`chunk-${3 - remaining}\n`))
    },
    cancel() {
      remaining = 0
    }
  })
}
```

The snippet illustrates the ownership decision. Internal Client cleanup is separate: call `stream.close()` or dispose the `ServerStream`, then `client.close(ctx)` when the logical Client is no longer used.

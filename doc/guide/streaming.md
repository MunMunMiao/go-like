# Streaming

go-like has two different streaming boundaries, and only one is an internal go-like transport contract:

1. **Public Web streaming** uses the standard Fetch `Request`/`Response` body and Web Streams APIs.
2. **Internal service calls** currently use one unary request `Message` and one unary response `Message`.

The second boundary is deliberately not called an RPC stream. go-like does not currently publish an internal full-duplex stream SPI, frame protocol, half-close operation, backpressure contract, or stream retry rule.

> [!IMPORTANT]
> A `ReadableStream`, SSE response, WebSocket upgrade, or long-lived Fetch response is Web streaming. It is not evidence that go-like supports internal bidirectional RPC streams.

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

const handler = contextHandler(async (_ctx, request) => {
  const body = await buildStream(request)
  return new Response(body)
})
```

The application must decide how a canceled request affects its generator, upstream subscription, or native socket. A stream body is one-shot; middleware that consumes a body must replace it if downstream code still needs to read it. `contextHandler` cleans its private Context when the handler returns the `Response`; that Context does not automatically live for the whole body stream. A long-lived source should therefore observe `request.signal` or own a separate cancellation scope.

Hono, Elysia, and H3 can create streamed responses or runtime-specific WebSocket behavior through their own native APIs. Pass their Fetch handler to `@go-like/web` when you want the go-like host and lifecycle boundary. Do not describe that composition as a go-like WebSocket or SSE framework.

## Internal unary transport

The internal `@go-like/transport` SPI has `Transport`, `Client`, `Listener`, `Socket`, and `Message` types. A Socket can expose `send` and `recv`, but the current `@go-like/server` dispatcher and implemented HTTP and Memory providers perform one admitted `recv -> handler -> send` exchange per call. There is no general multi-frame protocol.

The current internal path is:

```text
Client.call(ctx, operation, input)
  -> one outbound Message
  -> one server route and handler invocation
  -> one response Message
  -> one Client result
```

`@go-like/transport-memory` is instance-private and process-local. `@go-like/transport-http` carries the unary exchange over an HTTP wire. `@go-like/transport-http/node` adds the Node host, native HTTP/1.1 and HTTP/2, TLS, mTLS, and pooling. None of those statements adds internal full-duplex RPC semantics.

## Why the distinction matters

| Question      | Public Web stream                                          | Internal go-like call                                          |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Message shape | Web `Request`/`Response` body                              | `Message` headers plus `Uint8Array` body                       |
| Direction     | Request body and response body; framework may add upgrades | One unary request and one unary response                       |
| Framing       | Web/runtime/framework-defined                              | Provider's unary Message boundary                              |
| Cancellation  | `Request.signal`, handler Context, stream cancellation     | call Context through `send`/`recv` and owner cleanup           |
| Retry         | Application decides whether a Web request can be replayed  | `withRetry` requires explicit authorization and total attempts |
| Backpressure  | Web Streams/framework/runtime contract                     | No internal stream backpressure SPI is promised                |
| Full duplex   | Possible through a framework or Web API                    | Deliberately outside the current go-like boundary              |

A Fetch body can be streamed while a request is in flight. That does not imply the transport can exchange arbitrary frames in both directions, nor that a retry can safely recreate the body. If an application builds an internal stream protocol, it owns that protocol and should not label it as go-like's current Transport contract.

## Cancellation and cleanup

Use the operation Context as the first argument for internal work. For public Web work, `contextHandler` maps `Request.signal` to a private Context and cleans its listeners and timeout when the handler settles. For a long-lived stream, keep the source owner explicit and observe the request signal instead of the settled Handler Context:

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
      // Release the application-owned upstream source here.
    }
  })
}
```

The snippet illustrates the ownership decision; an application should add a real termination condition instead of producing an endless stream. Internal Client cleanup is separate: call `client.close(ctx)` when the logical Client is no longer used.

## What would be required for an internal full-duplex API

Adding an internal stream contract would be a new product boundary, not a rename. It would need a defined wire frame model, message ordering, backpressure, half-close semantics, terminal errors, cancellation propagation, provider capability negotiation, retry prohibition after partial exchange, and runtime-specific providers. Those decisions are intentionally not part of the current `0.0.1` documentation claim.

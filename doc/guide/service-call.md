# Service calls

go-like's internal call path is a unary `Message` exchange. It is intentionally separate from the public Fetch Handler path. The client may use a typed `Endpoint` and `Struct` boundary, or it may use the raw `CallRequest` shape when the application owns its own bytes and validation.

The canonical pipeline is:

```text
Context + operation
  -> Client middleware
  -> direct address OR Discovery snapshot
  -> Filters
  -> Selector
  -> Transport Client acquire or dial
  -> send(Message)
  -> Server route and middleware
  -> handler(ctx, Message) or typed handler(ctx, value)
  -> response Message
  -> recv and decode
  -> selection feedback
  -> logical owner reuse or close
```

## Operation identity versus address identity

A typed operation has a stable logical identity:

```text
service/endpoint = bank-transfer-routing/TransferRouting.Quote
```

A destination has a transport identity:

```text
memory://bank-transfer-gateway
https://pricing.internal.example
127.0.0.1:9000
```

`endpoint(...)` creates the first kind of object. `withAddress(...)` supplies the second kind of value. A Registry `ServiceInstance` contains service identity and an `endpoints` array of opaque transport addresses. go-like does not infer a protocol or operation from a URL scheme.

## Typed Memory Transport first

The typed form is useful when both sides agree on runtime `Struct` validation and JSON encoding. The following uses only current public exports:

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import { background } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"
import { address, handler, newServer, transport as serverTransport } from "@go-like/server"
import { struct } from "@go-like/struct"
import { endpoint } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

const AddRequest = struct.object({
  left: struct.number(),
  right: struct.number()
})
const AddResponse = struct.object({
  sum: struct.number()
})

const Add = endpoint("math", "Add", AddRequest, AddResponse)
const transport = newMemoryTransport()

const rpc = newServer(
  serverTransport(transport),
  address("memory://math"),
  handler(Add, (_ctx, request) => ({
    sum: request.left + request.right
  }))
)

const client = newClient(withTransport(transport))
const app = newApp(name("math-example"), server(rpc))
const running = app.run()
const target = await rpc.endpoint(background())

try {
  const result = await client.call(background(), Add, { left: 2, right: 3 }, withAddress(target))
  console.log(result.sum)
} finally {
  await client.close(background())
  await app.stop()
  await running
}
```

In a real application, prefer one composition root that starts and stops the server. The important details are:

- the Client and Server use the same `newMemoryTransport()` instance;
- `handler(endpoint, fn)` is a typed internal unary handler, not a Fetch handler;
- `client.call(ctx, endpoint, value, withAddress(...))` validates the request and response through the Endpoint's Structs;
- `client.close(ctx)` is explicit application cleanup;
- Memory Transport is instance-private and process-local. It does not fall back to a network transport.

The repository's `examples/bank-transfer-gateway` demonstrates this pattern with the `transferQuoteEndpoint` contract. The current `healthcare-appointments` example uses the same Client, Server, and Memory Transport boundary with raw JSON; it is a useful bridge when you need to inspect the lower layer.

## Raw `Message` calls

The lower-level `CallRequest` shape is:

```ts
interface CallRequest {
  readonly service: string
  readonly endpoint: string
  readonly message: Message
}
```

A raw call can be composed without a typed `Endpoint`:

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import { background } from "@go-like/context"
import { newMemoryTransport } from "@go-like/transport-memory"

const client = newClient(withTransport(newMemoryTransport()))
const reply = await client.call(
  background(),
  {
    service: "orders",
    endpoint: "Orders.Get",
    message: {
      header: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ orderId: "order-1" }))
    }
  },
  withAddress("memory://orders")
)
```

This raw example only describes the Client call shape. A server must be listening on the same Transport instance and address; raw calls do not create a handler automatically. Raw handlers also do not receive Struct validation unless the application adds it.

The Transport package provides JSON helpers when you want the same codecs without a typed Client endpoint:

```ts
import { decodeJsonBody, encodeJsonBody } from "@go-like/transport/json"

const request = decodeJsonBody(RequestStruct, message.body)
const body = encodeJsonBody(ResponseStruct, response)
```

The helpers validate UTF-8, JSON syntax, and the supplied Struct. They do not define an IDL or generate code.

## One attempt in detail

The Client snapshots the outbound Message before a call. An admitted attempt does the following:

1. Use `withAddress(...)`, or ask Discovery for a complete snapshot.
2. Apply `withFilter(...)` filters in declaration order.
3. Ask the Selector for one opaque transport URL and a synchronous feedback callback.
4. Reuse an idle logical Transport Client for that address, or call `Transport.dial(...)`.
5. Send the Message with routing headers and any permitted client metadata.
6. Receive one response Message.
7. Snapshot and decode the response, including `ServiceError` and typed response validation.
8. Report selection feedback with sent/received facts and reply metadata.
9. Return the logical owner to the idle pool after a successful exchange, or close it after a failed exchange.

The Client pool is a logical `Transport.Client` pool, not a socket limit. The defaults are `poolSize(100)` idle owners across all addresses and `poolTtl(60_000)` milliseconds. Physical connection reuse belongs to the selected Transport and runtime. Use `closeTimeout(...)` to bound each logical Transport Client close; a timeout remains a cleanup boundary, not proof of native terminal state.

```text
Typed Client.call(ctx, Endpoint, input)
  |
  +-- validate Endpoint and encode JSON body
  +-- client middleware
  |     exact operation > longest trailing wildcard > global
  +-- snapshot routing headers and body
  +-- one attempt by default
  |     +-- direct address OR Discovery -> Filter -> Selector
  |     +-- acquire resident Transport Client or dial
  |     +-- send(ctx, Message)
  |     +-- server recv -> route -> middleware -> handler -> send
  |     +-- recv(ctx, Message)
  |     +-- ServiceError decode and typed response validation
  |     +-- SelectionDone feedback
  |     +-- reuse idle owner or close
  +-- return typed response
```

## Discovery, filters, and selection

A Discovery implementation exposes complete replacement snapshots:

```ts
interface Discovery {
  getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]>
  watch(ctx: Context, name: string): Promise<Watcher>
}

interface Watcher {
  next(ctx: Context): Promise<readonly ServiceInstance[]>
  stop(ctx: Context): Promise<void>
}
```

The Client lazily creates one resident watcher per service name. It establishes the watcher before the initial read, uses a first snapshot barrier, then performs a fresh read so an older initial result cannot overwrite a newer snapshot. A later empty snapshot is authoritative: it replaces the previous endpoints and causes selection to fail closed. During transient watcher reconstruction, the resolver may retain the last complete snapshot while it rebuilds the watcher.

`withBlock()` changes initial readiness only. It waits for the first raw discovery snapshot containing at least one endpoint. It does not make later empty snapshots healthy and it does not apply call filters to the readiness decision.

Filters are pure snapshot functions:

```ts
import { withFilter } from "@go-like/client"
import { filterLabel, filterVersion } from "@go-like/registry"

const reply = await client.call(
  ctx,
  operation,
  request,
  withFilter(filterVersion("v2"), filterLabel("zone", "a"))
)
```

A filter that removes every instance produces `NoAvailableEndpointError` before dialing. Selectors then flatten transport URLs from the surviving instances:

| Selector                                            | Chooses by                                   | Feedback                   |
| --------------------------------------------------- | -------------------------------------------- | -------------------------- |
| `newRandomSelector()`                               | One random eligible URL                      | No-op                      |
| `newRoundRobinSelector()`                           | Stable successor by service domain           | No-op                      |
| `newWeightedRoundRobinSelector(endpoint => weight)` | Positive integer returned for each endpoint  | No-op                      |
| `newP2CSelector(options?)`                          | Lower in-flight count from two samples       | Failure and cooldown state |
| `newEWMASelector(options?)`                         | Sampled latency, health, and in-flight score | Decayed observations       |

P2C cooldown is endpoint-local selection state, not a circuit breaker. The Client `circuitBreakerMiddleware(...)` keys breakers by logical `service/endpoint`, before discovery and transport I/O when open. These are different failure identities.

## Transport choices

| Provider                      | Use it when                                                                   | Important boundary                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@go-like/transport-memory`    | Same-process composition and deterministic tests                              | Private address map, unary exchange, no persistence or cross-process behavior                                |
| `@go-like/transport-http`      | A portable Fetch-backed internal HTTP client is sufficient                    | Root `listen` needs an injected runtime `HTTPHost`; custom Node TLS material is not a portable Fetch feature |
| `@go-like/transport-http/node` | A Node service needs native listener, HTTP/1.1, HTTP/2, TLS, mTLS, or pooling | Explicit Node subpath; TLS and ALPN are not automatically enabled by the root transport                      |

`newHTTPTransport()` captures the current `globalThis.fetch` at construction. `newNodeHTTPTransport()` provides a Node host and native dial executor. The external Web host `@go-like/web/node` is a different package path and should not be described as the internal TLS/HTTP2 transport.

## Metadata and error layers

go-like metadata is an immutable multi-value snapshot. Client and Server metadata Context domains are separate. Server metadata is not forwarded to downstream Clients unless the application calls `propagateToClientContext(...)` with an explicit `exact` or `prefix` allowlist. This default prevents accidental forwarding of `authorization`, `cookie`, or other sensitive headers.

The internal wire uses one bounded canonical `Go-Like-Metadata` header. Metadata is transport data, not trusted identity; TLS, mTLS, authentication, and authorization remain application concerns.

Keep the error layers distinct:

| Error                      | Meaning                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `HTTPStatusError`          | The HTTP carrier returned a non-200 response                                   |
| `ServiceError`             | A valid unary service failure encoded in the internal response envelope        |
| `TransportProtocolError`   | The provider or message wire was malformed                                     |
| `NoAvailableEndpointError` | Discovery/filter/selection produced no usable destination                      |
| `CompletedCallFailure`     | The response was received, but feedback or cleanup failed; replay is forbidden |
| `AggregateError`           | More than one primary or cleanup failure was observed                          |

A `ServiceError` is not automatically an HTTP 4xx/5xx response. Conversely, an HTTP 503/504 carrier failure can affect selector feedback. The Client owns this classification; applications should not reduce every error to a status code.

## Retry is replay authorization

Calls make one attempt by default. `withRetry(...)` requires an explicit authorization, a positive total `maxAttempts`, and a caller-supplied `shouldRetry` predicate:

```ts
import { withRetry } from "@go-like/client"
import { exponentialBackoff } from "@go-like/resilience"

const reply = await client.call(
  ctx,
  idempotentOperation,
  input,
  withRetry({
    authorization: "idempotent",
    maxAttempts: 3,
    shouldRetry: (_ctx, failure, attempt) => {
      return failure instanceof TypeError && attempt < 3
    },
    backoff: exponentialBackoff({
      initialDelayMs: 25,
      multiplier: 2,
      maxDelayMs: 250
    })
  })
)
```

`maxAttempts` is the total number of attempts, not the number of extra retries. `authorization` is a caller declaration, not a proof that a business mutation is safe to replay. go-like does not generate idempotency keys, deduplicate external side effects, or inspect your database transaction.

Each admitted retry re-enters the attempt pipeline and may select a different endpoint from the latest snapshot. The outbound Message snapshot is reused. If a response has already been received but selection feedback or Transport Client cleanup fails, the Client returns a branded completed-call failure and refuses to replay it:

```text
Attempt 1: send -> no response -> predicate authorizes replay
  -> backoff -> latest discovery -> select another endpoint -> Attempt 2

Attempt 2: response received -> cleanup fails
  -> CompletedCallFailure(response in cause)
  -> no Attempt 3
```

## Middleware order

Client and Server both support a global middleware chain and operation-specific middleware. Operation matching is exact first, then the longest trailing-wildcard prefix, then the global chain. The first middleware declared in a sequence is the outermost layer.

```ts
import { middleware, newClient, type ClientMiddleware, use, withTransport } from "@go-like/client"

const observe: ClientMiddleware =
  (next) =>
  async (ctx, request, ...options) => {
    const started = performance.now()
    try {
      return await next(ctx, request, ...options)
    } finally {
      console.log(request.service, request.endpoint, performance.now() - started)
    }
  }

const client = newClient(withTransport(transport), middleware(observe), use("orders/*", observe))
```

The `transport` value is an application-owned `Transport` constructed earlier. Do not assume middleware adds validation, retries, or authorization automatically.

## Cleanup checklist

Before a process exits, identify and close each owner:

- `await client.close(ctx)` for resident Transport Client owners and discovery watchers;
- `await app.stop()` for Core Servers and lifecycle adapters;
- provider-specific connection, stream, consumer, or logger cleanup according to its adapter contract;
- the Server's terminal Promise when a long-lived `start(ctx)` remains pending.

A caller that abandons a wait is not the same as an owner that has released a resource. Keep both facts in operational logs and tests.

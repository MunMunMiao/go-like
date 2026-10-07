# Service calls

go-like's internal call path is one Fetch `Request` and one Fetch `Response`. It is intentionally separate from the public Web Handler path. Unary calls exchange one JSON body. Server streams, declared with `stream: true`, use SSE after the same POST. The client may use `defineService` or a single `endpoint(...)`, or it may use the raw `CallRequest` shape when the application owns its own bytes.

The canonical pipeline is:

```text
Context + operation
  -> Client middleware
  -> direct root URL OR Discovery snapshot
  -> Filters
  -> Selector
  -> Transport Client acquire or dial
  -> fetch(Request) at /<service>/<endpoint>
  -> Server route and middleware
  -> handler(ctx, Request) or typed handler(ctx, value)
  -> Response
  -> decode JSON or read the SSE stream
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
https://pricing.internal.example/
discovery:///pricing
```

`defineService` or `endpoint(...)` creates the operation. Construction-time `withEndpoint(...)` supplies the node. A Registry `ServiceInstance` contains the application name and an `endpoints` array of opaque transport addresses. `discovery:///<name>` selects that Registry application name and is not dialed. Every other scheme is a direct address interpreted by the Transport. The scheme does not name the operation. After a node is chosen, the Fetch request path is `/<service>/<endpoint>`. Client node addresses, and HTTP dial URLs that include a scheme, must be absolute root URLs because that path is the route. `withAddress` and `withService` have been removed.

## Typed Memory Transport first

The typed form is useful when both sides agree on runtime `Struct` validation and JSON encoding. The following uses only current public exports:

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/client"
import { background } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"
import { address, newServer, transport as serverTransport } from "@go-like/server"
import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

const math = defineService("math", {
  add: {
    request: struct.object({
      left: struct.number(),
      right: struct.number()
    }),
    response: struct.object({
      sum: struct.number()
    })
  }
})
const transport = newMemoryTransport()

const rpc = newServer(serverTransport(transport), address("memory://math"))
math.registerHandler(rpc, {
  add(_ctx, request) {
    return { sum: request.left + request.right }
  }
})

const client = newClient(withTransport(transport), withEndpoint("memory://math"))
const api = math.newClient(client)
const app = newApp(name("math-example"), server(rpc))
const running = app.run()
await rpc.endpoint(background())

try {
  const result = await api.add(background(), { left: 2, right: 3 })
  console.log(result.sum)
} finally {
  await client.close(background())
  await app.stop()
  await running
}
```

In a real application, prefer one composition root that starts and stops the server. The important details are:

- the Client and Server use the same `newMemoryTransport()` instance;
- `service.registerHandler(server, handler)` registers each typed handler before start;
- `service.newClient(client).add(ctx, value)` validates the request and response through the Structs, while the destination stays on the Client owner;
- `client.close(ctx)` is explicit application cleanup;
- Memory Transport is instance-private and process-local. It does not fall back to a network transport.

`examples/healthcare-appointments` uses this shape: `defineService("appointment-policy.v1", { check })`, `withEndpoint("memory://appointment-policy.v1")`, and `serviceError(..., 409)`. Server streams are covered in [Streaming](/guide/streaming).

## Raw calls

The lower-level `CallRequest` shape is `{ service, endpoint, headers, body }`. `call` returns a Fetch `Response`. The caller must read the body or cancel it. Every internal RPC, including a raw handler, requires `POST` and `content-type: application/json`:

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/client"
import { background } from "@go-like/context"
import { newMemoryTransport } from "@go-like/transport-memory"

const client = newClient(withTransport(newMemoryTransport()), withEndpoint("memory://orders"))
const response = await client.call(background(), {
  service: "orders",
  endpoint: "get",
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify({ orderId: "order-1" }))
})
await response.body?.cancel()
await client.close(background())
```

This raw example only describes the Client call shape. A server must be listening on the same Transport instance and address; raw calls do not create a handler automatically. Raw handlers also do not receive Struct validation unless the application adds it. A typed `call` rejects a `stream: true` endpoint; use `stream`.

The Transport package provides JSON helpers when you want the same codecs without a typed Client endpoint:

```ts
import { struct } from "@go-like/struct"
import { decodeJsonBody, encodeJsonBody } from "@go-like/transport/json"

const RequestStruct = struct.object({ orderId: struct.string() })
const ResponseStruct = struct.object({ orderId: struct.string() })
const request = decodeJsonBody(
  RequestStruct,
  new TextEncoder().encode(JSON.stringify({ orderId: "order-1" }))
)
const body = encodeJsonBody(ResponseStruct, request)
void body
```

The helpers validate UTF-8, JSON syntax, and the supplied Struct. They do not define an IDL or generate code.

## One attempt in detail

The Client copies the outbound body before a call. When the caller Context has a deadline, it writes the remaining milliseconds, rounded up, to `Go-Like-Timeout-Ms`. An admitted attempt does the following:

1. Read the construction-time direct-address snapshot, or ask Discovery for a complete snapshot.
2. Apply `withFilter(...)` filters in declaration order.
3. Ask the Selector for one opaque root URL and a synchronous feedback callback.
4. Reuse an idle logical Transport Client for that address, or call `Transport.dial(...)`.
5. `fetch` a `POST` whose path is `/<service>/<endpoint>`, with `content-type: application/json` and any permitted `Go-Like-Metadata`.
6. Receive one `Response`. `bytesSent` is set just before `fetch`; `bytesReceived` is set when the `Response` arrives.
7. Decode the response, including a non-2xx `ServiceError` JSON body and typed response validation.
8. Report selection feedback with sent/received facts and reply metadata.
9. Return the logical owner to the idle pool after a successful exchange, or close it after a failed exchange. A server stream holds that owner until the body ends.

The Client pool is a logical `Transport.Client` pool, not a socket limit. The defaults are `poolSize(100)` idle owners across all addresses and `poolTtl(60_000)` milliseconds. Physical connection reuse belongs to the selected Transport and runtime. Use `closeTimeout(...)` to bound each logical Transport Client close; a timeout remains a cleanup boundary, not proof of native terminal state.

```text
Typed Client.call(ctx, Endpoint, input)
  |
  +-- validate Endpoint and encode JSON body
  +-- client middleware
  |     exact operation > longest trailing wildcard > global
  +-- copy JSON body and optional Go-Like-Timeout-Ms
  +-- one attempt by default
  |     +-- direct root URL OR Discovery -> Filter -> Selector
  |     +-- acquire resident Transport Client or dial
  |     +-- fetch POST /<service>/<endpoint>
  |     +-- server route -> middleware -> handler
  |     +-- Response
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

The Client lazily creates one resident watcher per service name. It establishes the watcher before the initial read, uses a first snapshot barrier, then performs a fresh read so an older initial result cannot overwrite a newer snapshot. A later empty snapshot is authoritative: it replaces the previous endpoints and causes selection to fail closed. During transient watcher reconstruction, the resolver may retain the last complete snapshot during backoff. After reopening the watcher it performs an authoritative `getService` read before waiting for the first watcher result, so a missed removal can publish an empty snapshot even when `next()` waits for non-empty endpoints. It reconciles the first watcher result with another fresh read before accepting it.

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

| Provider                       | Use it when                                                                   | Important boundary                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
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

See [Error handling](/reference/errors) for the stable matching order, code catalog, and retry boundaries.

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

Each admitted retry re-enters the attempt pipeline and may select a different node from the latest snapshot. The copied request body is reused. Retry stops once the SSE handshake has been sent. If a response has already been received but selection feedback or Transport Client cleanup fails, the Client returns a completed-call `AggregateError` and refuses to replay it:

```text
Attempt 1: fetch -> no response -> predicate authorizes replay
  -> backoff -> latest discovery -> select another node -> Attempt 2

Attempt 2: response received -> cleanup fails
  -> AggregateError("client exchange completed but cleanup failed; do not retry")
  -> no Attempt 3
```

## Middleware order

Client and Server both support a global middleware chain and operation-specific middleware. Operation matching is exact first, then the longest trailing-wildcard prefix, then the global chain. The first middleware declared in a sequence is the outermost layer.

```ts
import {
  middleware,
  newClient,
  type ClientMiddleware,
  use,
  withEndpoint,
  withTransport
} from "@go-like/client"

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

declare const transport: Parameters<typeof withTransport>[0]

const client = newClient(
  withTransport(transport),
  withEndpoint("memory://orders"),
  middleware(observe),
  use("orders/*", observe)
)
```

The `transport` value is an application-owned `Transport` constructed earlier, and `serviceAddress` is its construction-time destination. Do not assume middleware adds validation, retries, or authorization automatically.

## Cleanup checklist

Before a process exits, identify and close each owner:

- `await client.close(ctx)` for resident Transport Client owners and discovery watchers;
- `await app.stop()` for Core Servers and lifecycle adapters;
- provider-specific connection, stream, consumer, or logger cleanup according to its adapter contract;
- the Server's terminal Promise when a long-lived `start(ctx)` remains pending.

A caller that abandons a wait is not the same as an owner that has released a resource. Keep both facts in operational logs and tests.

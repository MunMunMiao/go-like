# Service calls

An internal service call is one Fetch exchange. The operation name and the transport address are different values. A typed call adds Struct validation on the JSON body. Generated Protobuf RPC is a separate path; see [Streaming](/guide/streaming).

## Operation identity and address

`defineService("appointment-policy.v1", { check })` names the operation `appointment-policy.v1/check`. `withEndpoint("memory://appointment-policy.v1")` and `address("memory://appointment-policy.v1")` name where the bytes go. A registry `ServiceInstance` stores transport URLs in `endpoints`. Filters and selectors choose among those URLs. They do not choose the operation.

## Typed Memory Transport

Use one `newMemoryTransport()` for both sides. It is process-local and instance-private. This is the shape in `examples/healthcare-appointments`:

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { name, newApp, server } from "@go-like/core"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService, serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const math = defineService("math", {
  add: {
    request: struct.object({ left: struct.number(), right: struct.number() }),
    response: struct.object({ sum: struct.number() })
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://math"))
math.registerHandler(rpc, {
  add(_ctx, request) {
    if (!Number.isFinite(request.left) || !Number.isFinite(request.right)) {
      throw serviceError("math_rejected", "operands must be finite", 400)
    }
    return { sum: request.left + request.right }
  }
})

const client = newClient(withTransport(transport), withEndpoint("memory://math"))
const api = math.newClient(client)
const app = newApp(name("math"), server(rpc))
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

`service.registerHandler` binds each typed handler before start. `service.newClient(client).add(ctx, value)` validates the request and the response. `client.close(ctx)` is application cleanup. In a real process, close the client from `afterStop` and let `app.run()` own the lifetime.

`newHTTPTransport()` is the portable Fetch client. It does not listen. A Node listener uses `newNodeHTTPTransport()` from `@go-like/core/transport/http/node` on both the server and the Node client. Passing `newHTTPTransport()` to `newServer` typechecks and then fails at listen with `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY`.

`@go-like/core/server` and `@go-like/core/client` both export `middleware` and `use`. Import one of them as a namespace when a file needs both.

## One attempt

The default call makes one attempt. The client builds a `POST` with `content-type: application/json`, dials or reuses a transport, and reads the response. A non-2xx JSON body that matches the service-error envelope becomes a `ServiceError`. Recognize it with `isServiceError` from `@go-like/core/transport` before reading `code`, `status`, or `metadata`. `ServiceError.code` is application-owned. It is not a `GO_LIKE_*` code.

A raw `client.call` takes `{ service, endpoint, headers, body }` and returns a Fetch `Response`. The caller reads the body or cancels it.

Metadata travels on the Context. `@go-like/core/metadata` provides `newClientContext`, `fromServerContext`, and `propagateToClientContext`. Propagation is explicit. Incoming metadata is not copied to the next hop unless the handler does that.

## Discovery, filters, and selection

`newDiscoveryResolver` from `@go-like/core/registry` watches one service and keeps a complete replacement snapshot. An empty snapshot is authoritative: selection fails with `GO_LIKE_NO_AVAILABLE_ENDPOINT` instead of reusing the previous instances.

```ts
import { newClient, withDiscovery, withEndpoint, withSelector } from "@go-like/core/client"
import { newP2CSelector } from "@go-like/core/registry"

const client = newClient(
  withDiscovery(registry),
  withEndpoint("discovery:///pricing"),
  withSelector(newP2CSelector())
)
void client
```

`withDiscovery` takes the `Discovery`. The client builds a private resolver. Call `newDiscoveryResolver(discovery)` only when application code needs snapshots outside a client. Two resolvers on one Discovery do not share watchers.

Filters are pure and ordered. `filterVersion` and `filterLabel` are the built-ins, passed per call with `withFilter`. Selectors are `newRoundRobinSelector`, `newWeightedRoundRobinSelector`, `newRandomSelector`, `newP2CSelector`, and `newEWMASelector`. P2C and EWMA take synchronous feedback after the attempt. That state is separate from `circuitBreakerMiddleware`, which keys a breaker to an operation.

`withBlock()` waits for the first non-empty snapshot. A direct `withEndpoint` address list is a static snapshot and still goes through the selector. `withEndpoint("discovery:///name")` names the service to watch.

## Retry is replay authorization

`withRetry` from `@go-like/core/client` requires:

- `authorization`: `"idempotent"` or `"caller-approved"`;
- `maxAttempts`: a positive integer, counting the first attempt;
- `shouldRetry(ctx, error, attempt)` returning a boolean.

The authorization is a declaration by the caller. Core does not inspect side effects. Each attempt re-enters discovery and selection. A response that was already received, followed by a feedback or cleanup failure, is not replayed.

`retry` and `exponentialBackoff` in `@go-like/core/resilience` are the same idea for application code outside the client. `newCircuitBreaker` and `circuitBreakerMiddleware` open on caller-defined failures. `circuitOpen` is the sentinel thrown while the breaker is open. `newTokenBucketLimiter` and `rateLimitMiddleware` reject excess calls.

## Cleanup

- Close clients and config watchers in `afterStop`, or admit a native connection with `newResourceServer`.
- Keep the request Context for the call. Replacing it with `background()` drops cancellation and the current span.
- Match failures by sentinel, `isServiceError`, or a documented `code`. Leave the message for diagnostics. The catalog is [Error handling](/reference/errors).

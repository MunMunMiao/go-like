# Service calls

An internal unary call is a small composition. `@likego/client` gives a Discovery snapshot to a `Selector`, then performs one `send`/`recv` exchange through a `Transport`. Construction uses functional options:

```ts
import { newClient, withDiscovery, withFilter, withSelector, withTransport } from "@likego/client"
import { filterLabel, filterVersion, type Filter } from "@likego/registry"

const client = newClient(
  withDiscovery(discovery),
  withSelector(selector),
  withTransport(serviceTransport)
)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
const reply = await client.call(
  ctx,
  {
    service: "orders",
    endpoint: "Orders.Get",
    message: { header: {}, body: requestBytes }
  },
  withFilter(...filters)
)
```

`Filter`, `filterVersion(...)`, and `filterLabel(...)` belong to the Registry root API. Filters run in declaration order before `Selector.select`. A direct-only client needs only `newClient(withTransport(serviceTransport))`; `withAddress(...)` bypasses Discovery and Selector. A Discovery-backed client lazily opens one watcher per service and selects from its latest complete snapshot. Once replay is known to be idempotent or explicitly approved, `withRetry(...)` configures bounded attempts, failure classification, and optional backoff; each admitted retry selects again from the latest snapshot. Calls make exactly one attempt by default. Call `client.close(ctx)` when the client is no longer used. `closeTimeout(...)` only bounds logical Transport Client cleanup. Physical connection reuse belongs to the Transport and runtime.

`@likego/server` maps handlers to the Transport and exposes the actual bound address. Its construction options are `transport(...)`, `address(...)`, `handler(service, endpoint, fn)`, `middleware(...)`, and `listenOption(...)`; the last one passes provider-specific `ListenOption` values to `Transport.listen`. `endpoint(ctx)` shares the real bind used by `start(ctx)`. A Core App configured as `newApp(registrar(registry), server(serviceServer))` publishes and withdraws that endpoint as the application `ServiceInstance`.

Each unary attempt injects client-side `TransportInfo` with the actual target, stable `service/endpoint` operation, and real wire headers into the Context passed to Transport. The Server injects the corresponding server-side value before invoking a business handler. Client and Server encode multi-value Context metadata through the bounded canonical `Likego-Metadata` envelope; Transport providers carry it as an opaque Message header. `propagateToClientContext(...)` copies server metadata downstream only through an explicit `exact` or `prefix` allowlist.

The common transport SPI follows the same roles as go-micro: `Transport`, `Client`, `Listener`, and `Socket`. `@likego/transport-http` implements both client and server directions over a standard Fetch wire. A response is returned directly only after owned feedback and logical Transport Client close complete. If the exchange completed but either post-step fails, a native `AggregateError` keeps the response in `cause`, ordered feedback/close failures in `errors`, and is never retried.

# HTTP and Buf gRPC Transport Alignment Design

Date: 2026-08-30

Status: revised after implementation review

Implementation/evidence checkpoint (2026-09-23): the public API is implemented in this checkout,
but the acceptance list below is a required behavior list, not a claim that every runtime gate passes.
Connect 2.1.2 cancellation can retain a deadline timer; Bun 1.4.2 Fetch cancellation and
Deno 2.9.5/2.9.7 HTTP/2 graceful drain have documented limitations. See the
[package README](../../../packages/transport/grpc-buf/README.md) and
[current claim ledger](../../../doc/reference/claims.md). Runtime defects are documented without library workarounds.

## 1. Goal

LikeGo HTTP/internal unary transport and Buf-backed gRPC use the same developer workflow:

```text
newClient(options...) -> newXClient(client)
newServer(options...) -> registerXHandler(server, implementation) -> App lifecycle
```

The workflow is shared. The wire-level client, registrar, streaming, connection, and listener types remain protocol-specific.

This design supersedes proposed `connection` / `conn` variables, `newClientTransport`, `newServiceTransport`, and construction-time `handler(...)` registration.

## 2. Scope and non-goals

### In scope

- Move the Buf runtime package to `packages/transport/grpc-buf` and publish it as `@go-like/transport-grpc-buf`.
- Integrate local Buf / Protobuf-ES generation and the official Connect-ES client and server runtime.
- Keep the existing portable Fetch handler for Connect and gRPC-Web unary and server-streaming.
- Add a managed standard-gRPC HTTP/2 client and server at the capability subpath `@go-like/transport-grpc-buf/native` using `@connectrpc/connect-node`.
- Use one Selector path for direct and discovered snapshots, and reuse one resident discovery resolver for Discovery only.
- Change the common HTTP/internal unary Client to construction-time single/multi-address routing.
- Change the common HTTP/internal unary Server to pre-start `registerXHandler` registration.
- Generate ctx-first handler glue and client glue with `client` and `server` parameter names.

### Out of scope

- Buf Schema Registry, remote plugins, generated SDK hosting, breaking-change services, or any other Buf online service.
- Reimplementing protobuf encoding, gRPC framing, Connect routing, stream state machines, trailers, or HTTP/2.
- Google `@grpc/grpc-js` integration. If needed, it is a separate `grpc-google` transport package.
- Reflection, health, validation, and canonical error-details mapping in this change. Health will use the official gRPC health proto when scheduled.
- A universal wire registrar shared by Struct HTTP and protobuf gRPC.
- Per-call address overrides or per-call service overrides.

## 3. Reference model

The target follows the construction and registration order used by Kratos and go-micro:

| Concern | Kratos | go-micro | LikeGo target |
| --- | --- | --- | --- |
| Create protocol owner | `http.NewClient` / `grpc.NewClient`, `http.NewServer` / `grpc.NewServer` | `client.NewClient`, `server.NewServer` | `newClient(options...)`, `newServer(options...)` |
| Generated client | `NewXHTTPClient(client)` / `NewXClient(client)` | `NewXService(name, client)` | `newXClient(client)` |
| Generated registration | `RegisterXHTTPServer(server, impl)` / `RegisterXServer(server, impl)` | `RegisterXHandler(server, impl)` | `registerXHandler(server, impl)` |
| Lifecycle | start after registration | start after registration | App starts after registration |

Like Kratos, HTTP and gRPC share the workflow but not the concrete registrar ABI.

## 4. Developer experience

All long-lived call owners are named `client`. Generated factories also name their parameter `client`.

### 4.1 HTTP/internal unary direct client

```ts
const client = newClient(
  withTransport(newHTTPTransport()),
  withAddress("https://orders-a.internal")
)

const orders = newOrderServiceClient(client)
const order = await orders.getOrder(ctx, { id: "order-1" })
await client.close(ctx)
```

### 4.2 HTTP/internal unary direct multi-address client

```ts
const client = newClient(
  withTransport(newHTTPTransport()),
  withAddress(
    "https://orders-a.internal",
    "https://orders-b.internal"
  ),
  withSelector(newRoundRobinSelector())
)

const orders = newOrderServiceClient(client)
```

### 4.3 HTTP/internal unary discovery client

```ts
const client = newClient(
  withTransport(newHTTPTransport()),
  withService("orders-http"),
  withDiscovery(discovery),
  withSelector(newRoundRobinSelector())
)

const orders = newOrderServiceClient(client)
```

`withService("orders-http")` is the Registry service identity for this wire. It is intentionally independent of an endpoint contract or protobuf descriptor name.

### 4.4 HTTP/internal unary server

```ts
const server = newServer(
  transport(newNodeHTTPTransport()),
  address("0.0.0.0:9000"),
  advertise("orders.internal:9000")
)

registerOrderServiceHandler(server, orderService)
```

HTTP service glue is application-owned, as in the handwritten example below. The included
`protoc-gen-like` generates protobuf/Connect glue only; identical factory names do not make
the HTTP and protobuf client or registrar types interchangeable:

```ts
export function registerOrderServiceHandler(
  server: HandlerRegistrar,
  handler: OrderServiceHandler
): void {
  server.registerHandler(
    getOrderEndpoint,
    (ctx, request) => handler.getOrder(ctx, request)
  )
}
```

The closure preserves `this` for class-backed implementations. One-off tests may call `server.registerHandler(...)` directly.

### 4.5 Standard gRPC direct and discovery clients

```ts
import {
  newClient,
  withAddress
} from "@go-like/transport-grpc-buf/native"

const client = newClient(
  withAddress("https://orders.internal")
)

const orders = newOrderServiceClient(client)
```

```ts
const client = newClient(
  withService("orders-grpc"),
  withDiscovery(discovery),
  withSelector(newRoundRobinSelector())
)

const orders = newOrderServiceClient(client)
```

The managed backend client always uses standard gRPC over HTTP/2. Browser and Edge callers keep using an official Connect-ES or gRPC-Web `Transport` directly with the same generated `newXClient(client)` factory.

### 4.6 Managed gRPC server

```ts
import {
  address,
  advertise,
  newServer
} from "@go-like/transport-grpc-buf/native"

const server = newServer(
  address("0.0.0.0:9000"),
  advertise("orders.internal:9000")
)
registerOrderServiceHandler(server, orderService)
```

The managed server uses the official Connect Node adapter on a native HTTP/2 host and serves standard gRPC only. Node is supported by upstream Connect-ES. Bun and Deno are LikeGo-owned pinned-version compatibility targets, not upstream-supported targets, and keep the same `/native` API through continuing interoperability tests. The subpath is capability-specific, not runtime-specific; there are no `/node`, `/bun`, or `/deno` APIs.

## 5. Common HTTP/internal unary Client changes

The common Client owns one immutable addressing source.

```ts
export interface ClientOptions {
  readonly addresses: readonly string[]
  readonly service: string | null
  readonly discovery: Discovery | null
  readonly selector: Selector | null
  // existing transport, block, middleware, retry and pool fields remain
}

export function withAddress(...addresses: readonly string[]): ClientOption
export function withService(service: string): ClientOption
```

Rules:

1. `withAddress()` requires at least one non-empty, well-formed, duplicate-free transport address. The generic Client does not reinterpret provider-specific addresses; HTTP and gRPC providers use absolute `http://` or `https://` URLs.
2. Direct addresses and `withDiscovery()` are mutually exclusive.
3. Discovery requires exactly one non-empty `withService()` value.
4. `withService()` without Discovery is rejected at `newClient()` construction.
5. Either direct or discovery snapshots flow through the same `Selector`; absent an explicit Selector, both use the existing round-robin Selector.
6. `withAddress` is removed from `CallOption`. `CallOptions.address` is removed.
7. Per-call filters and retries remain, but cannot replace the addressing source.
8. Pools remain keyed by the selected provider address.

No compatibility alias is retained. The package version is `0.0.1`, and a second address path would preserve the ambiguity this change removes.

## 6. Shared Discovery resolver

The existing resident watcher implementation stays owned by `@go-like/client` and becomes a supported `@go-like/client/discovery` subpath consumed by both client owners. Moving it into `@go-like/registry` would create a dependency cycle because Core already depends on Registry and the resolver uses Core's Context-bounded wait helper. A second implementation is not added.

```ts
export interface DiscoveryResolver {
  getService(
    ctx: Context,
    name: string,
    block?: boolean
  ): Promise<readonly ServiceInstance[]>

  close(ctx: Context): Promise<void>
}

export function newDiscoveryResolver(discovery: Discovery): DiscoveryResolver
```

There is one watcher cache, retry loop, replacement-snapshot rule, and close implementation. No second gRPC-specific watcher is added.

### 6.1 Discovery protocol identity

The first release requires each Registry service identity to be protocol-homogeneous. A Discovery snapshot for `orders-http` contains only HTTP/internal-unary endpoints; a snapshot for `orders-grpc` contains only standard-gRPC endpoints. An application that exposes both wires uses separate App registrations and corresponding `withService(...)` values. Different publishers reusing one service name for different protocols is an unsupported deployment configuration; first-release clients assume each discovered snapshot is homogeneous and do not add a protocol filter.

This is enforced before Registry publication. Core `Endpointer` requires a synchronous `protocol(): string` discriminator in addition to the directly dialable `endpoint(ctx)`. The common Server returns its selected Transport `kind()` (`"http"`, `"memory"`, or another provider kind); a missing or empty kind throws `TypeError`. The managed standard-gRPC Server returns `"grpc"`. When Core builds one `ServiceInstance`, it first synchronously and unconditionally preflights every configured Endpointer protocol, then rejects a missing, empty, or second distinct value. Only after that guard may it conditionally call asynchronous `endpoint(ctx)` methods when no explicit endpoint snapshot exists. This preflight still runs when App `endpoint(...)` options were supplied, and it completes before `Registrar.register()`. An explicit-only App with no Endpointer supplies a caller-trusted homogeneous snapshot. Official LikeGo Endpointers must implement the method; it is not inferred from a URL.

This is the minimal replacement for Kratos's logical `http://` / `grpc://` resolver schemes while keeping LikeGo endpoints directly dialable `http://` / `https://` URLs. `protocol()` is a local Core publication guard, not an address scheme and not Registry metadata: it guarantees only that one App-generated `ServiceInstance` does not mix its Endpointers. It cannot police arbitrary external Registrar calls or two independent publishers that reuse the same service name. The implementation does not infer a wire from a port, array order, pathname, or a failed call. Cross-publisher protocol metadata/filtering is outside this first release.

## 7. Common HTTP/internal unary Server changes

`@go-like/server` adds a narrow synchronous registrar:

```ts
export interface HandlerRegistrar {
  registerHandler<Request extends Struct, Response extends Struct>(
    endpoint: Endpoint<Request, Response>,
    handler: TypedHandler<Request, Response>
  ): void

  registerHandler(
    service: string,
    endpoint: string,
    handler: Handler
  ): void
}

export interface Server extends CoreServer, Endpointer, HandlerRegistrar {
  protocol(): string
  endpoint(ctx: Context): Promise<string>
  options(): ServerOptions
  string(): string
}
```

Registration state is:

```text
newServer -> registration open -> first endpoint/start -> sealed -> running/stopped
```

Rules:

1. `newServer()` allows zero handlers.
2. `registerHandler(...)` validates and installs one handler synchronously.
3. Duplicate service/endpoint registration throws synchronously.
4. The first `endpoint()` or `start()` seals registration before its first asynchronous boundary and before listener I/O.
5. Sealing rejects an empty handler table and any `httpRoute(...)` whose target was not registered.
6. Sealing snapshots and composes the dispatcher exactly once.
7. Registration after sealing throws synchronously, including after a failed bind.
8. The exported `handler(...)` ServerOption and `ServerOptions.handlers` are removed without aliases.

`Endpoint` already contains enough metadata for typed unary registration. It does not contain HTTP method/path metadata, so `httpRoute(...)` remains explicit. The superseded `ServiceDeclaration` is not restored.

## 8. Generated protobuf API

Generated handler glue depends only on the registrar operation it uses:

```ts
export type ServiceRegistrar = Pick<ConnectRouter, "service">

export function registerOrderServiceHandler(
  server: ServiceRegistrar,
  handler: OrderServiceHandler
): void {
  server.service(OrderService, {
    getOrder: (request, context) =>
      handler.getOrder(fromHandlerContext(context), request)
  })
}
```

Generated client glue uses `client` for the borrowed Connect transport and `stub` for the upstream client:

```ts
export function newOrderServiceClient(
  client: ConnectTransport
): OrderServiceClient {
  const stub = createClient(OrderService, client)
  // ctx-first adapters delegate to stub
}
```

The generator does not create a network connection, close resources, select an address, or implement a protocol.

The generated file imports `callOptions`, `fromHandlerContext`, and the `ServiceRegistrar` type from the portable package root. That root has no static or transitive import of `@connectrpc/connect-node` or `node:*`. Managed owners live only at `@go-like/transport-grpc-buf/native`, so browser and Edge bundles can import generated glue and the portable handler without resolving Node built-ins.

## 9. Buf gRPC Client owner

The managed client is a structural Connect-ES `Transport` plus LikeGo cleanup:

```ts
export interface Client extends ConnectTransport {
  close(ctx: Context): Promise<void>
}

export function newClient(...options: readonly ClientOption[]): Client
export function withAddress(...addresses: readonly string[]): ClientOption
export function withService(service: string): ClientOption
export function withDiscovery(discovery: Discovery): ClientOption
export function withSelector(selector: Selector): ClientOption
export function withBlock(): ClientOption
export function withTLSConfig(config: TLSConfig | null): ClientOption
```

Native addresses canonicalize to an absolute root `http:` or `https:` base URL. Credentials, query, fragment, and non-root path prefixes are rejected before I/O. The canonical origin is the session-manager key, so semantically identical URLs do not create duplicate managers.

For each selected address, the owner lazily creates exactly one upstream `Http2SessionManager`. `createGrpcTransport()` receives a private terminal structural adapter around that official manager, not a second manager or pool. The adapter gates and tracks `request()` acquisition: after close begins it rejects new requests, re-aborts after any late inner fulfillment/rejection, and closes/resets a late stream before rejecting it. This prevents the official manager's internal destroyed-session retry from leaving a reconnected idle session after owner close. Concurrent RPCs still share the one official manager and HTTP/2 session.

Connect's `Transport` methods do not receive a Like Context directly. The runtime therefore owns one private `ContextKey<Context | null>`. `callOptions(ctx, overrides)` overlays the original Like Context into Connect `contextValues` while preserving every caller-provided Connect value. The managed Transport combines the carried Context with any additional raw signal/timeout into one call-scoped Context for Discovery, Selector, network work, and `SelectionDone`; the remaining budget is not reset after selection. Raw Connect clients that omit the key receive a minimal private Like Context derived from the supplied signal and timeout; arbitrary Like values are intentionally unavailable in that fallback. No public Context option is added.

Unary selection feedback completes when the unary Promise settles. Every streaming call owns a private AbortController linked with caller and owner signals. Streaming feedback completes exactly once when the raw Transport response's output `AsyncIterable` completes, throws, is canceled, receives `return()` / `throw()`, or the Client closes; returning the initial `StreamResponse` is not completion. The explicit AsyncIterator wrapper aborts the per-call controller before completing `return()` or `throw()`, even before the first `next()`, and delegates an upstream method only when it exists. An async generator alone is insufficient because pre-first-`next()` return skips its body and `finally`. Connect-ES's promise client intentionally omits downstream `return()` / `throw()` for server and bidi streams, so generated-client callers cancel the supplied Like Context when they stop consumption early; LikeGo does not fork that upstream client runtime.

TLS and mTLS reuse LikeGo's portable `TLSConfig` through `withTLSConfig(config)`. The adapter requires PEM material for the current Node-compatible HTTP/2 runtime, requires certificate and private key together, and passes CA, certificate, key, and server name into the upstream session manager. No raw socket, pool, or Node TLS type appears in the public API.

`close(ctx)` atomically rejects new RPCs and prevents new managers, aborts the owner signal and every terminal manager adapter, starts resolver close exactly once, and waits for active unary/stream wrappers plus admitted inner manager acquisitions so selection feedback completes exactly once. After asynchronous Discovery/selection and before retrieving or creating an address owner, the Client rechecks the terminal state. `Http2SessionManager.abort()` is not treated as an owner state—it can reconnect—so the private adapter repeatedly terminates any late retry result. The caller Context bounds only that caller's wait; owner cleanup continues after a canceled or expired close wait.

## 10. Buf gRPC Server owner

The managed Server implements the Core `Server`, `Endpointer`, and the narrow protobuf `ServiceRegistrar`.

```ts
export function newServer(...options: readonly ServerOption[]): Server
export function address(value: string): ServerOption
export function advertise(value: string): ServerOption
export function tlsConfig(value: TLSConfig | null): ServerOption
export function clientAuth(value: "none" | "require"): ServerOption
```

Rules:

1. Default bind address is `127.0.0.1:0`.
2. Service registration is synchronous and allowed only before the first `endpoint()` or `start()`.
3. Empty, duplicate, and late registration fails before listener I/O.
4. `endpoint()` and `start()` share one bind.
5. The advertised endpoint is a directly dialable `http://` or `https://` URL. No `grpc://` or `grpcs://` conversion exists. A wildcard bind requires a non-wildcard `advertise(...)`; a host-only advertise value retains the actual ephemeral bound port.
6. `stop(ctx)` atomically stops admission, calls `server.close()` plus `session.close()` for every tracked HTTP/2 session, drains active streams, and is idempotent. A session admitted during the close race is closed immediately. If the stop Context expires, only then does the owner abort the adapter shutdown signal and call `session.destroy()` on remaining sessions; owner shutdown continues even if that caller stops waiting.
7. Server TLS requires a PEM certificate chain and private key. `clientAuth("require")` additionally requires a PEM CA certificate and enforces client-certificate verification. h2c rejects TLS/client-auth configuration, client identity requires certificate/key together, DER is rejected, and `serverName` is used only by the client for SNI/verification.
8. The official `connectNodeAdapter({ routes, grpc: true, connect: false, grpcWeb: false })` receives the sealed routes through a fresh mutable adapter-call object because Connect Node 2.1.2 installs `acceptCompression` in place. Public LikeGo option snapshots remain frozen. LikeGo does not implement protocol dispatch or framing.
9. `protocol()` returns the stable publication discriminator `"grpc"`; it does not alter the `http://` / `https://` endpoint.
10. Every replayed service registration spreads caller service options and then privately forces `grpc: true`, `grpcWeb: false`, and `connect: false`. This version-pinned guard is required because Connect 2.1.2 otherwise re-enables Connect and gRPC-Web whenever `service(...)` receives an options object; it is not exposed through LikeGo's public registrar type.

The existing `newHandler(routes)` remains the portable Fetch entry and accepts a callback whose parameter is named `server` and typed as `ServiceRegistrar`.

## 11. Promise and streaming handler types

New and generated async APIs use native `Promise` and do not expose broad structural thenable declarations.

- Unary handler: `Response | Promise<Response>`.
- Server streaming: `AsyncIterable<Response>`.
- Client streaming: `Promise<Response>`.
- Bidirectional streaming: `AsyncIterable<Response>`.

`AsyncIterable` is retained because it is the language-level pull/cancel contract needed for streaming messages. It is not a custom gRPC abstraction.

The repository-wide native `Promise` migration and Core lifecycle classification are separate plans; this transport plan must not opportunistically rewrite unrelated packages. The native `Promise` migration is completed separately.

## 12. Acceptance gates

### HTTP/internal unary

- Construction-time single address works.
- Multiple direct addresses use the selected `Selector`.
- Direct plus Discovery, Discovery without service, and no addressing source fail at construction.
- No public per-call address override remains.
- Server construction without handlers succeeds; empty seal fails before `listen()`.
- Typed and raw registration work over Memory and Node HTTP transports.
- Duplicate and late registration fail synchronously.
- `endpoint()` and `start()` share one sealed dispatcher and one bind.
- Every `httpRoute` target is checked before bind.

### Generated glue

- Snapshots contain `registerXHandler(server, handler)` and `newXClient(client)`.
- Generated client uses a non-shadowing `stub` local.
- Generated registration accepts a narrow `ServiceRegistrar` and works with both the portable handler and managed server.

### Buf runtime

- The portable root imports in a browser/Edge bundler without resolving `node:*`; managed owners are exported only by `/native`.
- Portable Fetch unary and server-streaming pass on Node, Bun, and Deno.
- Standard gRPC unary, server-streaming, client-streaming, and bidi pass on Node, Bun, and Deno.
- `buf curl --protocol grpc` calls each runtime server independently of the managed Client.
- Direct multi-address and Discovery selection both produce feedback.
- Core rejects HTTP/internal plus standard-gRPC Endpointers in one App-generated Registry `ServiceInstance`; separate service identities publish and select the intended wire. Cross-publisher name reuse is explicitly unsupported.
- Blocking Discovery cancellation, custom Like Context in a Selector, raw Connect fallback, and caller Connect `contextValues` preservation are covered.
- Concurrent RPCs to one address share one session manager.
- Client/server close is idempotent, prevents resource resurrection, completes feedback for an active bidi call, and remains owned after a close/stop wait expires.
- A deterministic manager abort/retry race ends terminally with every late stream closed and no idle reconnected session.
- Raw stream `return()` and `throw()` before first `next()` abort the upstream call signal and complete feedback once; generated server/bidi early-stop uses Like Context cancellation on Node, Bun, and Deno.
- Wildcard advertise and ephemeral-port substitution are verified before Registry publication.
- Invalid native URL, incomplete PEM identity, DER, h2c-with-TLS, and required-client-auth-without-CA fail before I/O.
- For each pinned Node, Bun, and Deno server runtime, a trusted mTLS client succeeds; a client without a certificate and a client signed by an untrusted CA both fail before the handler runs.

### Repository

- Package exports, workspace lists, staged package fixtures, canonical docs, examples, type checks, tests, builds, and `bun run verify` use the portable `@go-like/transport-grpc-buf` root and the managed `@go-like/transport-grpc-buf/native` subpath correctly.
- No Buf online configuration or dependency is introduced.
- No `handler(...)` ServerOption or per-call `withAddress(...)` remains.
- No code is committed, pushed, published, or deployed without separate authorization.

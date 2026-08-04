# go-like compared with other tools

A fair comparison starts with ownership, not with a feature-count checklist. NestJS, Fastify, Hono, Elysia, Koa, and tRPC solve different parts of the TypeScript application stack. go-micro and go-kratos are Go framework references with different transport and code-generation choices. go-like is a TypeScript building-block set for explicit lifecycle, internal unary calls, provider contracts, and cross-runtime composition.

This page separates evidence levels:

- **Source** means the current go-like checkout exposes the stated API or boundary.
- **Pinned external** means the comparison uses the release, commit, or official documentation recorded in the research ledger. It is not a fresh benchmark or a claim that an unpinned `main` branch is unchanged.
- **Declared** means a repository example or test lane exists. It is not a pass result.
- **Gap** means the current repository does not prove a compatibility commitment.

The current go-like source baseline for this track is commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. The local research record contains a go-micro commit discrepancy: one comparison record names `9d306dcfc1a912a8a9493f31fee0bb983475258d`, while the detailed fixed-version memo inspected go-micro `v6.9.0` at `3c39d17fadaa9ec21b671be4afef3e63846406e6`. Treat those as comparison inputs to recheck, not as a current upstream guarantee.

## Position in the stack

| Tool      | Primary problem                              | What it normally owns                                                                                                                                                        | What go-like would complement, not replace                                                                               |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| NestJS    | Convention-driven Node application framework | Modules, providers, controllers, decorators, application context, framework lifecycle, HTTP or microservice adapter                                                          | A structural lifecycle boundary or internal call contract around a native application, if an explicit bridge is written |
| Fastify   | Node HTTP server and request pipeline        | Route table, hooks, plugins, encapsulation, Node listener, request/reply objects                                                                                             | A lifecycle or provider adapter around a Fastify-owned resource                                                         |
| Hono      | Web Standards routing and middleware         | Routes, middleware, sub-apps, `app.fetch`, runtime adapter choice                                                                                                            | Core App, explicit resource lifecycle, internal Client/Transport, discovery                                             |
| Elysia    | Bun-first typed Web framework                | Route tree, schema composition, decorators, hooks, Bun or Web Standard adapter                                                                                               | Core lifecycle and internal service building blocks while retaining native Elysia behavior                              |
| Koa       | Minimal Node middleware kernel               | Middleware stack and Node listener; router is usually external                                                                                                               | Lifecycle and internal service contracts without introducing another router                                             |
| tRPC      | Type-safe procedure layer                    | Router/procedure paths, input/output parsers, context factory, HTTP/Fetch/WS adapters                                                                                        | Provider ownership, service discovery, selector policy, explicit App lifecycle                                          |
| go-micro  | Go microservice and agent-oriented ecosystem | Go Context, service/client/transport/registry/broker abstractions, provider ecosystem, and additional agent/flow/MCP/A2A scope                                               | go-like borrows some vocabulary, not Go ABI, goroutines, or transport compatibility                                      |
| go-kratos | Go cloud-native service framework            | App lifecycle, Go Context, HTTP/gRPC transports, middleware, registry, config, Protobuf/code generation                                                                      | go-like shares explicit lifecycle vocabulary but intentionally chooses TypeScript/Web APIs and no gRPC/IDL               |
| go-like    | Explicit TypeScript service building blocks  | Context, App/Server lifecycle, standard Fetch edge, internal unary Message transport, Client/Server, Registry/Discovery/Selector, Config/Store/Cache/Broker/Health, adapters | The application still owns framework routes, native data planes, business policy, auth, and deployment                  |

The project is therefore not trying to win a “largest framework” comparison. Its question is whether an application needs these boundaries to be explicit and composable.

## Ownership matrix

| Concern                 | NestJS                                         | Fastify                             | Hono / Elysia / Koa                                          | tRPC                                            | go-like                                                                        |
| ----------------------- | ---------------------------------------------- | ----------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| External route table    | Controllers and decorators                     | Fastify instance                    | Framework instance or external router                        | Procedure router, not ordinary REST routes      | External framework or application                                             |
| Web handler ABI         | Adapter-owned request/reply abstraction        | Node request/reply                  | Standard Fetch is central for Hono and Web Standard adapters | Fetch/Node/Express/Fastify adapters             | Standard `(Request) => Response \| Promise<Response>`                         |
| Application lifecycle   | Application context and hooks                  | `ready`, `listen`, `close`, hooks   | Runtime adapter and framework lifecycle vary                 | Host/adapter responsibility                     | `newApp`, `App.run`, `App.stop`, hooks, structural Servers                    |
| Resource lifecycle      | Container/framework hooks                      | Plugin and server hooks             | Application/runtime responsibility                           | Application/adapter responsibility              | Explicit `Server.start(ctx)` / `stop(ctx)` contracts and adapter ownership    |
| Dependency composition  | Nest container/providers                       | Plugin decoration and encapsulation | Context/env and composition; no general DI container         | Explicit context factory and router composition | Explicit constructors and functional options; no DI container                 |
| Internal transport      | Microservice transports and framework adapters | Not a service discovery abstraction | Not a service discovery abstraction                          | Procedure adapters and optional WebSocket       | `Transport`, `Client`, `Listener`, `Socket`, unary `Message`                  |
| Discovery and selection | Transport-specific or external                 | External                            | External                                                     | External                                        | `Registry`, `Discovery`, `Watcher`, Filters, five Selector policies           |
| Retry                   | Framework or provider-specific                 | Application/plugin-specific         | Application-specific                                         | Middleware/adapter-specific                     | One attempt by default; `withRetry` requires authorization and total attempts |
| Streaming               | Framework/provider choices                     | Node/Web stream choices             | Native Web Streams and framework APIs                        | Adapter-dependent HTTP/WS                       | Public Web streaming is native; internal RPC remains unary                    |
| Global instrumentation  | Framework/provider integration                 | Plugin ecosystem                    | Middleware ecosystem                                         | Middleware/adapters                             | Explicit wrappers; no global provider installation                            |

The labels in the first five rows describe architecture positions, not a quality ranking. A framework owning a route table is useful when route composition is the problem. It is simply a different ownership decision from go-like leaving routes to the application.

## Lifecycle and Context

Current go-like source defines:

```ts
interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}
```

The `Server` contract is structural. A native worker, listener, scheduler, broker subscription, logger destination, or telemetry provider can join Core if an adapter can state the admission and terminal behavior honestly.

go-like Context is also structural and uses `AbortSignal` internally. It exposes `deadline()`, `done()`, `err()`, and `value(key)`, with constructors such as `background`, `withCancel`, `withCancelCause`, `withTimeout`, `withDeadline`, `withoutCancel`, and `withValue`.

This resembles Go's explicit Context-first style but is not ABI-compatible with `context.Context`. It does not provide goroutines, channels, or gRPC. The correct migration question is “where does cancellation and ownership cross this boundary?” rather than “which type name is identical?”

Core does not promise reverse-order shutdown of sibling Servers. It invokes sibling `stop(ctx)` calls concurrently, then joins terminal `start` Promises and aggregates failures. A Nest application context, Fastify plugin graph, Elysia lifecycle, or host adapter may have different ordering and terminal semantics. Compare the actual owner, not the label “graceful.”

## Transport and service calls

go-like's internal call chain is deliberately decomposed:

```text
Client
  -> Discovery snapshot, optional
  -> ordered Filter callbacks, optional
  -> Selector.select
  -> opaque ServiceEndpoint URL
  -> Transport.dial or resident logical owner
  -> send(Message)
  -> @go-like/server route and unary handler
  -> recv(Message)
  -> feedback and owner release
```

A typed `Endpoint` binds `Struct` request and response validation to the existing `Message` boundary. It is not an IDL or generated protocol. `withAddress(...)` bypasses Discovery and Selector, which makes the in-process Memory Transport path a useful first test.

NestJS's microservice transport options, tRPC procedure adapters, and Go framework transports are not interchangeable with this DAG. They may own a different route identity, serialization model, connection pool, or retry layer. A comparison should record those differences rather than mark all “RPC” boxes as equal.

## Retry and streaming scope

The most important negative comparison is about semantics:

- go-like calls make exactly one attempt by default.
- `withRetry(...)` requires `authorization: "idempotent" | "caller-approved"`, a positive `maxAttempts`, and `shouldRetry`.
- The authorization is a caller declaration, not a proof of idempotency.
- A retry may select a new endpoint because each attempt re-enters discovery and selection.
- A response that has already been received but is followed by feedback or cleanup failure is not replayed.

The Go comparison research records different defaults and capabilities: go-micro `DefaultRetries` is not a simple “five total requests” statement because its loop boundary can produce six iterations when retry approval remains true; its public stream shape and default `CloseSend` implementation also vary by provider. go-kratos combines Protobuf/gRPC generation with HTTP streaming forms, where SSE and WebSocket have different directions and close behavior. Those are provider and architecture choices, not missing go-like flags.

For go-like:

```text
Web framework or Fetch Handler
  -> Web Streams, SSE, or WebSocket behavior owned by the application/framework

go-like internal Client/Transport
  -> one unary Message request and one unary Message response
  -> no full-duplex RPC Stream SPI
```

A Web `ReadableStream` is not an internal RPC channel. Do not compare a streamed HTTP body with a multi-frame `send`/`recv` transport as if they were the same feature.

## Runtime comparison

| Runtime question                                                      | go-like evidence                                                                                             | Comparison consequence                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Can shared code use Fetch and `AbortSignal`?                          | Root Web and selected transport/config providers use standard Web APIs or injected Fetch                    | Similar portability goals are possible, but types do not polyfill runtime behavior |
| Can the same package bind a Node listener and Deno listener?          | Runtime-specific subpaths are explicit; `@go-like/web/node` and `@go-like/transport-http/node` are Node paths | Do not write “all packages run unchanged everywhere”                               |
| Can custom PEM TLS, mTLS, ALPN, and HTTP/2 be portable through Fetch? | Node transport subpath owns native behavior; root Fetch path does not expose all controls                   | Compare host capabilities and import paths, not only package names                 |
| Does the application keep the framework router?                       | Hono, Elysia, and H3 examples pass native Fetch handlers                                                    | go-like is complementary to framework route ownership                               |
| Does package version prove publication?                               | Root and packages are private/workspace `0.0.1`; repository docs say not yet published                      | No npm availability or ecosystem maturity claim                                    |

The current repository contains direct source examples for Hono, Elysia, H3, and vanilla Fetch. It does not contain a current NestJS or Fastify bridge or compatibility suite. Those are migration audiences, not supported direct integrations.

## Detailed comparison by tool

### NestJS

NestJS is a convention-driven application framework. Its modules, providers, controllers, decorators, interceptors, pipes, and application hooks form a coherent container and request model. go-like does not provide a Nest-compatible module container or controller bridge.

A sensible integration boundary is an application-owned adapter that implements go-like's structural `Server` around a Nest application or host. The adapter would need to define when Nest has admitted the listener, how `stop(ctx)` maps to Nest close, and what happens after a timeout. The current repository does not prove such a bridge, so documentation must not show a direct `newNodeServer(nestApp, ...)` call.

### Fastify

Fastify owns a route table, plugin encapsulation, hooks, and a Node listener. Its plugin graph is a useful comparison for dependency scope, but `decorate` is not a Nest-style general provider container. go-like does not convert Fastify's `request`/`reply` ABI into a Fetch Handler automatically, and no current Fastify bridge is tested in the repository.

Keep Fastify routes and plugins native. If go-like is adopted, write an explicit structural Server around the Fastify owner or expose a separately implemented Fetch boundary. Do not call Fastify's own request injection or native shutdown a go-like Transport or Client contract.

### Hono

Hono is the clearest demonstrated complement. The current example creates routes in Hono, passes `app.fetch` to `newNodeServer`, and puts that host into a Core App. The route and middleware ownership stays with Hono; go-like owns the host lifecycle boundary when the application chooses it.

### Elysia

Elysia provides a Bun-first route and schema composition model and also exposes a Web Standard handler in the relevant adapter path. Retain Elysia's route tree, decorators, derives, hooks, streams, and Bun-specific behavior. go-like can own the App and an explicit resource boundary, but it does not make `.listen()` a cross-runtime go-like API.

### Koa

Koa is a small Node middleware kernel and does not bundle a router. That makes it a useful example of a framework that intentionally leaves more application composition outside the core. go-like should not fill that gap by adding a router. Keep Koa middleware and any external router native, then add a lifecycle or internal call boundary only where needed.

### tRPC

tRPC owns a type-safe procedure router and procedure middleware. It can use Fetch, Node, Express, Fastify, or WebSocket adapters, but it is not a Registry, Selector, connection pool, or application lifecycle manager. go-like's typed Endpoint is a smaller runtime Struct binding over unary Messages, not a competing procedure DSL or generated IDL.

### go-micro and go-kratos

These Go projects are useful architectural references for Context-first calls, service lifecycle, Registry, Discovery, Selector, and transport vocabulary. They are not compatibility targets:

- Go `context.Context` and go-like `Context` share explicit cancellation intent but have different runtime representations.
- go-micro's Registry watcher model and go-like's complete replacement snapshots should not be taught as identical event streams.
- go-kratos's Protobuf/gRPC and generated code are an architectural choice that go-like explicitly does not claim.
- go-micro and go-kratos provider defaults, retry loops, stream half-close behavior, and selector defaults are version-specific. Use the fixed upstream commit table in the research record and recheck before publishing a new comparative release.

## What to choose

| If your primary problem is...                     | Start with...         | Add go-like when...                                                                                                      |
| ------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Controllers, modules, decorators, and DI          | NestJS                | You need an explicit boundary around an existing resource or internal service call and are willing to write the adapter |
| Node HTTP routes, hooks, and plugin encapsulation | Fastify               | You need lifecycle composition beyond the host or internal unary service contracts                                      |
| Web Standards routes across runtimes              | Hono                  | You need App/Server lifecycle, internal calls, or provider ownership                                                    |
| Bun-first schema and route composition            | Elysia                | You need explicit lifecycle and transport boundaries while retaining Elysia                                             |
| Minimal Node middleware                           | Koa plus a router     | You need the missing lifecycle or internal call contract, not another router                                            |
| Type-safe procedures                              | tRPC                  | You also need explicit service discovery, provider ownership, or a Core lifecycle                                       |
| Go microservice stack                             | go-micro or go-kratos | You are building a separate TypeScript composition, not a source-compatible port                                        |
| Cross-runtime TypeScript service building blocks  | go-like                | Use only the packages and providers that solve the boundary                                                             |

The right answer may be to use both systems. go-like is most useful when its explicit ownership model removes an actual ambiguity; adding every package to an otherwise complete framework application defeats the small-building-block goal.

## Evidence anchors

The go-like claims in this page can be traced to the current tree and package entrypoints:

- `README.md` for product scope and explicit exclusions;
- `packages/core/src/app.ts` for `App`, `Server`, startup, stop, and timeout behavior;
- `packages/web/src/context.ts` for the standard Handler and Context bridge;
- `packages/client/src/index.ts` for Client options, pooling, retry, and the attempt pipeline;
- `packages/server/src/index.ts` for internal unary handlers and route dispatch;
- `packages/transport/src/types.ts` and `packages/transport/src/endpoint.ts` for the Message and typed Endpoint boundaries;
- `packages/registry/src/types.ts` and `packages/registry/src/selector.ts` for snapshots, filters, selectors, and feedback.

The research record also stores these pinned external comparison inputs:

- [go-micro default-branch comparison commit recorded in the repository](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d);
- [go-micro v6.9.0 fixed-version comparison commit](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6);
- [go-kratos v3 comparison commit](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e);
- [go-zlab/go-kratos comparison commit](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336);
- [NestJS lifecycle documentation](https://docs.nestjs.com/fundamentals/lifecycle-events), [Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/), [Hono API](https://hono.dev/docs/api/hono), [Elysia lifecycle](https://elysiajs.com/essential/life-cycle), [Koa](https://koajs.com/), and [tRPC routers](https://trpc.io/docs/server/routers).

The URLs are comparison references, not a claim that this documentation phase fetched or revalidated every upstream page. Recheck release tags or commits before changing a version-sensitive comparison statement.

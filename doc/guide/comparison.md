# go-like compared with other tools

A fair comparison starts with ownership. NestJS, Fastify, Hono, Elysia, Koa, and tRPC solve different parts of a TypeScript application. go-micro and go-kratos are Go references with different transports and code generation. go-like is a socket panel: explicit lifecycle tiers, internal calls, and plugs for the backends you choose.

Evidence labels on this page:

- **Source** means the current checkout exposes the API.
- **Pinned external** means a recorded release, commit, or official page. It is not a fresh benchmark.
- **Declared** means an example or test exists. It is not a pass result.
- **Gap** means this repository does not prove a compatibility commitment.

The historical documentation baseline is commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. The research record contains two go-micro commits: `9d306dcfc1a912a8a9493f31fee0bb983475258d` and, for the v6.9.0 memo, `3c39d17fadaa9ec21b671be4afef3e63846406e6`. Treat both as inputs to recheck.

## Position in the stack

| Tool      | What it normally owns                                            | What go-like adds beside it                                                   |
| --------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| NestJS    | Modules, controllers, decorators, the application context        | A structural `Server` only if you write that adapter                          |
| Fastify   | Routes, hooks, plugins, the Node listener                        | A lifecycle or call boundary around a resource Fastify still owns             |
| Hono      | Routes, middleware, `app.fetch`                                  | App tiers, internal calls, plugs                                              |
| Elysia    | Route tree, schema, hooks, its own adapter                       | The same, while `.listen()` stays Elysia's                                    |
| Koa       | Middleware and an external router                                | Lifecycle and internal calls, not another router                              |
| tRPC      | Procedures, parsers, adapters                                    | Discovery, selection, and App lifecycle                                       |
| go-micro  | Go Context, service, registry, broker, and a wider agent surface | Vocabulary only. No Go ABI                                                    |
| go-kratos | App lifecycle, HTTP/gRPC, registry, config, Protobuf             | A TypeScript composition. The gRPC path is Connect-ES, not the Google runtime |
| go-like   | Sockets, tiers, Fetch and SSE calls, plugs                       | The application still owns routes, policy, auth, and native protocol details  |

## Ownership

| Concern           | go-like                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| External routes   | The framework or the application `Handler`                                                             |
| Web handler       | `(Request) => Response \| Promise<Response>`                                                           |
| Process lifecycle | `newApp`, three tiers, hooks                                                                           |
| Dependencies      | Constructors and options. No container                                                                 |
| Internal calls    | `Transport`, `Client`, `Server`, `defineService`, SSE `ServerStream`                                   |
| Discovery         | `Registry`, `Discovery`, filters, five selectors                                                       |
| Retry             | One attempt unless `withRetry` authorizes more                                                         |
| Streaming         | Web Streams at the edge; JSON or SSE internally; four gRPC cardinalities on `@go-like/connectrpc/node` |
| Instrumentation   | Core records work units. Plugs fill telemetry sockets. No global registration                          |

## Lifecycle and Context

```ts
import type { Server } from "@go-like/core/lifecycle"

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

type Lifecycle = Server
void null as unknown as Lifecycle
```

`Server` is structural: `start(ctx)` and `stop(ctx)`. On the resource tier, `start` resolves when the resource is usable. On the server tier, `start` may stay pending, and sibling stops run concurrently. Resource stops run in reverse declaration order. A Nest context, a Fastify plugin graph, or an Elysia hook has its own order. Compare owners, not the word "graceful."

Context exposes `deadline()`, `done()`, `err()`, and `value(key)`, with `background`, `withCancel`, `withTimeout`, `withDeadline`, `withoutCancel`, and `withValue`. It uses `AbortSignal` internally. It is not a Go `context.Context` and it is not a gRPC API.

## Calls, retry, and streams

The internal path is Client, optional Discovery, filters, selector, transport, `POST /<service>/<endpoint>`, then the server handler. A typed endpoint validates JSON with Struct. It is not an IDL. `withEndpoint("discovery:///name")` selects a service. A direct address list does not.

Calls make one attempt unless `withRetry` sets `authorization` to `"idempotent"` or `"caller-approved"`, a positive `maxAttempts`, and `shouldRetry`. That authorization is a declaration. A response already received is not replayed when later feedback fails.

```text
Web Handler
  Web Streams, framework SSE, or WebSocket

@go-like/core client and server
  one JSON body, or SSE when stream: true

@go-like/connectrpc
  Connect and gRPC-Web unary and server-streaming on Fetch

@go-like/connectrpc/node
  standard gRPC unary, server-streaming, client-streaming, and bidi
```

go-micro's default retry loop and go-kratos's HTTP streaming forms are version-specific. Recheck the pinned commits before publishing a comparison that depends on them.

## Runtimes

Shared entries use Fetch and `AbortSignal` or an injected capability. Custom TLS, HTTP/2, and mTLS live on `@go-like/core/transport/http/node` and `@go-like/connectrpc/node`. Hono, Elysia, H3, and vanilla Fetch examples pass a Fetch handler to a core host. There is no NestJS or Fastify bridge in this repository. Manifest version `0.0.1` does not establish npm publication.

## By tool

**NestJS.** Modules, providers, and controllers stay Nest's. An integration is an application-owned `Server` around the Nest application, with an explicit admission and close. This repository does not include that adapter.

**Fastify.** Routes, encapsulation, and the listener stay Fastify's. go-like does not convert `request` / `reply` into a Fetch `Handler`.

**Hono.** `examples/hono` passes `app.fetch` to `newNodeServer` and puts that host in `server(...)`. Routes stay in Hono.

**Elysia.** Keep the route tree and Bun-specific behavior. The example uses the Fetch handler with the Node host. `.listen()` is not a go-like API.

**Koa.** Keep the middleware and the external router. Add a lifecycle or call boundary only where you can name the owner.

**tRPC.** Procedures stay tRPC's. A go-like endpoint is a Struct over JSON Fetch, not a procedure router.

**go-micro and go-kratos.** They are references for Context-first calls, lifecycle, and discovery vocabulary. Watchers in go-like yield complete replacement snapshots. The managed gRPC entry is `@go-like/connectrpc/node`.

## What to choose

Use the framework that owns the problem you actually have. Add a go-like socket when the missing piece is admission, cancellation, discovery, or a backend contract with a named owner. Installing every plug into a finished framework application removes the benefit of small contracts.

## Evidence anchors

Current tree:

- `packages/core/src/app/app.ts` and `packages/core/src/app/tiers.ts` for tiers, budgets, and stop order;
- `packages/core/src/lifecycle/index.ts` for `Server` and `Endpointer`;
- `packages/core/src/web/context.ts` for `Handler` and `contextHandler`;
- `packages/core/src/client/index.ts` for call options, discovery, and retry;
- `packages/core/src/server/index.ts` for internal dispatch;
- `packages/core/src/transport/service.ts` for `defineService`;
- `packages/core/src/registry/selector.ts` for filters, selectors, and feedback;
- `packages/connectrpc/src/node.ts` for managed gRPC.

Pinned external inputs, not revalidated by this documentation edit:

- [go-micro comparison commit](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d);
- [go-micro v6.9.0 commit](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6);
- [go-kratos v3 commit](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e);
- [go-zlab/go-kratos commit](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336);
- [NestJS lifecycle](https://docs.nestjs.com/fundamentals/lifecycle-events), [Fastify server](https://fastify.dev/docs/latest/Reference/Server/), [Hono](https://hono.dev/docs/api/hono), [Elysia lifecycle](https://elysiajs.com/essential/life-cycle), [Koa](https://koajs.com/), [tRPC routers](https://trpc.io/docs/server/routers).

Third-party TypeScript versions recorded for comparison, not as compatibility promises: NestJS `@nestjs/core@11.1.28`, Fastify `5.11.2`, Hono `4.12.34`, Elysia `1.4.29`, Koa `3.2.1`, tRPC `@trpc/server@11.18.0`. The Elysia example manifest is the pin for that example; this table is the research snapshot.

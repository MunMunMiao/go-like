# go-like

go-like is a set of small, explicit TypeScript building blocks for backend services that run on Bun, Node.js, and Deno. It gives an application contracts for Context cancellation, application and resource lifecycle, standard Fetch handlers, internal unary service calls, discovery and selection, configuration, stores, caches, brokers, health, resilience, and optional logging and telemetry adapters.

go-like is deliberately complementary to an application framework. Your framework still owns routes, middleware, request policy, Web Streams, WebSocket upgrades, dependency composition, and business behavior. Your provider still owns its native connection, acknowledgement model, lease, retry, or protocol. go-like supplies narrow contracts and lifecycle ownership where those boundaries are useful.

> [!IMPORTANT]
> This checkout is a private `0.0.1` workspace. The repository documentation says the `@go-like/*` packages are not yet published to npm. The examples below use workspace packages and are intended to be run from a checkout unless a published release is independently confirmed.

> [!NOTE]
> The English `doc/` tree is the canonical source for this documentation track. Package source, manifests, and focused tests are the API authority. A test or E2E script that exists in the repository is declared coverage; it is not a passing result until a command has actually run and its exit status has been recorded.

## Choose a path

| Reader                          | Start here                                 | Then read                                                                   | You are ready when                                                                    |
| ------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| New to go-like                  | [Getting started](/guide/getting-started)  | [Architecture](/guide/architecture), [Clinic project](/guide/zero-to-one)   | You can start one Web service, pass a Context, expose health, and stop it             |
| Experienced TypeScript engineer | [Architecture](/guide/architecture)        | [Service calls](/guide/service-call), [Comparison](/guide/comparison)       | You can name the owner and terminal boundary for each resource                        |
| Go or Kratos reader             | [Getting started](/guide/getting-started)  | [Terminology](/reference/terminology), [Service calls](/guide/service-call) | You can map Context and Server concepts without assuming gRPC or Go ABI compatibility |
| Framework user                  | [Comparison](/guide/comparison)            | [Migration](/guide/migration), [Architecture](/guide/architecture)          | You can keep the native router and add only the lifecycle or call boundary you need   |
| Provider or platform engineer   | [Provider reference](/reference/providers) | [Verification](/reference/verification), [Claims](/reference/claims)        | You can state runtime, backend, ownership, and evidence limits for a provider         |

## Canonical learning path

The four-page canonical path under `doc/guide/` is deliberately progressive:

1. [Getting started](/guide/getting-started) runs a standard Fetch Handler, a Node host, an admission signal, and one Core App.
2. [Clinic Appointment Booking](/guide/zero-to-one) turns the lifecycle into a concrete domain, internal unary call, cache, health, test, and shutdown exercise.
3. [Comparison](/guide/comparison) explains where go-like differs intentionally from NestJS, Fastify, Hono, Elysia, Koa, tRPC, go-micro, and go-kratos.
4. [Migration](/guide/migration) shows how to add one ownership boundary at a time while leaving the existing data plane in place.

[Provider reference](/reference/providers) is the separate reference track for package families, runtime paths, ownership, and backend limits.

## The mental model

The smallest useful model has five nouns:

- **Context** is the explicit first argument for cancellable work. It carries a deadline, an `AbortSignal`-style cancellation result, an optional cause, and values.
- **Server** is a structural lifecycle object with `start(ctx)` and `stop(ctx)`. It owns one admitted resource boundary.
- **App** composes Servers, hooks, registration, startup admission, and graceful shutdown. It does not become a dependency-injection container.
- **Handler** is the standard Web function `(Request) => Response | Promise<Response>`. A Handler is not, by itself, a listening server.
- **Endpoint** is a named typed internal operation. It is distinct from a network address such as `memory://pricing` or `https://pricing.example`.

The external Web and internal service planes are separate:

```text
External Web request
  Request
    -> framework router or application handler
    -> @go-like/web Handler
    -> Web host, such as @go-like/web/node
    -> @go-like/core App / Server lifecycle

Internal unary call
  @go-like/client
    -> Discovery, Filter, Selector, or direct address
    -> @go-like/transport Client
    -> Message send / recv
    -> @go-like/server unary handler
    -> response Message
```

## What go-like intentionally does not own

The current product boundary does not claim:

- gRPC, Protobuf, IDL files, generated RPC clients, or generated server stubs;
- an internal full-duplex RPC stream API, half-close protocol, frame model, or backpressure contract;
- an external router or framework-specific middleware DSL;
- a global dependency-injection container or service locator;
- automatic JWT, OAuth, OIDC, claims, ACL, or application authorization;
- an Event Store, history query, replay engine, or universal durable message settlement model;
- automatic global OpenTelemetry providers, exporters, context managers, or instrumentation;
- a distributed, durable, or cross-process meaning for memory providers;
- npm publication, production adoption, hosted CI status, or a production-readiness guarantee merely from a manifest or script.

Public Web streaming remains standard Fetch `Request`/`Response` and Web Streams. It is not internal full-duplex RPC. See [Streaming](/guide/streaming) for the boundary.

## Public inventory

The current source manifests contain **43 non-private `@go-like/*` packages**, all at version `0.0.1` in this checkout, plus **23 public source subpaths**. `@go-like/struct` is part of that public inventory and is the runtime contract used by typed `Endpoint` calls. Generated `dist/package.json` metadata exports are not additional packages or source APIs.

Use the [package reference](/reference/packages) to choose a contract or provider, and the [provider reference](/reference/providers) to compare backend and runtime semantics. The [claims ledger](/reference/claims) records the evidence level behind public wording.

## Verification boundary

The repository contract audit reported these local results on the documentation baseline commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`: `bun run typecheck`, `bun run test:unit`, and `bun run fmt:check` passed, covering the root, packages, examples, and the declared unit-test scope. That report counted 2,736 unit tests, 1,514 formatted files, and a successful import audit for 66 declared source export entries.

That report did **not** establish `build`, `doc:build`, Docker provider E2E, cross-runtime execution, published tarball consumers, npm publication, hosted CI, production adoption, or the 60-minute soak. Read [Verification](/reference/verification) before turning a source or script claim into a release claim.

## Next steps

- [Getting started](/guide/getting-started): install or use a checkout, run a Web handler, and understand the first lifecycle checkpoint.
- [Architecture](/guide/architecture): study planes, ownership, Context scopes, lifecycle order, and runtime portability.
- [Clinic Appointment Booking](/guide/zero-to-one): follow one concrete business invariant from HTTP request to internal unary policy call, health, tests, and shutdown.
- [Service calls](/guide/service-call): use typed Memory Transport first, then add discovery, selection, retry, and cleanup deliberately.
- [Configuration, registry, store, and cache](/guide/config-registry-store): choose state contracts without collapsing their guarantees.
- [Broker and events](/guide/broker-events): preserve native delivery, acknowledgement, durable consumer, and job semantics.
- [Health and observability](/guide/health-observability): add readiness, metrics, traces, and logs without silently installing global infrastructure.
- [Comparison](/guide/comparison) and [Migration](/guide/migration): compare ownership with third-party frameworks and adopt go-like incrementally.
- [Packages](/reference/packages), [Providers](/reference/providers), [Terminology](/reference/terminology), and [Verification](/reference/verification): use the reference track when the API or evidence boundary matters.

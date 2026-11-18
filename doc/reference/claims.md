# Claims and evidence

This page separates implementation facts, recorded command results, declared coverage, and gaps. It does not turn a source contract into a release claim.

## Evidence labels

| Label             | Meaning                                                      | Safe wording                                   |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `source`          | Current source, manifest, or export confirms the contract    | "The entry exports..."                         |
| `unit-pass`       | A recorded command passed on a named checkout                | Include the command, scope, commit, and counts |
| `runtime-pass`    | A named runtime command completed and was recorded           | Name versions and what was not extrapolated    |
| `declared`        | A test, fixture, or example exists                           | "The repository contains..."                   |
| `runtime-source`  | A portable or runtime-specific boundary is visible in source | Name the subpath                               |
| `pinned-external` | A third-party release or commit was recorded for comparison  | Name the version and the boundary              |
| `recommendation`  | Editorial guidance                                           | "Prefer..."                                    |
| `gap`             | Evidence or a product decision is missing                    | "Not established by this audit"                |

## Claim records

| ID  | Claim                                                                                                                         | Label            | Evidence                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C01 | go-like is a set of sockets and plugs, not an all-in-one application framework                                                | `source`         | 20 packages, 75 entries. The application keeps its router and native data plane                                                                              |
| C02 | `@go-like/core/context` exposes cancellation, deadline, cause, and values                                                     | `source`         | `packages/core/src/context/index.ts`                                                                                                                         |
| C03 | `Server` is `start(ctx)` and `stop(ctx)`. `App` exposes `run()` and `stop()`                                                  | `source`         | `packages/core/src/lifecycle/index.ts`, `packages/core/src/app/app.ts`                                                                                       |
| C04 | Resource `start` is awaited until admission. Server `start` may stay pending and is not a readiness promise                   | `source`         | `packages/core/src/app/tiers.ts` `admitResources`; server launch in `app.ts`                                                                                 |
| C05 | Server stops run concurrently. Owned resources stop in reverse declaration order                                              | `source`         | `executeStop` and `stopResources`                                                                                                                            |
| C06 | `stopTimeout` bounds one shared caller wait, including the telemetry drain, and does not prove a native terminal state        | `source`         | `executeStop` uses one `stopContext` for every stop phase                                                                                                    |
| C07 | `@go-like/core/web` uses the standard one-argument Fetch `Handler`                                                            | `source`         | `packages/core/src/web/context.ts`                                                                                                                           |
| C08 | `@go-like/core/server` dispatches internal POST JSON and SSE and is not the external router                                   | `source`         | `packages/core/src/server/index.ts`                                                                                                                          |
| C09 | Struct is the `@go-like/core/struct` entry, including JSON codec helpers                                                      | `source`         | `packages/core/src/struct/index.ts`. There is no separate codec or runtime entry                                                                             |
| C10 | Memory transport is process-local and instance-private                                                                        | `source`         | `@go-like/core/transport/memory`                                                                                                                             |
| C11 | `defineService` binds Struct validation to JSON Fetch bodies                                                                  | `source`         | `packages/core/src/transport/service.ts`                                                                                                                     |
| C12 | An operation and a transport address are different identities                                                                 | `source`         | `service/endpoint` versus `withEndpoint` and `ServiceInstance.endpoints`                                                                                     |
| C13 | Client calls make one attempt by default                                                                                      | `source`         | Default call options and explicit `withRetry`                                                                                                                |
| C14 | Retry requires authorization, a positive `maxAttempts`, and `shouldRetry`                                                     | `source`         | `packages/core/src/resilience/retry.ts`                                                                                                                      |
| C15 | Retry authorization does not prove business idempotency                                                                       | `recommendation` | The caller declaration is accepted. Core does not inspect side effects                                                                                       |
| C16 | A received response followed by feedback or cleanup failure is not replayed                                                   | `source`         | Client completed-call path                                                                                                                                   |
| C17 | Discovery watchers return complete replacement snapshots                                                                      | `source`         | `Watcher.next` and snapshot helpers                                                                                                                          |
| C18 | An authoritative empty snapshot fails closed                                                                                  | `source`         | `GO_LIKE_NO_AVAILABLE_ENDPOINT`                                                                                                                              |
| C19 | P2C and EWMA feedback are distinct from operation circuit breaking                                                            | `source`         | Selector state versus `circuitBreakerMiddleware`                                                                                                             |
| C20 | Config, Registry, Store, and Cache are separate sockets                                                                       | `source`         | Separate entries, options, and plug limits                                                                                                                   |
| C21 | Broker preserves native delivery and does not publish a universal settlement method                                           | `source`         | `event.native`, `eventBroker`                                                                                                                                |
| C22 | BullMQ, Croner, NATS, Pino, Winston, OpenTelemetry, and Prometheus plugs adapt native objects. Core owns work-unit records    | `source`         | Plug constructors and `telemetry(tel)`                                                                                                                       |
| C23 | Public Web streaming is not internal bidi. Internal server streams are SSE                                                    | `source`         | [Streaming](/guide/streaming)                                                                                                                                |
| C24 | Generated RPC is ctx-first. Portable Fetch covers unary and server-streaming. Managed standard gRPC covers four cardinalities | `runtime-pass`   | 2026-10-28 physical packages, Node 26.12.1 and Bun 1.4.4, on the package that is now `@go-like/connectrpc`. No browser standard-gRPC or future-version claim |
| C25 | Hono, Elysia, H3, and vanilla Fetch examples pass a Fetch handler to a host                                                   | `declared`       | `examples/hono`, `examples/elysia`, `examples/h3`, `examples/vanilla-web`                                                                                    |
| C26 | Verification lanes require their tools to execute and do not reject an environment by version string                          | `source`         | `e2e/runtime-versions.ts`, `e2e/executor.ts`, and [Verification](/reference/verification)                                                                    |
| C27 | A historical audit reported typecheck, unit test, format check, and a 66-entry import audit                                   | `unit-pass`      | Commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. That entry count is not the current 75. This page does not claim the audit was rerun                      |

## Baseline result record

```text
candidate: 9385dbf5b6a7d913be56a80ade359e1bf9be8675
bun:      1.3.14
reported: bun run typecheck
reported: bun run test:unit
reported: bun run fmt:check
counts:   2,736 unit tests, 1,514 formatted files, 66 source export entries imported
```

That evidence leaves these items unestablished: `build`, `doc:build`, `audit`, Docker provider E2E, cross-runtime execution, published-tarball consumers, npm registry state, hosted CI, production adoption, and the 60-minute soak.

A later Task 8 RPC report recorded a physically staged published-consumer matrix for the managed gRPC package: portable Fetch unary and server-streaming, and managed standard gRPC four-cardinality calls, at Node 26.7.0 and Bun 1.4.0. That scoped result does not close the gaps above. The package entry is now `@go-like/connectrpc` and `@go-like/connectrpc/node`.

## Native gRPC drain status

The expanded native regression runs an admitted unary request beside a slowly consumed server stream while stopping the server. Earlier runs passed on Node 26.9.0 and Bun 1.4.2.

On 2026-10-28, the full physical published-consumer matrix passed with Node 26.12.1 and Bun 1.4.4. It keeps the slow-consumer drain regression and also covers native four-cardinality calls, interoperability, mTLS, and browser cases. This establishes the tested managed drain behavior, not every production shutdown.

## Stream cancellation limits

The following limitations are historical observations. The [native gRPC drain](#native-grpc-drain-status) does not close them.

- **Connect 2.1.2.** After a client reads one response message, pauses, and cancels the iterator from outside, the original deadline timer can stay active until its deadline. This was reproduced with official Connect and `node:http2` under Node and Bun, without go-like. The upstream `setupSignal()` releases the deadline in `abort()` and `done()`, and not when its linked controller is aborted externally. No upstream patch is claimed here.
- **Bun 1.4.2 Fetch.** When a server sends the first chunk and then stays silent, canceling the reader and aborting the request did not produce server socket closure during the bounded observation. This also reproduced with plain `node:http` and global Fetch, against both Node and Bun servers. Node clients closed both. This limits long-lived Fetch stream cancellation claims, including portable Connect and gRPC-Web.

No automatic stream replay is provided.

## Comparison evidence

go-micro, go-kratos, and go-zlab/go-kratos commits are recorded in `research/comparisons/capability-comparison.md`. The go-micro commit differs between the default-branch record and the v6.9.0 memo. [Comparison](/guide/comparison) labels that material `pinned-external`.

Third-party snapshots in the research ledger: NestJS `@nestjs/core@11.1.28`, Fastify `5.11.2`, Hono `4.12.34`, Elysia `1.4.29`, Koa `3.2.1`, tRPC `@trpc/server@11.18.0`. They are not compatibility commitments. No NestJS or Fastify bridge is in this repository. The Elysia example's own manifest is the pin for that example.

## Publication gate

Match the sentence to a check:

- **API:** the current manifest export and source entry;
- **types:** the focused package typecheck or public-type test;
- **unit:** the package or root unit command and its exit status;
- **runtime:** the Bun or Node fixture and the observed environment;
- **provider:** the Docker or real-service scope and its cleanup;
- **published consumer:** a packed tarball through the published scope;
- **documentation:** `bun run doc:build`;
- **release state:** an npm or hosted-CI query when claiming publication;
- **stability:** the separate soak duration when claiming long-duration behavior.

A green unit run is not a green provider run. A successful build is not npm publication. A TLS option is not an application authentication policy.

## Wording

Prefer "the current source exports", "the repository contains a declared lane", "the baseline audit reported", and "not established by this audit".

Avoid "production-ready" without a gate, "runs unchanged in Bun and Node" for a Node-only subpath, "exactly once" or "graceful shutdown complete" without a native terminal, "supports streaming" for a Web `ReadableStream` alone, and "published" because a manifest says `0.0.1`.

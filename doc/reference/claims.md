# Claims and evidence

This page is the editorial claim ledger for the English source. It keeps implementation facts, executed results, declared coverage, runtime-source observations, pinned comparison inputs, recommendations, and evidence gaps separate.

## Evidence labels

| Label             | Meaning                                                                           | Safe wording                                                                                |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `source`          | Current source, manifest, export, or package README confirms the contract         | “go-like exposes...” or “The provider implements...”                                        |
| `unit-pass`       | The repository contract audit reported a command passed on the baseline checkout  | Include command, scope, candidate commit, and counts; do not generalize to E2E              |
| `declared`        | A test, fixture, workflow, or example exists                                      | “The repository contains...” or “The lane is declared...”                                   |
| `runtime-source`  | A portable or runtime-specific source boundary is visible                         | Say “portable by source design” or name the explicit subpath; do not claim all-runtime pass |
| `pinned-external` | A release, commit, or official reference is recorded for a third-party comparison | Name the version/commit and verification boundary                                           |
| `recommendation`  | Editorial guidance rather than current implementation                             | “Prefer...” or “A service should...”                                                        |
| `gap`             | Evidence or product decision is missing                                           | Say “not established in this audit”                                                         |

## Twenty-seven claim records

| ID  | Claim                                                                                                                  | Label            | Evidence or qualification                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | go-like is a set of small TypeScript building blocks rather than an all-in-one application framework                   | `source`         | Root README and package boundaries; application keeps its router, framework, and native data planes                                                     |
| C02 | `@go-like/context` exposes explicit cancellation, deadline, cause, and value APIs                                      | `source`         | `packages/context/src/index.ts` and `errors.ts`                                                                                                         |
| C03 | Core `Server` is `start(ctx)` plus `stop(ctx)`, and Core `App` exposes `run()` plus `stop()`                           | `source`         | `packages/core/src/app.ts` current public types                                                                                                         |
| C04 | `Server.start()` is not a readiness Promise                                                                            | `source`         | Core source comment and focused lifecycle test name                                                                                                     |
| C05 | Core invokes sibling Server stops concurrently                                                                         | `source`         | `executeStop` in `packages/core/src/app.ts`; ordered cleanup must be composed explicitly                                                                |
| C06 | `stopTimeout` bounds a cleanup wait and does not prove native terminal state                                           | `source`         | Core wait boundary and provider adapter terminal contracts                                                                                              |
| C07 | `@go-like/web` uses the standard one-argument Fetch Handler                                                            | `source`         | `packages/web/src/context.ts`; Handler is `(Request) => Response                                                                                        | Promise<Response>` |
| C08 | `@go-like/server` is an internal unary `Message` server, not an external Fetch server                                  | `source`         | `packages/server/src/index.ts` Handler type and dispatcher                                                                                              |
| C09 | `@go-like/struct` is a current public package                                                                          | `source`         | Manifest, root exports, `/codec`, `/runtime`, Client/Server imports, and tests; older package lists are stale                                           |
| C10 | Memory Transport is process-local and instance-private                                                                 | `source`         | `@go-like/transport-memory` README and provider implementation                                                                                          |
| C11 | Typed Endpoint binds Struct validation to JSON over the existing Message boundary                                      | `source`         | `endpoint`, `handler(contract, fn)`, `encodeJsonBody`, `decodeJsonBody`                                                                                 |
| C12 | A service operation and a transport address are different identities                                                   | `source`         | `Client.CallRequest` fields versus `ServiceInstance.endpoints` and `withAddress`                                                                        |
| C13 | Client calls make one attempt by default                                                                               | `source`         | Client default call options and explicit `withRetry` path                                                                                               |
| C14 | Retry requires explicit replay authorization, positive total attempts, and a predicate                                 | `source`         | `RetryOptions` and `withRetry` validation                                                                                                               |
| C15 | Retry authorization does not prove business idempotency                                                                | `recommendation` | Caller declaration is accepted; go-like does not inspect side effects or create deduplication                                                           |
| C16 | A received response followed by feedback or cleanup failure is not replayed                                            | `source`         | `CompletedCallFailure` cleanup path in Client                                                                                                           |
| C17 | Discovery watchers return complete replacement snapshots                                                               | `source`         | Registry `Watcher.next()` and snapshot helpers                                                                                                          |
| C18 | An authoritative empty discovery snapshot fails closed                                                                 | `source`         | Resolver replaces the prior snapshot; filters and selection see no endpoint                                                                             |
| C19 | P2C/EWMA selector feedback is distinct from operation circuit breaking                                                 | `source`         | Registry selector state versus `circuitBreakerMiddleware` operation key                                                                                 |
| C20 | Config, Registry, Store, and Cache are separate contracts                                                              | `source`         | Separate package types, option sets, and provider limits                                                                                                |
| C21 | Broker/Event preserves native delivery and does not publish universal settlement methods                               | `source`         | `BrokerEvent.native`, `eventBroker`, and portable Broker SPI                                                                                            |
| C22 | BullMQ, Croner, NATS, Pino, Winston, OTel, and Prometheus packages are adapters or wrappers                            | `source`         | Package source and public export surfaces retain native objects/providers                                                                               |
| C23 | Public Web streaming is not internal full-duplex RPC streaming                                                         | `source`         | README, Streaming guide, and current unary Client/Transport dispatcher                                                                                  |
| C24 | gRPC, Protobuf, IDL generation, and generated RPC code are outside the current boundary                                | `source`         | Root README and capability comparison exclusions                                                                                                        |
| C25 | Hono, Elysia, H3, and vanilla Fetch examples pass native Fetch handlers into a host                                    | `declared`       | Current examples and their tests; the exact result depends on a command run                                                                             |
| C26 | Bun `1.x`, Node `26.x`, unrestricted Deno, TypeScript `7.0.2`, and k6 `2.1.0` are the declared validation requirements | `source`         | `e2e/runtime-versions.ts` and `doc/reference/verification.md`                                                                                           |
| C27 | The baseline audit reported typecheck, unit test, format check, and 66-entry import audit success                      | `unit-pass`      | Reported by the repository contract audit for candidate commit `9385dbf...`; this page does not claim that this documentation phase reran every command |

## Baseline result record

The research evidence supplied for this documentation phase reports:

```text
candidate: 9385dbf5b6a7d913be56a80ade359e1bf9be8675
bun:      1.3.14
reported: bun run typecheck
reported: bun run test:unit
reported: bun run fmt:check
counts:   2,736 unit tests, 1,514 formatted files, 66 source export entries imported
```

The same evidence explicitly leaves these items unestablished: `build`, `doc:build`, `audit`, Docker/provider E2E, cross-runtime execution, published-tarball consumers, npm registry state, hosted CI, production adoption, and the 60-minute soak.

## Comparison evidence

The repository records go-micro, go-kratos, and go-zlab/go-kratos comparison commits in `docs/capability-comparison.md`. A detailed comparison memo also fixed go-micro `v6.9.0`, go-kratos `v3.0.0`, and specific commits. The go-micro commit differs between those records. The English comparison therefore labels the upstream material `pinned-external` and avoids claims about an unpinned current branch.

Third-party TypeScript version observations in the research ledger include NestJS `@nestjs/core@11.1.28`, Fastify `5.11.2`, Hono `4.12.34`, Elysia `1.4.29`, Koa `3.2.1`, and tRPC `@trpc/server@11.18.0`. They are comparison snapshots, not go-like compatibility commitments or benchmarks. No current NestJS or Fastify bridge exists in this repository.

## Publication gate

Before publishing a release-oriented statement, verify the claim at the level it uses:

- **API:** inspect the current manifest export and source entrypoint;
- **type behavior:** run the focused package typecheck or public-type test;
- **unit behavior:** run the relevant package or root unit command and record exit status;
- **runtime behavior:** run the target Bun, Node, or Deno fixture at the declared version;
- **provider behavior:** run the Docker or real-service E2E scope and record cleanup;
- **published consumer behavior:** pack and install the physical tarball through the published scope;
- **documentation behavior:** run `bun run doc:build` and check generated routes;
- **release state:** independently query npm or hosted CI when claiming publication or hosted status;
- **stability:** run the separate soak duration when claiming long-duration behavior.

A green unit run is not a green provider E2E run. A successful build is not npm publication. A source-level TLS option is not a production security policy. Keep the evidence label attached to the sentence.

## Wording patterns

Prefer:

- “The current source exposes...”
- “The repository contains a declared E2E lane for...”
- “The baseline audit reported...”
- “The root HTTP client is Fetch-backed; the `/node` subpath adds...”
- “This provider retains native acknowledgement semantics...”
- “Not established by this audit...”

Avoid:

- “production-ready” without a defined release gate and evidence;
- “runs unchanged in Bun, Node, and Deno” when only a portable source path exists;
- “exactly once,” “safe to retry,” or “graceful shutdown complete” without the corresponding business or native terminal proof;
- “supports streaming” when the only evidence is a Web `ReadableStream`;
- “published” because a manifest has version `0.0.1`;
- “all providers are equivalent” when their lease, acknowledgement, TTL, or transaction models differ.

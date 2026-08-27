# go-like Editorial Blueprint

Status: synthesis deliverable for the documentation rewrite

Audience: documentation maintainers, reviewers, translators, and example authors

This is an internal editorial plan. It is not a product claim, a release note, or a
replacement for the public documentation. The English `doc/` tree remains the
normative documentation source; localized trees follow it only after API and evidence
wording is stable.

## Editorial contract

The documentation should teach go-like as a set of explicit TypeScript building
blocks. It should help a beginner run one service, help an experienced engineer reason
about ownership and failure boundaries, and let a reviewer verify every public package
without turning the project into an all-in-one framework story.

The synthesis uses these evidence labels:

| Label             | Meaning                                                                | Editorial use                                                               |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `source`          | Confirmed by current source, manifest, export, or package README       | May be stated as an implemented contract, with a source link                |
| `unit-pass`       | Reported as executed on this checkout by the repository contract audit | May be stated with the command, commit, and scope; do not generalize to E2E |
| `declared`        | A test, fixture, or workflow exists in the repository                  | Say "declared" or "the repository contains"; do not say it passed           |
| `runtime-source`  | A portable or runtime-specific source boundary is visible              | Do not turn it into all-runtime support without a runtime result            |
| `pinned-external` | A third-party version and commit are recorded for comparison           | Recheck the upstream URL and commit before publication                      |
| `recommendation`  | Editorial choice proposed by this blueprint                            | Never present it as current implementation                                  |
| `gap`             | Evidence or product decision is still missing                          | Keep it in the claim ledger and release checklist                           |

### Baseline adopted by this blueprint

- Repository: `https://github.com/MunMunMiao/go-like`
- Candidate tree: `9385dbf5b6a7d913be56a80ade359e1bf9be8675`
- Root package: private, version `0.0.1`
- Public inventory: 43 non-private `@go-like/*` package manifests and 23 public
  source subpaths. The generated `dist/package.json` metadata export is not a new
  package or source API.
- Examples: 44 private workspace applications. Copying an example directory does
  not create an independently installable project.
- Local results reported by the repository contract audit: `bun run typecheck`,
  `bun run test:unit`, and `bun run fmt:check` passed on this checkout; the audit
  reported 2,736 unit tests, 1,514 formatted files, and a successful import audit for
  all 66 declared source export entries.
- Not established by that audit: `build`, `doc:build`, `audit`, provider Docker E2E,
  cross-runtime execution, published tarball consumers, npm publication, hosted CI,
  production adoption, or the 60-minute soak.
- The repository does not use runtime or tool versions as execution eligibility. Each selected
  verification lane checks that its required tools can run and records the observed environment.
  Command behavior and results, not version numbers, determine the outcome. One research probe
  observed local Node `26.5.0`; that observation is evidence only and does not establish an
  admission or support range.

## 1. Audience map and learning paths

### Audience map

| Reader                               | Needs first                                                             | Common wrong assumption                                                  | Exit condition                                                               |
| ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| TypeScript or Web beginner           | Fetch `Request`/`Response`, explicit `Context`, one `App`, one `Server` | A handler is already a listening server; `Context` is a dependency bag   | Can start, call, health-check, and stop the 0-to-1 project                   |
| Go or Kratos reader                  | `Context` shape, structural `Server`, App admission, unary boundary     | `Server.start` is readiness; go-like has Go-compatible RPC or goroutines | Can map concepts without importing Go ABI or gRPC assumptions                |
| NestJS or Fastify reader             | Ownership comparison: router, host, DI, plugin, and lifecycle           | go-like owns the framework router or provides a direct bridge            | Can retain the native framework and add only an explicit lifecycle boundary  |
| Hono, Elysia, or H3 reader           | `app.fetch` into `@go-like/web`, then `@go-like/core`                   | go-like supplies a second router or middleware DSL                       | Can explain framework-owned routing versus go-like-owned host lifecycle      |
| Service-call engineer                | `Endpoint`, `Struct`, `Client`, `Transport`, direct address             | A service operation and a network URL are the same identity              | Can draw one unary attempt and explain cleanup and retry authorization       |
| Platform or operations engineer      | readiness, advertise address, provider ownership, stop budgets          | A timeout proves that the native resource is terminal                    | Can distinguish caller wait, owner cleanup, and actual terminal evidence     |
| Provider or adapter author           | narrow SPI, `Context` first, native identity, conformance tests         | An adapter may flatten ack, retry, TLS, or provider liveness             | Can state supported semantics and failures without inventing a common facade |
| Documentation reviewer or translator | claim ledger, terms, locale parity, pinned links                        | A test script, package version, or translation implies a passing claim   | Can trace each statement to source, execution, or an explicit gap            |

### Learning paths

#### Path A: first service

1. Read `doc/guide/getting-started.md` and run `examples/vanilla-web`.
2. Add `contextHandler` only when the handler needs a request-scoped `Context`.
3. Read the lifecycle timeline in `doc/guide/architecture.md`.
4. Build the appointment project in `doc/guide/zero-to-one.md` through M0-M3.
5. Add health and graceful stop before adding any external provider.

Checkpoint: the reader can name the Web handler, host, App, Server, request Context,
readiness result, and shutdown owner separately.

#### Path B: typed internal service

1. Start with the typed `Endpoint` and `Struct` boundary.
2. Use one `newMemoryTransport()` instance for client and server.
3. Use `withAddress(...)` before introducing Discovery or Selector.
4. Read the one-attempt DAG and error taxonomy in `doc/guide/service-call.md`.
5. Add `withRetry(...)` only after an idempotency decision and a bounded test.
6. Move to `@go-like/transport-http`, then to `/node` only when native Node HTTP/TLS
   behavior is needed.

Checkpoint: the reader distinguishes `service/endpoint` operation identity from an
opaque `ServiceInstance.endpoints` transport address.

#### Path C: operations and providers

1. Read `doc/reference/providers.md` by capability, not by source directory.
2. Compare Config, Registry, Store, and Cache using memory or object sources first.
3. Add one provider and record its backend, runtime, credentials, liveness model,
   ownership, and evidence lane.
4. Read the watcher snapshot timeline and selector table.
5. Add health, logging, metrics, tracing, or a native worker one adapter at a time.

Checkpoint: the reader can state what the provider owns, what the application owns,
and which behavior is native rather than abstracted.

#### Path D: framework migration

1. Read `doc/guide/comparison.md` for ownership rather than feature counts.
2. Read `doc/guide/migration.md` and keep the existing router, plugin, DI, worker,
   broker, and stream data plane.
3. Add a structural `Server` around one admitted resource.
4. Add explicit Context propagation only at cancellation or deadline boundaries.
5. Add a typed unary call or health route only when it solves a real boundary.

Checkpoint: the reader can explain why go-like is complementary to Hono, Elysia,
H3, Fastify, Koa, NestJS, and tRPC rather than a replacement for each.

#### Path E: provider and package author

1. Read `doc/reference/packages.md` and `doc/reference/providers.md`.
2. Read the relevant `/provider` helper and conformance tests.
3. Define runtime and external-service requirements in the package README.
4. Preserve native delivery, error, credential, and shutdown identity.
5. Add public API/type tests, conformance tests, runtime tests, and provider E2E as
   applicable.
6. Add the package and every public subpath to the catalog check before translation.

Checkpoint: a reviewer can determine whether an entry is portable source, Node/Bun
specific, Node-specific, provider-only, or merely declared in a test matrix.

## 2. Information architecture and exact paths

### Information architecture

The site should read in this order:

1. **Orient**: what go-like is, what it does not own, and how evidence is labeled.
2. **Start**: one Web handler, one App, one Server, explicit Context, and signals.
3. **Understand**: planes, ownership, lifecycle, runtime portability, and the Web/internal
   unary split.
4. **Build**: the Clinic Appointment Booking project from domain invariant to health
   and shutdown evidence.
5. **Call**: typed endpoint, Memory Transport, HTTP Transport, discovery, selection,
   middleware, retry, and cleanup.
6. **Choose**: Config, Registry, Store, Cache, Broker/Event, jobs, health, and telemetry.
7. **Compare and migrate**: fair third-party framework comparison and incremental adoption.
8. **Reference**: every package, subpath, provider, runtime lane, evidence level, and
   claim status.

### New English source pages

These are new files under the authoritative English tree:

| Path                           | Purpose                                                                            | Proposed navigation position |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------- |
| `doc/guide/zero-to-one.md`     | Complete Clinic Appointment Booking project, milestones, API checks, and test plan | After Getting started        |
| `doc/guide/comparison.md`      | Fair ownership-based comparison with TypeScript frameworks and pinned Go baselines | After Architecture           |
| `doc/guide/migration.md`       | Framework, Go service, Kubernetes, and broker migration recipes                    | After Comparison             |
| `doc/reference/providers.md`   | All provider/runtime/ownership/capability rows                                     | After Packages               |
| `doc/reference/claims.md`      | Public claim ledger, evidence labels, and publication gate                         | After Verification           |
| `doc/reference/terminology.md` | Cross-locale glossary and prohibited translations                                  | Before Verification          |

### Existing English files to update

| Path                                 | Required update                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doc/index.md`                       | Link the learning paths, state the 43-package inventory, add the evidence warning, and keep the no-router/no-DI/no-gRPC/full-duplex boundary visible.                                                              |
| `doc/guide/getting-started.md`       | Add beginner checkpoints, the handler/host split, Context-first wording, and links to the 0-to-1 project.                                                                                                          |
| `doc/guide/architecture.md`          | Replace prose-only architecture with the plane map, ownership model, lifecycle timeline, and runtime portability rules. Correct any claim that implies reverse-order sibling shutdown or readiness from `start()`. |
| `doc/guide/service-call.md`          | Lead with typed Memory Transport, separate operation identity from address identity, document resident client owners, retry authorization, and post-response no-retry cleanup.                                     |
| `doc/guide/config-registry-store.md` | Split Config, Registry, Store, and Cache guarantees; add provider-specific rows and injected Fetch/runtime caveats.                                                                                                |
| `doc/guide/broker-events.md`         | Add Memory, RabbitMQ, NATS Core, and JetStream semantics; keep ack/nack/term, DLQ, durable consumer, and connection ownership native. Add BullMQ/Croner as separate lifecycle adapters.                            |
| `doc/guide/health-observability.md`  | Add the security boundary, empty-readiness rule, application-owned provider setup, bounded labels, and actual evidence language.                                                                                   |
| `doc/guide/streaming.md`             | Make the external Web streaming versus internal unary RPC boundary a prominent negative contract.                                                                                                                  |
| `doc/reference/packages.md`          | Rebuild from source manifests. Add `@go-like/struct`, all 43 roots, all 23 source subpaths, and a note about generated metadata-only `./package.json`.                                                             |
| `doc/reference/verification.md`      | Add candidate commit, runtime versions, command, exit status, counts, residuals, and evidence-class recording. Separate Verify, Release, provider, examples, runtime, published, and soak lanes.                   |
| `examples/README.md`                 | Align the learning spine and package/API names with the English documentation; keep private-workspace and non-independent-install warnings. Preserve the concrete invariant-based example catalog.                 |
| `docs/capability-comparison.md`      | Retain as a comparison research record, but add a header that it is not the canonical TypeScript framework comparison and reconcile its pinned upstream commits before linking it as current evidence.             |
| `README.md`                          | Keep the repository overview accurate about 43 packages, unpublished status, `@go-like/struct`, and explicit exclusions; link to the new English site pages where appropriate.                                     |

### Localized paths and rollout

The following seven locale directories mirror every new public page after the English
source is stable:

```text
doc/zh-Hans/guide/zero-to-one.md
doc/zh-Hant-HK/guide/zero-to-one.md
doc/zh-Hant-TW/guide/zero-to-one.md
doc/es-Latn/guide/zero-to-one.md
doc/fr-Latn/guide/zero-to-one.md
doc/ru-Cyrl/guide/zero-to-one.md
doc/ar-Arab/guide/zero-to-one.md

doc/zh-Hans/guide/comparison.md
doc/zh-Hant-HK/guide/comparison.md
doc/zh-Hant-TW/guide/comparison.md
doc/es-Latn/guide/comparison.md
doc/fr-Latn/guide/comparison.md
doc/ru-Cyrl/guide/comparison.md
doc/ar-Arab/guide/comparison.md

doc/zh-Hans/guide/migration.md
doc/zh-Hant-HK/guide/migration.md
doc/zh-Hant-TW/guide/migration.md
doc/es-Latn/guide/migration.md
doc/fr-Latn/guide/migration.md
doc/ru-Cyrl/guide/migration.md
doc/ar-Arab/guide/migration.md

doc/zh-Hans/reference/providers.md
doc/zh-Hant-HK/reference/providers.md
doc/zh-Hant-TW/reference/providers.md
doc/es-Latn/reference/providers.md
doc/fr-Latn/reference/providers.md
doc/ru-Cyrl/reference/providers.md
doc/ar-Arab/reference/providers.md

doc/zh-Hans/reference/claims.md
doc/zh-Hant-HK/reference/claims.md
doc/zh-Hant-TW/reference/claims.md
doc/es-Latn/reference/claims.md
doc/fr-Latn/reference/claims.md
doc/ru-Cyrl/reference/claims.md
doc/ar-Arab/reference/claims.md

doc/zh-Hans/reference/terminology.md
doc/zh-Hant-HK/reference/terminology.md
doc/zh-Hant-TW/reference/terminology.md
doc/es-Latn/reference/terminology.md
doc/fr-Latn/reference/terminology.md
doc/ru-Cyrl/reference/terminology.md
doc/ar-Arab/reference/terminology.md
```

The following existing relative paths are updated in all eight trees, with English
`doc/` listed separately above and these seven exact locale roots below:

```text
doc/zh-Hans/index.md
doc/zh-Hans/guide/getting-started.md
doc/zh-Hans/guide/architecture.md
doc/zh-Hans/guide/service-call.md
doc/zh-Hans/guide/config-registry-store.md
doc/zh-Hans/guide/broker-events.md
doc/zh-Hans/guide/health-observability.md
doc/zh-Hans/guide/streaming.md
doc/zh-Hans/reference/packages.md
doc/zh-Hans/reference/verification.md

doc/zh-Hant-HK/index.md
doc/zh-Hant-HK/guide/getting-started.md
doc/zh-Hant-HK/guide/architecture.md
doc/zh-Hant-HK/guide/service-call.md
doc/zh-Hant-HK/guide/config-registry-store.md
doc/zh-Hant-HK/guide/broker-events.md
doc/zh-Hant-HK/guide/health-observability.md
doc/zh-Hant-HK/guide/streaming.md
doc/zh-Hant-HK/reference/packages.md
doc/zh-Hant-HK/reference/verification.md

doc/zh-Hant-TW/index.md
doc/zh-Hant-TW/guide/getting-started.md
doc/zh-Hant-TW/guide/architecture.md
doc/zh-Hant-TW/guide/service-call.md
doc/zh-Hant-TW/guide/config-registry-store.md
doc/zh-Hant-TW/guide/broker-events.md
doc/zh-Hant-TW/guide/health-observability.md
doc/zh-Hant-TW/guide/streaming.md
doc/zh-Hant-TW/reference/packages.md
doc/zh-Hant-TW/reference/verification.md

doc/es-Latn/index.md
doc/es-Latn/guide/getting-started.md
doc/es-Latn/guide/architecture.md
doc/es-Latn/guide/service-call.md
doc/es-Latn/guide/config-registry-store.md
doc/es-Latn/guide/broker-events.md
doc/es-Latn/guide/health-observability.md
doc/es-Latn/guide/streaming.md
doc/es-Latn/reference/packages.md
doc/es-Latn/reference/verification.md

doc/fr-Latn/index.md
doc/fr-Latn/guide/getting-started.md
doc/fr-Latn/guide/architecture.md
doc/fr-Latn/guide/service-call.md
doc/fr-Latn/guide/config-registry-store.md
doc/fr-Latn/guide/broker-events.md
doc/fr-Latn/guide/health-observability.md
doc/fr-Latn/guide/streaming.md
doc/fr-Latn/reference/packages.md
doc/fr-Latn/reference/verification.md

doc/ru-Cyrl/index.md
doc/ru-Cyrl/guide/getting-started.md
doc/ru-Cyrl/guide/architecture.md
doc/ru-Cyrl/guide/service-call.md
doc/ru-Cyrl/guide/config-registry-store.md
doc/ru-Cyrl/guide/broker-events.md
doc/ru-Cyrl/guide/health-observability.md
doc/ru-Cyrl/guide/streaming.md
doc/ru-Cyrl/reference/packages.md
doc/ru-Cyrl/reference/verification.md

doc/ar-Arab/index.md
doc/ar-Arab/guide/getting-started.md
doc/ar-Arab/guide/architecture.md
doc/ar-Arab/guide/service-call.md
doc/ar-Arab/guide/config-registry-store.md
doc/ar-Arab/guide/broker-events.md
doc/ar-Arab/guide/health-observability.md
doc/ar-Arab/guide/streaming.md
doc/ar-Arab/reference/packages.md
doc/ar-Arab/reference/verification.md
```

`doc/.vitepress/config.ts` must be updated once the English pages exist, then mirrored
through the eight locale `nav` and `sidebar` configurations. No page should be added
to navigation before its route exists in every locale that claims parity.

## 3. Fair comparison rubric and table contents

### Comparison principles

The comparison answers "which layer does each system own?" It does not ask which
project has the longest feature list. Every row must distinguish:

1. product position: application framework, Web/request layer, procedure layer, or
   lifecycle and service-infrastructure toolkit;
2. route or procedure ownership;
3. application lifecycle ownership and what `start`/`stop` completion means;
4. resource ownership and shutdown terminality;
5. Context/cancellation model;
6. dependency and state model: explicit construction, request context, decoration,
   plugin scope, or DI container;
7. external Web ABI and host requirements;
8. internal call/transport model;
9. discovery and endpoint selection, if any;
10. retry default and replay authorization;
11. streaming model, distinguishing Web body streams from RPC streams;
12. provider/runtime scope and native semantics;
13. authentication and authorization boundary;
14. observability ownership;
15. evidence source, version, commit, and verification class.

Use a four-level evidence marker in comparison tables:

- `source`: inspected source or official versioned documentation;
- `declared`: repository or upstream test lane exists;
- `executed`: the exact command was run and passed for the stated scope;
- `gap`: no verified evidence for the statement.

Do not collapse these into a score or crown a winner. A comparison row may say
"not the same product position" rather than `yes` or `no`.

### Main table shape

| System    | Product position                                     | Route/procedure owner                                                                         | App lifecycle owner                          | Resource/stop semantics                                                                   | Context model                                                           | DI/state model                                                        | External Web ABI                              | Internal call model                                     | Discovery/selection                               | Retry default                                                 | Streaming                                                               | Runtime/provider scope                                             | Evidence anchor                          |
| --------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| go-like   | lifecycle and service-infrastructure building blocks | external framework owns Web routes; `@go-like/server` owns internal `service/endpoint` routes | `@go-like/core` App                          | structural `start(ctx)`/`stop(ctx)`; sibling stops concurrent; timeout is a wait boundary | explicit structural Context with `AbortSignal`, deadline, cause, values | explicit constructors and options; no DI container or global locator  | standard Fetch `Handler`; host is separate    | unary `Message` through Client/Server/Transport         | Registry snapshot -> Filter -> Selector, optional | one attempt; `withRetry` explicitly authorizes bounded replay | public Web streams remain framework/Web; internal calls are unary only  | selected portable entries plus explicit runtime subpaths/providers | local source plus exact execution record |
| NestJS    | convention-driven application framework              | controllers/decorators and microservice patterns                                              | Nest application context and lifecycle hooks | module/application hooks and adapter-owned resources                                      | standard Node/TypeScript request and framework context                  | module/provider container, dynamic modules, guards/pipes/interceptors | HTTP adapter; microservice transports         | framework transport enum and server/client abstractions | not the go-like Registry/Selector contract        | compare only documented/provider behavior at pinned version   | adapters and microservice transport behavior; do not merge with go-like | Node-focused                                                       | pinned release and official docs         |
| Fastify   | Node HTTP application framework                      | Fastify route table                                                                           | Fastify `ready`/`listen`/`close` and hooks   | plugin encapsulation and native server close                                              | request/reply objects and hooks                                         | decorators and plugin scope, not Nest-style DI                        | Node HTTP/HTTPS/HTTP2                         | not a service discovery toolkit                         | no go-like-equivalent Registry/Selector claim     | no automatic go-like retry claim                              | framework/plugin and runtime behavior                                   | Node                                                               | pinned release and official docs         |
| Hono      | Web/request middleware and router                    | Hono route/middleware tree                                                                    | runtime adapter/host, not a full go-like App | app pipeline; host owns listener                                                          | Web `Request`/`Response` and Hono Context                               | context bindings, not general DI                                      | standard Fetch                                | not a Registry/Transport client                         | no go-like-equivalent discovery claim             | no automatic retry claim                                      | native Web streams and runtime features                                 | Web-standard runtimes                                              | pinned release and official docs         |
| Elysia    | Bun-first Web framework                              | Elysia route tree and schema/handler composition                                              | Elysia hooks plus adapter                    | adapter-dependent `.listen()`/`.stop()`                                                   | Web and Elysia request context                                          | decorate/derive/resolve, not constructor DI                           | `app.fetch` or Bun adapter                    | not a Registry/Transport client                         | no go-like-equivalent discovery claim             | no automatic retry claim                                      | native framework/runtime streams and upgrades                           | Bun-first; Web adapter differs                                     | pinned release and official docs         |
| Koa       | minimal Node middleware kernel                       | external router normally owns routes                                                          | Node server returned by `listen`             | middleware stack and host own close                                                       | Koa context                                                             | `ctx.state` and prototypes, no DI container                           | Node HTTP middleware                          | not a Registry/Transport client                         | no go-like-equivalent discovery claim             | no automatic retry claim                                      | application middleware/runtime                                          | Node                                                               | pinned release and official docs         |
| tRPC      | procedure-first type-safe RPC layer                  | router/procedure path                                                                         | adapter and host                             | adapter/host own lifecycle                                                                | typed request context                                                   | context factory and procedure middleware                              | Fetch/Node/Express/Fastify/WebSocket adapters | procedure calls, not Registry/Selector/pool ownership   | no go-like-equivalent discovery claim             | caller/provider-specific                                      | adapter-specific; do not call it go-like full-duplex                    | adapter/runtime dependent                                          | pinned release and official docs         |
| go-micro  | Go service/agent framework                           | server/router and transport                                                                   | `Server`/`Service` run model                 | compare exact Start/Stop and stream provider caveats                                      | standard Go `context.Context`                                           | options/default globals and service composition                       | Web plus integrated service model             | Client/Transport/RPC and provider variants              | Registry and event-style watcher                  | default retry behavior must include actual loop bounds        | explicit Stream API, with provider-specific caveats                     | Go and broad agent scope                                           | fixed tag/commit                         |
| go-kratos | Protobuf-first Go cloud-native framework             | generated HTTP/gRPC routes and transport                                                      | App and transport Server                     | Context-aware stop and registrar integration                                              | standard Go `context.Context`                                           | middleware and generated/provider composition                         | HTTP/gRPC                                     | HTTP/gRPC and generated contracts                       | Registrar/Discovery/Watcher                       | no generic core retry claim without provider qualification    | generated gRPC streaming, HTTP SSE/WebSocket distinctions               | Go and contrib                                                     | fixed tag/commit                         |

The TypeScript rows are a product-position comparison, not a compatibility promise.
The Go rows are architecture references, not an ABI promise. In particular, do not
call go-like `Endpoint` an IDL, generated client, Protobuf message, or gRPC equivalent.

### Required comparison notes

- Pin a release tag or commit for every third-party row. The current ledger contains a
  go-micro comparison at both `3c39d17f...` and the repository-recorded
  `9d306dcf...`; this conflict must be resolved before publication.
- Keep the current go-kratos `668db92...` and go-zlab/go-kratos `ecd00dd...` references
  only after checking the links again.
- State that Go Micro's documented retry count is not the same as its actual loop
  count, and that its default stream `CloseSend` behavior is provider-specific.
- State that Kratos HTTP SSE is server-streaming and its WebSocket path is the
  bidirectional path; do not merge both into one checkbox.
- State that Hono, Elysia, and H3 `app.fetch` integration is evidenced in this repo,
  while no direct NestJS or Fastify bridge is evidenced.
- Do not use benchmarks, package count, downloads, or provider count as a quality
  ranking.

## 4. Chosen 0-to-1 project, verified API milestones, and test plan

### Project choice

**Clinic Appointment Booking with cached availability and an in-process policy
service** is the canonical 0-to-1 project. It deepens the existing
`examples/healthcare-appointments` instead of adding a duplicate CRUD example.

The project has a real invariant:

1. A doctor cannot have overlapping active appointments.
2. Cancellation releases the slot.
3. Repeating the same appointment ID and content is idempotent.
4. Reusing an appointment ID with different content is rejected.
5. Availability cache entries are invalidated after booking or cancellation.
6. Readiness is false until the policy/repository dependencies are admitted.

The first project intentionally does **not** require Registry, an external database,
external Broker, authentication, or a production deployment. Those are later paths,
not hidden claims about the project.

### Proposed project surface

| Route                                         | Success                                              | Important failure or boundary                                 |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `POST /v1/appointments`                       | `201` with appointment                               | `400` invalid input; `409` policy/conflict                    |
| `DELETE /v1/appointments/{appointmentId}`     | `200` cancelled appointment                          | `404` missing appointment                                     |
| `GET /v1/doctors/{doctorId}/availability?...` | `200` availability projection                        | `400` invalid interval; cache failure falls back to authority |
| `GET /livez`                                  | `200` when process is alive                          | `503` if a liveness probe fails                               |
| `GET /readyz`                                 | `200` only when all registered readiness probes pass | `503` before admission or after a failed dependency           |

### Verified API milestones

"Verified" here means that the API exists in current source and is covered by the
ledger's source or focused-test evidence. It does not mean the proposed project
extension has already been implemented.

| Milestone              | Implementation to write                                                                                                       | Current API evidence                                                                                                                    | Acceptance evidence                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M0 Web and domain      | Keep `src/main.ts` as the only App/process entry; expose the existing POST/DELETE routes and overlap/idempotency invariant    | `@go-like/web` Handler, `contextHandler`, `@go-like/web/node` host, `newApp`, `server`, `signal`; current example and tests             | Domain tests plus a real Fetch handler test                                               |
| M1 typed policy call   | Add `@go-like/struct` schemas and `endpoint("appointment-policy", "Check", request, response)`; use `handler(contract, fn)`   | Struct root, `endpoint`, typed Server handler, typed Client call are source/test evidenced; current example still uses raw JSON Message | Compile the project and test invalid request/response validation                          |
| M2 explicit Context    | Pass the received `Context` into policy, repository, and cache work; add a bounded delayed operation test                     | Context methods, `contextHandler` abort bridge, and Context-first package APIs are source/test evidenced                                | Cancellation and cause assertions; no replacement with `background()` inside request work |
| M3 cache and health    | Add `newMemoryCache`, TTL, invalidation, `newProbeRegistry`, and `createHealthHandler`                                        | Cache Context-first `get/put/delete`, `expiresIn`, liveness/readiness behavior are source/test evidenced                                | Hit/miss/TTL/fallback/invalidation and empty-readiness tests                              |
| M4 lifecycle           | Compose policy Server and Web Server under one App; close Client explicitly; set a stop budget                                | Core `Server.start/stop`, `App.run/stop`, concurrent child stop, and signal adapter are source/test evidenced                           | No duplicate App; stop result and client cleanup are observed                             |
| M5 real process        | Build a Node host test that sends requests, observes readiness, sends SIGTERM, awaits terminal state, and checks port release | Existing vanilla Web E2E demonstrates the process shape; this project extension is not yet run                                          | `test:e2e:examples` plus the project-specific wrapper, with residuals recorded            |
| M6 optional resilience | Add a separate caller-approved retry exercise only for an idempotent read or explicitly keyed command                         | `withRetry` requires authorization, positive max attempts, predicate, and optional backoff                                              | At most the declared attempts; no retry after a completed response plus cleanup failure   |

### Project ownership map

- Application owns the appointment repository and the cache policy.
- The typed policy service owns its internal unary `Server` boundary.
- The Client owns its logical transport client and must be closed explicitly.
- Core owns the App admission and stop result, but sibling Server stop calls are
  concurrent. If a dependency order is required, compose it inside one owner or hook.
- `@go-like/transport-memory` is one-instance, process-local, unary transport. It is
  not a distributed service, durable store, or network fallback.
- The memory cache is disposable and process-local. It is not the appointment
  authority or a persistence claim.

### Test plan

| Layer            | Required cases                                                                                                                                                    | Evidence class                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Domain unit      | overlap rejection, different-doctor acceptance, cancellation reuse, repeated cancellation, idempotent same command, idempotency conflict, invalid future interval | `unit-pass` after project implementation |
| Context          | request abort reaches policy/repository/cache; custom cause is preserved; timeout stops caller work                                                               | `unit-pass`                              |
| Typed boundary   | malformed JSON, wrong field type, missing Content-Type, response schema failure, safe ServiceError mapping                                                        | `unit-pass` and package contract tests   |
| Memory Transport | same Transport instance connects; different instances do not; request and response snapshots are defensive; unary exchange returns once                           | `unit-pass`                              |
| Cache            | miss falls back to authority, hit avoids policy call, TTL expires, booking/cancel invalidates, cache failure does not become booking authority                    | `unit-pass`                              |
| Health           | empty liveness passes, empty readiness fails closed, all readiness probes must pass, timeout and cancellation are visible, `/livez` and `/readyz` status codes    | `unit-pass`                              |
| Lifecycle        | one App owns both Servers, start admission, signal path, explicit Client close, stop aggregation, port release, no second hidden App                              | `unit-pass` plus process E2E             |
| Runtime          | required tool execution, built Node entry, real Fetch request, SIGTERM, terminal Promise, no residual process                                                     | `declared` until the command is run      |
| Documentation    | all code imports current paths, package inventory includes Struct, diagrams are `text` fences, internal links resolve                                             | `doc:build` and route/link checks        |

Recommended project commands, to be run only after the extension is implemented:

```sh
bun run --filter @go-like/example-healthcare-appointments typecheck
bun run --filter @go-like/example-healthcare-appointments test:unit
bun run test:e2e:examples
```

Record the exact result. The existence of these scripts is not a pass claim.

## 5. Package and provider coverage matrix

### Evidence key for this matrix

`S` means source/export evidence. `U` means the repository contract audit reported the
full unit command passed on this checkout; it does not mean every provider E2E passed.
`R` means a runtime lane is declared in the E2E definitions. `D` means a Docker/provider
lane is declared. `P` means a packed published-consumer lane is declared. A `?` means
that lane was not executed in the synthesis evidence.

### All 43 public root packages

| Package                        | Contract or provider role                       | Teaching boundary and caveat                                                                                   | Evidence target        |
| ------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@go-like/context`             | portable Context kernel                         | explicit cancellation, deadline, cause, value, and `afterFunc`; not ambient DI                                 | S/U; selected R        |
| `@go-like/core`                | App/Server lifecycle kernel                     | structural `start(ctx)`/`stop(ctx)`; App stop is shared and child stops are concurrent                         | S/U; R?                |
| `@go-like/metadata`            | immutable metadata snapshots                    | client/server domains are separate; downstream propagation is explicit allowlist                               | S/U; R                 |
| `@go-like/struct`              | runtime schema/value contract                   | typed Endpoint validation and JSON codec; not IDL, Protobuf, or generated code                                 | S/U; R                 |
| `@go-like/health`              | liveness/readiness probe contract               | empty liveness healthy; empty readiness fails closed                                                           | S/U; R                 |
| `@go-like/resilience`          | retry, breaker, limiter primitives              | replay authorization and feedback are explicit; no automatic idempotency                                       | S/U; R                 |
| `@go-like/web`                 | external Web Handler bridge                     | one standard Fetch argument; no router, auth, or WebSocket abstraction                                         | S/U; R                 |
| `@go-like/client`              | internal unary Client                           | discovery/filter/selection, middleware, pool, close, and explicit retry                                        | S/U; focused tests; R? |
| `@go-like/server`              | internal unary Message Server                   | owns a Transport bind and route dispatch; not an external Fetch server                                         | S/U; focused tests; R? |
| `@go-like/transport`           | Transport/Message SPI                           | Context-first `send`/`recv`; raw Message headers/body; unary current contract                                  | S/U; conformance; R    |
| `@go-like/transport-http`      | portable HTTP provider                          | Fetch client path; listening requires an admitted host                                                         | S/U; R; D?             |
| `@go-like/transport-memory`    | in-process provider                             | private address map per instance; no persistence, cross-process, TLS, or network fallback                      | S/U; R                 |
| `@go-like/config`              | immutable source/snapshot contract              | load/scan/value/watch/close; not a Core Server or ambient config bag                                           | S/U; R                 |
| `@go-like/config-consul`       | Consul config provider                          | injected Fetch, backend health/index/watch semantics, external Consul required                                 | S/U; D?; R             |
| `@go-like/config-etcd`         | etcd config provider                            | gateway/revision/watch/relist semantics; external etcd required                                                | S/U; D?; R             |
| `@go-like/config-kubernetes`   | ConfigMap/Secret provider                       | one resource/key, resource-version watch and relist; not a transaction across resources                        | S/U; D?                |
| `@go-like/config-vault`        | Vault KV v2 config provider                     | external Vault source and polling/recovery; not a generic secret lifecycle                                     | S/U; D?                |
| `@go-like/registry`            | Registry/Discovery/Selector contract            | complete replacement snapshots; filter and selection feedback; no linearizability promise                      | S/U; conformance; R    |
| `@go-like/registry-consul`     | Consul registry provider                        | health-filtered records, blocking index, TTL/critical behavior                                                 | S/U; D?; R             |
| `@go-like/registry-etcd`       | etcd registry provider                          | lease/revision/watch, compaction relist, fail-closed identity conflicts                                        | S/U; D?; R             |
| `@go-like/registry-kubernetes` | EndpointSlice registry provider                 | resource-version/owner-reference model; no fabricated TTL or Service DNS claim                                 | S/U; D?                |
| `@go-like/registry-mdns`       | mDNS registry provider                          | multicast/TTL and explicit host; not a revisioned global registry                                              | S/U; D?; R             |
| `@go-like/registry-zookeeper`  | ZooKeeper registry provider                     | ephemeral sessions and re-armed watches; Node/Bun support, not Deno                                            | S/U; D?; R             |
| `@go-like/store`               | durable byte-record contract                    | revision, TTL, CAS, prefix, cursor, pagination; capabilities can be rejected                                   | S/U; conformance       |
| `@go-like/store-consul`        | Consul Store provider                           | external Consul KV; preserve backend CAS/consistency limits                                                    | S/U; D?                |
| `@go-like/store-etcd`          | etcd Store provider                             | external etcd revision/CAS/watch semantics                                                                     | S/U; D?; R             |
| `@go-like/store-file`          | local File Store provider                       | single-owner lifecycle and directory lock; not a multi-process database                                        | S/U; process lane      |
| `@go-like/store-memory`        | process-local Store provider                    | immediate in-process records with Store semantics; not durable across process exit                             | S/U                    |
| `@go-like/store-vault`         | Vault KV v2 Store provider                      | external Vault; does not promise uniform TTL/CAS                                                               | S/U; D?                |
| `@go-like/cache`               | disposable value/TTL contract                   | cache is acceleration, not durable business state or Store CAS                                                 | S/U; conformance       |
| `@go-like/cache-memory`        | process-local Cache provider                    | no persistence and no distributed cache claim                                                                  | S/U                    |
| `@go-like/cache-redis`         | Redis Cache provider                            | external Redis, namespace/client ownership, provider-specific connection behavior                              | S/U; D?                |
| `@go-like/broker`              | bytes/topic Broker contract                     | no common ack/nack/term/retry/DLQ; native delivery remains visible                                             | S/U; conformance       |
| `@go-like/broker-memory`       | process-local exact-topic Broker                | broadcast/FIFO semantics; no durability, queue group, wildcard, replay, or cross-process claim                 | S/U                    |
| `@go-like/broker-rabbitmq`     | RabbitMQ Broker provider                        | borrowed channel versus recovering channel; confirm is not exactly-once; generation fences matter              | S/U; D?                |
| `@go-like/event`               | typed Broker codec layer                        | explicit encode and lazy decode; no schema registry, replay, or settlement abstraction                         | S/U                    |
| `@go-like/nats`                | NATS Core/JetStream adapters                    | preserve native subscription, consumer, ack/nak/term, redelivery, and DLQ semantics                            | S/U; D?; R             |
| `@go-like/croner`              | Croner lifecycle adapter                        | application owns Cron policy/callback; adapter does not promise callback drain or passive terminal             | S/U; D?; R             |
| `@go-like/bullmq`              | BullMQ Worker lifecycle adapter                 | application owns Queue/Worker policy, processor, retry/backoff, and Redis; adapter owns accepted stop contract | S/U; D?; R             |
| `@go-like/pino`                | Pino logging/lifecycle adapter                  | application owns logger/destination, levels, redaction, formats; adapter manages shutdown boundary             | S/U; R                 |
| `@go-like/winston`             | Winston logging/lifecycle adapter               | application owns logger/transports; adapter waits for native finish/close and does not force-kill              | S/U; R                 |
| `@go-like/otel`                | OpenTelemetry lifecycle/instrumentation adapter | application provides providers/exporters/context manager; no global install or auto-instrumentation            | S/U; D?; R             |
| `@go-like/prometheus`          | Prometheus metrics/handler adapter              | application provides raw Registry; no global registry or background task                                       | S/U; D?; R             |

### All 23 public source subpaths

| Entry point                      | Purpose                                             | Audience and caveat                                                          |
| -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@go-like/broker/provider`       | subscriber terminal registration helpers            | provider authors only; not an application settlement API                     |
| `@go-like/cache/provider`        | provider write option helper                        | provider authors only                                                        |
| `@go-like/config/env`            | environment source                                  | source selection; do not imply ambient runtime portability                   |
| `@go-like/config/file`           | file source and JSON decoder                        | file capability is injected; host/watcher support is separate                |
| `@go-like/config/node`           | Node file capability                                | explicit Node runtime subpath                                                |
| `@go-like/config/yaml`           | YAML decoder                                        | codec/source helper, not a config provider by itself                         |
| `@go-like/core/lifecycle`        | `waitForContext`                                    | caller-wait helper; does not cancel the owned operation                      |
| `@go-like/core/node`             | process signal adapter                              | Node/Bun process signals; not a second App runner                            |
| `@go-like/nats/broker`           | NATS Core Broker adapter                            | native at-most-once, queue group, drain, and subscription identity           |
| `@go-like/nats/jetstream`        | JetStream Server adapter                            | native consumer lifecycle and settlement remain visible                      |
| `@go-like/nats/jetstream/broker` | JetStream Broker adapter                            | ack/nak/term, redelivery, MaxDeliver, and DLQ remain native                  |
| `@go-like/registry/provider`     | registry provider helpers                           | provider implementation boundary                                             |
| `@go-like/registry-mdns/node`    | Node mDNS host                                      | UDP multicast requires explicit Node capability                              |
| `@go-like/store/provider`        | Store provider options/snapshots/errors             | provider implementation boundary                                             |
| `@go-like/store-file/node`       | Node file store host                                | explicit Node filesystem capability                                          |
| `@go-like/struct/codec`          | JSON Struct codec                                   | runtime validation/encoding; not an IDL compiler                             |
| `@go-like/struct/runtime`        | Struct introspection/parsing                        | runtime/provider tooling; preserve public status                             |
| `@go-like/transport/headers`     | go-like wire header constants                       | stable identifiers; never translate in code or docs snippets                 |
| `@go-like/transport/json`        | JSON Message body codec                             | UTF-8/JSON/Struct boundary; not a generic HTTP serializer claim              |
| `@go-like/transport/provider`    | wire/error/metadata helpers                         | provider authors; not a public router API                                    |
| `@go-like/transport-http/node`   | native Node HTTP/1.1, HTTP/2, TLS, mTLS host/client | Node-specific capabilities; portable Fetch root cannot inject all of them    |
| `@go-like/web/health`            | `/livez` and `/readyz` handler                      | standard Web response handler; does not install probes or poll in background |
| `@go-like/web/node`              | Node Web host                                       | listener/host only; do not attribute internal HTTP TLS/HTTP2 to this package |

Generated packages may expose `./package.json` as metadata after build. List it as
metadata only if the generated artifact reference needs it; do not count it among the
23 source subpaths.

### Provider capability matrix

| Plane           | Providers or adapters to cover                                                     | Runtime/external requirement                                                                | Must state explicitly                                                                              |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Config          | env, file, YAML, Node file, Consul, etcd, Kubernetes ConfigMap/Secret, Vault KV v2 | portable source where injected; Node file host; external backends for network providers     | immutable last-good snapshots; provider recovery differs; no cross-resource transaction claim      |
| Registry        | Consul, etcd, Kubernetes EndpointSlice, mDNS, ZooKeeper                            | injected Fetch for HTTP providers; mDNS Node host; ZooKeeper Node/Bun                       | complete replacement snapshots; empty snapshot authoritative; backend liveness mechanisms differ   |
| Selection       | random, round-robin, weighted round-robin, P2C, EWMA                               | portable contract                                                                           | P2C/EWMA feedback is not an operation circuit breaker; all-cooldown fallback is not hard exclusion |
| Store           | memory, file, Consul, etcd, Vault                                                  | file is Node/single-owner; network providers need external services                         | Store is record state; Vault lacks uniform TTL/CAS; file is not multi-process database             |
| Cache           | memory, Redis                                                                      | memory process-local; Redis external                                                        | disposable acceleration and TTL; no durable authority claim                                        |
| Transport       | memory, portable HTTP Fetch, Node HTTP                                             | memory same instance; HTTP root needs host for listen; Node subpath for native listener/TLS | internal calls are unary; client pool is logical owner, not socket count                           |
| Broker/Event    | memory, RabbitMQ, NATS Core, NATS JetStream, typed Event wrapper                   | memory process-local; RabbitMQ/NATS external                                                | native delivery/settlement remains visible; no exactly-once or universal DLQ claim                 |
| Jobs/scheduling | Croner, BullMQ                                                                     | native Cron/Worker and Redis as applicable                                                  | adapters join lifecycle; they do not replace retry, backoff, token, or callback policy             |
| Logging         | Pino, Winston                                                                      | native logger/destination owned by application                                              | no global logger facade; redaction and format remain application policy                            |
| Telemetry       | OpenTelemetry, Prometheus                                                          | application-owned providers/exporters/Registry                                              | no global provider install or automatic instrumentation                                            |
| Health          | ProbeRegistry and Web health handler                                               | standard Web response                                                                       | liveness and readiness are distinct; empty readiness fails closed                                  |

## 6. Diagram inventory and rendering-safe syntax

### Rendering rule

The current VitePress configuration has no Mermaid plugin or runtime. Mermaid fences
render as ordinary code blocks. All diagrams in the new docs must therefore use fenced
`text` blocks with ASCII characters, stable API identifiers, and lines preferably under
88 columns. Do not use Unicode box-drawing characters, Mermaid-only syntax, or a diagram
that requires client-side JavaScript.

Use a short legend near the first diagram:

```text
service/endpoint = logical operation identity
ServiceInstance.endpoints = opaque transport addresses
Context = explicit operation scope, not an implicit DI container
stop timeout = caller wait boundary unless a provider proves native terminality
```

### Inventory

| ID  | Diagram                     | Source page                       | Shape and required labels                                                                                    |
| --- | --------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D1  | planes and ownership map    | `architecture.md`                 | application, external Web, internal unary, state, event, operations, provider/native owner                   |
| D2  | App lifecycle timeline      | `getting-started.md`              | hooks, concurrent Server start/stop, endpoint admission, registration, terminal joins, timeout boundary      |
| D3  | handler/host split          | `getting-started.md`              | `Request -> Handler -> host`; portable root versus `/node` host                                              |
| D4  | unary call DAG              | `service-call.md`                 | Context, middleware, discovery, filters, selector, dial, send, recv, typed validation, feedback, release     |
| D5  | discovery watcher timeline  | `providers.md`                    | initial barrier, fresh read, replacement snapshots, authoritative empty, transient rebuild, terminal failure |
| D6  | retry/replay boundary       | `service-call.md` and `claims.md` | explicit authorization, reselection per attempt, completed response plus cleanup failure means no replay     |
| D7  | provider decision tree      | `providers.md`                    | Config/Registry/Store/Cache/Transport/Broker/adapter choices and runtime caveats                             |
| D8  | appointment project flow    | `zero-to-one.md`                  | HTTP, Context, typed policy, memory transport, authority, cache, health, shutdown                            |
| D9  | message/job settlement      | `broker-events.md`                | NATS native ack/nak/term, RabbitMQ generation, BullMQ worker, Croner callback ownership                      |
| D10 | security responsibility map | `migration.md` or `claims.md`     | TLS, mTLS, metadata, authentication, authorization, retry, application-owned secrets                         |

### Canonical App lifecycle diagram

```text
app.run()
  -> beforeStart hooks, declaration order
  -> Server.start calls, invoked in declaration order and may stay resident
  -> Endpointer.endpoint, if configured
  -> Registrar.register, if configured
  -> afterStart hooks
  -> running

stop request or first start failure
  -> cleanup Context, detached from parent cancellation
  -> cancel App Context and join startup
  -> beforeStop hooks
  -> Registrar.deregister accepted instance
  -> cancel Server runtime Context
  -> Server.stop calls, concurrent
  -> join all Server.start terminal promises
  -> afterStop hooks
  -> success or aggregated failure
```

The diagram must include a note that `Server.start()` is not readiness and that a
`stopTimeout` can settle the caller's wait before an uncooperative native resource is
actually terminal.

### Canonical unary request DAG

```text
Call(ctx, Endpoint, value)
  -> validate Endpoint and encode typed request
  -> client middleware
  -> one attempt, unless explicit retry wraps it
       -> direct address
       -> or Discovery snapshot
       -> ordered Filters
       -> Selector.select
       -> acquire or dial Transport Client
       -> send(Message)
       -> Server recv and route headers
       -> server middleware
       -> decode typed request
       -> business handler(ctx, value)
       -> encode typed response
       -> send(response Message)
       -> client recv and decode
       -> SelectionDone feedback
       -> release idle owner or close owner
  -> return response

withRetry(...) -> repeat the complete attempt from current discovery state
completed response + feedback/close failure -> error with response cause, no replay
```

### Canonical external/internal boundary diagram

```text
External Web request
  -> framework router or native Fetch Handler
  -> @go-like/web Handler
  -> @go-like/web/node or application-owned Web host
  -> @go-like/core App and Server lifecycle

Internal service call
  -> @go-like/client
  -> Discovery -> Filter -> Selector
  -> @go-like/transport-http or @go-like/transport-memory
  -> @go-like/server unary Message route
  -> typed or raw handler(ctx, Message)

Web ReadableStream remains Web/application behavior.
It is not an internal full-duplex RPC stream.
```

### Canonical appointment project diagram

```text
HTTP Request
  -> contextHandler
  -> appointment use case
       -> typed Client.call(ctx, CheckAppointment)
       -> Memory Transport
       -> policy Server
       -> policy result
       -> appointment repository
       -> availability Cache
  -> HTTP Response

/livez and /readyz
  -> ProbeRegistry
  -> createHealthHandler

App.stop()
  -> deregister if configured
  -> stop Web Server and policy Server
  -> close Client owners
  -> observe terminal results
```

Loops such as retry, watcher recovery, broker redelivery, and config reload must be
drawn as separate timelines. They must not be presented as acyclic edges in D2 or D4.

## 7. Cross-locale terminology and voice rules

### Global terminology

API identifiers, package names, route tokens, header names, shell commands, version
strings, URLs, and code remain byte-for-byte unchanged in every locale.

| Term                           | First-use explanation                                                       | Prohibited simplification                                   |
| ------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Context`                      | explicit operation scope carrying cancellation, deadline, cause, and values | ambient DI bag, thread-local context, or Go ABI claim       |
| `App`                          | lifecycle coordinator for Servers, hooks, registration, and terminal result | generic framework container                                 |
| `Server`                       | structural `start(ctx)`/`stop(ctx)` resource boundary                       | readiness promise or universal owner of every native object |
| `Handler`                      | standard Fetch `Request -> Response` function                               | router, WebSocket server, or internal RPC handler           |
| `Message`                      | internal unary headers plus `Uint8Array` body                               | HTTP request object or stream channel                       |
| `Endpoint`                     | named typed operation over the Message boundary                             | IDL, Protobuf descriptor, or generated client               |
| `Registry`                     | registration and discovery capability family                                | durable database or global service locator                  |
| `Discovery`                    | complete replacement snapshots and watcher state                            | event patch stream by default                               |
| `Selector`                     | endpoint choice plus optional synchronous feedback                          | circuit breaker or health oracle                            |
| `Store`                        | record state with revision/CAS/pagination where supported                   | database with uniform transactions                          |
| `Cache`                        | disposable values and TTL                                                   | durable authority or Store alias                            |
| `Broker`                       | topic delivery while preserving provider-native message identity            | queue, job worker, or universal ack API                     |
| `Event`                        | optional typed codec over Broker bytes                                      | Event Store, history, replay, or schema registry            |
| `unary`                        | one request and one response                                                | one-way or streaming                                        |
| `provider`                     | backend implementation of a narrow contract                                 | every lifecycle adapter                                     |
| `adapter`                      | lifecycle or instrumentation bridge around an existing native object        | replacement facade for the native library                   |
| `liveness`                     | whether the process is alive                                                | readiness or dependency health                              |
| `readiness`                    | whether traffic should be admitted now                                      | process liveness only                                       |
| `last-good snapshot`           | last accepted Config or control-plane value                                 | latest possibly-invalid value                               |
| `authoritative empty snapshot` | current discovery state has no endpoints                                    | transient watcher outage that preserves stale state         |
| `selection feedback`           | completion facts returned to a Selector                                     | asynchronous retry controller                               |
| `caller wait`                  | one caller's cancellation or timeout                                        | proof that an owned resource stopped                        |
| `native terminal`              | provider-specific evidence that the actual resource ended                   | any settled timeout Promise                                 |

### Locale voice

- English is the normative, direct, restrained technical source. Prefer evidence over
  marketing language and say when a claim is not verified.
- `zh-Hans` uses neutral technical Simplified Chinese: 服务发现, 注册中心, 提供商,
  运行时, 可观测性, 流式传输, 存储. Do not describe go-like as 大而全.
- `zh-Hant-HK` uses consistent written Hong Kong technical Chinese. Decide once between
  formal written language and colloquial written Cantonese; do not mix `係/畀/唔` into
  reference pages unless that style is explicitly approved.
- `zh-Hant-TW` uses Taiwan technical terminology such as 套件, 設定, 快取, 儲存,
  建置, 型別, 相依套件. Keep it distinct from the Hong Kong glossary.
- `es-Latn` uses neutral Latin American Spanish and `tú`; avoid regional slang and
  `vosotros`. Keep `proveedor`, `registro de servicios`, `almacenamiento`, and
  `observabilidad` stable.
- `fr-Latn` uses formal technical French and `vous`; prefer `paquet`, `fournisseur`,
  `registre de services`, `stockage`, `observabilité`, and `appel unaire`.
- `ru-Cyrl` uses neutral modern technical Russian. Fix one spelling for cache and use
  stable terms for service registry, service discovery, storage, observability, and
  readiness.
- `ar-Arab` uses Modern Standard Arabic, keeps code and mixed-direction identifiers
  isolated, and uses stable terms for service registry, service discovery, cache,
  message broker, observability, and readiness.

### Parity rules

A translation review must compare more than prose:

1. code block tokens, imports, route paths, commands, URLs, versions, and numeric
   limits must match the English source;
2. all negative boundaries must be present: no gRPC/Protobuf/IDL, no internal
   full-duplex RPC, no router/DI/global instrumentation facade, no Event Store/replay;
3. package and provider lists must match the 43/23 inventory;
4. readiness, retry authorization, empty snapshot, metadata allowlist, and shutdown
   ownership semantics must not be shortened away;
5. evidence labels must retain the difference between source, declared, executed, and
   gap;
6. Arabic pages require an RTL visual check for mixed code, URLs, slashes, tables, and
   version strings.

## 8. Link and navigation strategy

### Navigation

Update `doc/.vitepress/config.ts` for all eight locale objects:

- Guide nav: Getting started, Architecture, 0-to-1, Comparison, Migration, Service
  calls, Streaming, Config/Registry/Store, Broker/Events, Health/Observability.
- Reference nav: Packages, Providers, Terminology, Verification, Claims.
- Keep the home page as the entry point, but do not hide the 0-to-1 project behind a
  reference page.
- Add each localized route only after the matching file exists.
- Use the existing locale-aware `route(prefix, path)` helper for every new link.

### Link policy

- Link to current source and tests for go-like claims, with stable repository-relative
  paths and line anchors where practical.
- Link third-party comparisons to fixed release tags or commit trees, never `main` or
  `master` for a published claim.
- Keep official upstream links in `doc/guide/comparison.md` and record the checked
  version, commit, and research date in `doc/reference/claims.md`.
- Link package rows to the package README, manifest, root export, and relevant public
  API/type/conformance test. Provider rows also link to the provider E2E script but
  label it `declared` until an execution record exists.
- Label ADR and `docs/superpowers` links as historical. ADR 0001, ADR 0003, ADR 0004,
  and ADR 0008 contain superseded lifecycle or service declarations and must not be
  used as current API examples.
- Do not link readers from the public site to a stale package count or to an example
  as if it were an independently installable published package.
- Add a route/link parity check for all eight locale trees. Missing pages and dead
  locale links should fail closed before release.

## 9. Verification commands and claim ledger

### Required verification record

Every evidence panel and release note must record:

```text
candidate commit/tree:
environment and runtime versions:
process mode:
command:
exit status:
scope and summary counts:
Docker/provider resources:
observed process residuals:
artifact or log path:
```

A green command is evidence only for its completed scope. A script existing in a
manifest is not an execution result.

### Command matrix

| Command                                           | Scope                         | Claim it can support                             | Current synthesis status                |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------ | --------------------------------------- |
| `bun install --frozen-lockfile`                   | checkout dependencies         | dependency installation for this tree            | rerun before publication                |
| `bun run fmt:check`                               | formatting                    | formatted files in completed run                 | reported passed by contract audit       |
| `bun run typecheck`                               | root, E2E, all workspaces     | TypeScript checks for completed run              | reported passed by contract audit       |
| `bun run build`                                   | package build output          | generated ESM/DTS package artifacts              | not run in the authoritative audit      |
| `bun run test:unit`                               | root and workspaces           | deterministic unit behavior                      | reported 2,736 passed by contract audit |
| `bun run audit`                                   | dependency audit              | audit result for completed environment           | not run in the authoritative audit      |
| `bun run doc:build`                               | VitePress site                | route/render/build validity                      | not run; Mermaid is not installed       |
| `bun run test:e2e:runtimes`                       | declared runtime lanes        | selected Bun/Node/Deno runtime consumers         | declared, not executed in synthesis     |
| `bun run test:e2e:providers`                      | Docker provider lanes         | selected real backend behavior                   | declared, not executed in synthesis     |
| `bun run test:e2e:examples`                       | all immediate examples        | executable startup/readiness/stop and cleanup    | declared, not executed in synthesis     |
| `bun run test:e2e:published`                      | packed tarballs and consumers | generated package exports and runtime resolution | declared, not executed in synthesis     |
| `bun run test:e2e`                                | all default E2E scope         | aggregate E2E result, not production adoption    | not executed in synthesis               |
| `bun run test:e2e:soak`                           | 60-minute k6 soak             | only the measured soak path                      | not executed in synthesis               |
| `git diff --check`                                | changed files                 | whitespace/diff hygiene                          | run for this blueprint before delivery  |
| `bun x oxfmt --check docs/editorial-blueprint.md` | blueprint file                | formatter compatibility for artifact             | run for this blueprint before delivery  |

### Claim ledger

| ID    | Claim                                                                                                              | Evidence and source                                      | Status for publication                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| C-001 | go-like is a composition layer, not an all-in-one framework, router, DI container, or global service locator       | `README.md`, `doc/index.md`, core/web source             | `source`                                                                |
| C-002 | `Context` is an explicit first argument with cancellation, deadline, cause, and values                             | `packages/context`, focused tests                        | `source`, `unit-pass`                                                   |
| C-003 | Core Server is exactly `start(ctx)` and `stop(ctx)`; App owns hooks, admission, registration, and stop result      | `packages/core/src/app.ts`, lifecycle tests              | `source`, `unit-pass`                                                   |
| C-004 | `Server.start()` is not a readiness promise and stop timeout is not proof of native terminality                    | core tests and lifecycle specialist memo                 | `source`, `unit-pass`                                                   |
| C-005 | External Web uses standard Fetch Handler; internal `@go-like/server` uses unary Message handlers                   | `packages/web`, `packages/server`, examples              | `source`                                                                |
| C-006 | Internal Client calls are one attempt by default; retry requires explicit authorization and predicate              | `packages/client`, `packages/resilience`, client tests   | `source`, `unit-pass`                                                   |
| C-007 | A completed response followed by feedback or cleanup failure is not replayed                                       | client cleanup source and tests                          | `source`, `unit-pass`                                                   |
| C-008 | Registry watcher snapshots are complete replacements and an authoritative empty snapshot fails closed              | registry/client source and tests                         | `source`, `unit-pass`                                                   |
| C-009 | Selector choice and operation circuit breaking are separate identities and stages                                  | registry selectors and client breaker source             | `source`, `unit-pass`                                                   |
| C-010 | Memory Transport is instance-private, process-local, unary, and has no network fallback                            | memory provider README/source/tests                      | `source`, `unit-pass`                                                   |
| C-011 | `@go-like/struct` is a current public package used by typed Endpoint calls                                         | manifest, exports, Client/Server imports, struct tests   | `source`; package docs must be corrected                                |
| C-012 | There are 43 public root packages and 23 public source subpaths                                                    | tracked source manifests and exports                     | `source`; release docs still say 42                                     |
| C-013 | Selected portable entries use standard Web APIs across Bun, Node, and Deno lanes                                   | source and E2E definitions                               | `runtime-source` plus `declared`; execution must be rerun               |
| C-014 | Node-specific subpaths add capabilities not guaranteed by standard Fetch                                           | `/node` source and runtime lanes                         | `source`; do not generalize to all runtimes                             |
| C-015 | Config, Registry, Store, and Cache are separate contracts with different durability/liveness semantics             | source, guides, provider code                            | `source`; Config/Store/Cache specialist memo is missing and needs audit |
| C-016 | Broker/Event preserves native delivery and settlement semantics                                                    | broker/event source, tests, provider docs                | `source`, `unit-pass`; Docker provider lanes pending                    |
| C-017 | Croner, BullMQ, Pino, Winston, OTel, and Prometheus are lifecycle or instrumentation adapters                      | adapter source and package docs                          | `source`; native terminal behavior remains provider-specific            |
| C-018 | No gRPC, Protobuf, IDL/code generation, Event Store/history/replay, or internal full-duplex RPC stream is promised | root README, streaming guide, transport/server contracts | `source` negative contract                                              |
| C-019 | Hono, Elysia, H3, and vanilla Fetch examples use native handlers; no NestJS/Fastify bridge is evidenced            | examples and framework specialist memo                   | `source` for examples; `gap` for direct bridge                          |
| C-020 | Go Micro and go-kratos comparison rows describe fixed versions, not moving upstream behavior                       | pinned comparison files and specialist memos             | `pinned-external`; commit conflict must be resolved                     |
| C-021 | The `@go-like/*` packages are not yet published to npm                                                             | local README and getting-started docs                    | `source` for local documentation; npm state independently open          |
| C-022 | Unit/typecheck/format results are green on the audited checkout                                                    | repo-contracts memo with command results                 | `unit-pass`; reconfirm before publication                               |
| C-023 | Build, documentation build, provider E2E, runtime E2E, published consumers, and soak are green                     | no completed result in adopted ledger                    | `gap`                                                                   |
| C-024 | `stopTimeout` or `closeTimeout` means all native resources are closed                                              | no evidence; source says otherwise                       | prohibited claim                                                        |
| C-025 | mTLS proves business authentication or authorization                                                               | no such public mapping exists                            | prohibited claim                                                        |
| C-026 | `withRetry({ authorization: "idempotent" })` proves business idempotency                                           | authorization is a caller declaration only               | prohibited claim                                                        |
| C-027 | Memory Store/Cache/Broker or File Store are distributed/durable/multi-process by default                           | provider source and docs say otherwise                   | prohibited claim                                                        |

### Publication gate

The public rewrite is ready only when:

1. `@go-like/struct` and all 43/23 entries appear in the English package reference;
2. the Config/Store/Cache specialist gap is closed and its claims are source-checked;
3. the go-micro comparison commit conflict is resolved and every external row is
   re-pinned;
4. `bun run doc:build` and locale route/link checks pass;
5. the chosen 0-to-1 project passes its typecheck, unit, and example E2E scope;
6. evidence panels distinguish executed results from declared scripts;
7. all locales contain the same negative boundaries, provider rows, code identifiers,
   numeric limits, and verification status;
8. no claim uses `production-proven`, `published`, `secure by default`, or
   `all runtimes` without a matching external result.

## 10. Explicit exclusions and open evidence gaps

### Explicit product exclusions

The documentation must repeat these boundaries where readers are likely to overgeneralize:

- gRPC, Protobuf, IDL, generated RPC code, and generated clients;
- internal full-duplex RPC streams, frame protocols, half-close, and backpressure;
- Event Store, event history, replay engine, and universal durable offset API;
- all-in-one framework routing, decorator DSL, DI container, global service locator,
  scaffold CLI, or gateway facade;
- universal authentication, JWT/OAuth/OIDC issuer and claims policy, ACL, or
  certificate-to-user authorization mapping;
- ORM, database transaction abstraction, cluster orchestration, deployment policy,
  Kubernetes Service/DNS/Ingress ownership, and rollout management;
- universal broker ack/nack/term, retry, DLQ, exactly-once, or queue semantics;
- automatic global logging, tracing, metrics, exporter, or context-manager installation;
- benchmark, npm download, production adoption, compatibility history, or maturity
  claims based only on package count or repository scripts.

Public Web streaming through standard `Request`/`Response` bodies and framework-native
SSE or WebSocket behavior remains valid application/framework territory. It must not be
renamed internal go-like RPC streaming.

### Open evidence and decision gaps

1. **Config/Store/Cache specialist memo is absent.** Complete a dedicated audit of
   source, tests, provider capability differences, and real-service lanes before
   finalizing that chapter.
2. **Package count drift.** `docs/releases/0.0.1.md` says 42 while source manifests say 43. Decide whether Struct was intentionally added, then correct every package list.
3. **Stale aliases.** `tsconfig.base.json` maps `@go-like/otel/testing` and
   `@go-like/web/node/testing` to missing files and neither is a current package export.
   Do not document them; reconcile the aliases before publishing an entry-point catalog.
4. **Go comparison baseline conflict.** Resolve go-micro `3c39d17f...` versus the
   repository-recorded `9d306dcf...`; record tag, commit, source date, and checked URL.
5. **Moving TypeScript framework baselines.** The ecosystem memo used current-looking
   package versions and moving GitHub HEADs. Re-pin NestJS, Fastify, Hono, Elysia, Koa,
   and tRPC to release tags or commits before publication.
6. **External links.** Provider memos lack a complete official URL matrix for Croner,
   amqplib, NATS, BullMQ, Pino, Winston, OpenTelemetry, and some backend docs. Verify
   links and versions independently.
7. **Runtime execution.** The authoritative audit did not run build, `doc:build`,
   Docker/provider E2E, runtime consumers, published tarballs, or soak. Keep all those
   claims open until exact commands complete.
8. **Observed Node environment.** A research probe saw `26.5.0`; retain it as
   historical evidence, but it is not an admission or support range. Re-run the remaining
   runtime lanes before making a full runtime claim.
9. **NestJS/Fastify integration.** No direct bridge or test exists. Treat them as
   migration audiences and comparison subjects, not supported go-like integrations.
10. **Locale semantic drift.** RabbitMQ recovery, Kubernetes Config, full readiness
    semantics, and Client resident pooling are inconsistent across current locales.
    English must be corrected first, then all mirrors updated.
11. **RTL evidence.** Arabic `dir: rtl` is configured, but no browser screenshot or
    mixed-direction QA result exists for code, URLs, tables, or diagrams.
12. **Lifecycle wording.** Exact ordering of top-level AggregateError entries and the
    distinction between caller timeout and provider terminal state need observable
    examples rather than promise-combinator prose.
13. **Chosen project implementation.** The current healthcare example uses raw JSON
    Message handling and has no cache or health extension described in this blueprint.
    Typed Struct, Cache, and Health milestones are recommendations until implemented
    and tested.
14. **Publishing state.** Local documentation says packages are unpublished, but no
    independent npm query or hosted publication result is part of the adopted evidence.
15. **Production claims.** No repository evidence in this synthesis proves production
    adoption, hosted CI branch protection, or a 60-minute stable deployment.

Until these gaps close, the strongest honest wording is: "implemented in the inspected
source," "covered by the named test lane," or "declared but not executed in this
record." Never promote a script, example, version, or provider README into a stronger
claim by translation or repetition.

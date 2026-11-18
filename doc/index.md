# go-like

go-like is a set of explicit TypeScript building blocks for backend services on Bun and Node.js. `@go-like/core` is the zero-runtime-dependency socket panel: Context, application lifecycle, internal calls, configuration, discovery, records, cache, messaging, jobs, health, and the telemetry base. Nineteen other packages are plugs. A plug fills one or more sockets with an ecosystem client the application creates. `@go-like/protoc-gen-like` is the build-time Protobuf generator and does not depend on core.

The application remains the composition root. It constructs native objects, passes them to plug constructors, and installs the results on `newApp`. There is no global registry of servers, loggers, or telemetry providers.

> [!IMPORTANT]
> This checkout is a private `0.0.1` workspace. A manifest version does not establish npm availability. The examples use workspace packages and are intended to be run from a checkout unless a published release is independently confirmed.

> [!NOTE]
> The English `doc/` tree is the canonical source for this documentation track. Package source, manifests, and focused tests are the API authority. A test or E2E script that exists in the repository is declared coverage; it is not a passing result until a command has actually run and its exit status has been recorded.

## Choose a path

| Reader                          | Start here                                | Then read                                                                   | You are ready when                                                                    |
| ------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| New to go-like                  | [Getting started](/guide/getting-started) | [Architecture](/guide/architecture), [Clinic project](/guide/zero-to-one)   | You can start one Web service, pass a Context, expose health, and stop it             |
| Experienced TypeScript engineer | [Architecture](/guide/architecture)       | [Service calls](/guide/service-call), [Comparison](/guide/comparison)       | You can name the owner, tier, and terminal boundary for each resource                 |
| Go or Kratos reader             | [Getting started](/guide/getting-started) | [Terminology](/reference/terminology), [Service calls](/guide/service-call) | You can map Context and Server concepts without assuming gRPC or Go ABI compatibility |
| Framework user                  | [Comparison](/guide/comparison)           | [Migration](/guide/migration), [Architecture](/guide/architecture)          | You can keep the native router and add only the lifecycle or call boundary you need   |
| Plug author                     | [Provider index](/reference/providers)    | [Verification](/reference/verification), [Claims](/reference/claims)        | You can state the socket, runtime, ownership, and evidence limits for a plug          |

## Canonical learning path

The four-page canonical path under `doc/guide/` is deliberately progressive:

1. [Getting started](/guide/getting-started) runs a standard Fetch Handler, a Node host, an admission signal, and one App.
2. [Clinic Appointment Booking](/guide/zero-to-one) turns the lifecycle into a concrete domain, internal unary call, cache, health, test, and shutdown exercise.
3. [Comparison](/guide/comparison) explains where go-like differs intentionally from NestJS, Fastify, Hono, Elysia, Koa, tRPC, go-micro, and go-kratos.
4. [Migration](/guide/migration) maps the pre-migration packages onto the 20-package layout.

[Packages](/reference/packages) is the inventory of 20 packages and 75 public entries. [Providers](/reference/providers) points at each ecosystem plug README.

## The mental model

Three rules run through the library:

1. **Context first.** Every I/O operation takes `ctx: Context` as its first argument. Context carries cancellation, a deadline, AppInfo, request metadata, and the current telemetry state.
2. **Explicit composition.** The application constructs every implementation and passes it in. Plugs do not register themselves globally.
3. **One path for each job.** Subscribe with `newBrokerServer`, schedule with `newScheduleServer`, consume a queue with `JobQueue.worker`, attach a native resource with `newResourceServer`, and publish readiness with `readyProbe` plus `createHealthHandler`.

```text
Application main.ts
  construct plugs from native objects the application created
  newTelemetry({...})  newConfig(...)  newServer(...)  newClient(...)
        |
        v
@go-like/core  newApp(...)
  telemetry(tel)     admitted first, drained last
  resources(...)     started in order, each start awaited, stopped in reverse
  server(...)        started together, stopped together
  registrar(r)       after the server tier is admitted
  readyProbe(...)    ready only between startup completion and stop
```

Five nouns are enough to read the rest of the site:

- **Socket** is a structural contract core declares (`Server`, `LogHandler`, `Registry`, `Broker`, `Store`, and the others). A plug implements the socket. It does not wrap a core call site.
- **Context** is the explicit scope for cancellable work.
- **Server** is `start(ctx)` and `stop(ctx)`. In `resources(...)` start resolves when the resource is usable. In `server(...)` start may stay pending until the native object ends.
- **App** admits those tiers, hooks, registration, and shutdown. It is not a dependency-injection container.
- **Handler** is the standard Web function `(Request) => Response | Promise<Response>`. A Handler is not, by itself, a listening server.

External Web and internal service calls stay separate. Generated Protobuf RPC is a further optional path: `@go-like/protoc-gen-like` emits ctx-first glue, `@go-like/connectrpc` adapts Connect and gRPC-Web to Fetch, and `@go-like/connectrpc/node` hosts standard gRPC. See [Streaming](/guide/streaming).

## What the application still owns

The current product boundary leaves these with the application or the native library:

- routes, framework middleware, Web Streams, and WebSocket upgrades;
- business policy, credentials, and authorization;
- native acknowledgement, leases, retries, and protocol details;
- OpenTelemetry SDK construction, logger configuration, and exporter choice;
- durability, transactions, and any cross-process meaning of an in-memory reference implementation;
- npm publication, hosted CI status, or a production-readiness claim inferred from a manifest.

## Public inventory

The workspace publishes **20** `@go-like/*` packages, all at version `0.0.1` in this checkout, and **75** public entries. `@go-like/core` contributes 41 entries. The other 34 entries belong to the plugs and the generator. Generated `dist/package.json` metadata exports are not additional source APIs.

Use the [package reference](/reference/packages) to choose an entry, and the [provider index](/reference/providers) to open a plug README. The [claims ledger](/reference/claims) records the evidence level behind public wording.

## Verification boundary

A historical repository contract audit reported local results on commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`: `bun run typecheck`, `bun run test:unit`, and `bun run fmt:check` passed. That report counted 2,736 unit tests, 1,514 formatted files, and a successful import audit for 66 source export entries. That count describes the pre-migration tree. The current inventory is 75 entries. The audit did not establish `build`, `doc:build`, Docker provider E2E, published tarball consumers, npm publication, hosted CI, or the 60-minute soak.

Read [Verification](/reference/verification) before turning a source or script claim into a release claim.

## Next steps

- [Getting started](/guide/getting-started): run a Web handler and the first lifecycle checkpoint.
- [Architecture](/guide/architecture): tiers, Context scopes, start and stop order, readiness, and budgets.
- [Clinic Appointment Booking](/guide/zero-to-one): one business invariant from HTTP to an internal policy call, health, and shutdown.
- [Service calls](/guide/service-call): typed Memory Transport, then discovery, selection, and retry.
- [Configuration, registry, store, and cache](/guide/config-registry-store): four contracts, one shared client per ecosystem.
- [Broker, events, and jobs](/guide/broker-events): bytes, codecs, schedules, and queues.
- [Health and observability](/guide/health-observability): probes, `newTelemetry`, and the four telemetry plugs.
- [Comparison](/guide/comparison) and [Migration](/guide/migration): ownership against other tools, and the import codemod.
- [Packages](/reference/packages), [Providers](/reference/providers), [Errors](/reference/errors), [Terminology](/reference/terminology), and [Verification](/reference/verification).

Managed gRPC slow-consumer drain on Node 26.12.1 and Bun 1.4.4 is recorded in the [native gRPC drain matrix](/reference/claims#native-grpc-drain-status). The earlier Connect 2.1.2 and Bun 1.4.2 Fetch cancellation observations remain in the [claims ledger](/reference/claims#stream-cancellation-limits).

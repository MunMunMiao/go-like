# Migration and adoption

The safest migration rule is: **keep the data plane, adopt the boundary you can explain**.

Keep the existing Web framework, worker, scheduler, broker, logger, or telemetry provider. Add one explicit go-like contract around a real lifecycle or service-call problem. Verify the boundary before adding another provider.

## A staged migration

1. Keep the existing bootstrap and route/data-plane code unchanged.
2. Identify one owner: listener, worker, scheduler, broker subscription, logger destination, or telemetry provider.
3. Add a structural `Server` adapter or use an existing go-like adapter. Define admission, stop, timeout, and terminal observation.
4. Add `@go-like/context` at actual cancellation or deadline boundaries. Pass it as the first argument of the operation.
5. Add liveness and readiness with `@go-like/health` and `@go-like/web/health`.
6. Add one internal typed unary call using `@go-like/transport-memory` in tests.
7. Move that call to `@go-like/transport-http` or `@go-like/transport-http/node` only when a real wire or native Node host is required.
8. Add Registry, Config, Store, Cache, Broker, logging, metrics, or tracing one capability at a time.
9. Record the provider, runtime, owner, and evidence lane for each new boundary.

Do not start with a service-wide rewrite. The point of small contracts is that the migration unit can remain small.

## Framework migration matrix

| Existing system | Keep native                                                               | Adopt first                                                                                              | Current boundary                                                                                                 |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| NestJS          | Modules, controllers, decorators, DI, interceptors, pipes, adapter        | A custom structural Server around the existing application or a separate internal Client/Server boundary | No go-like Nest bridge or automatic DI integration is present in this repository                                 |
| Fastify         | Routes, plugins, hooks, request/reply, native listener                    | A custom lifecycle wrapper, or an explicitly implemented Fetch bridge                                    | No current conversion from Fastify request/reply to go-like Handler is proven                                    |
| Hono            | Routes, middleware, sub-apps, `app.fetch`                                 | `newNodeServer(app.fetch, ...)`, then `newApp(...)`                                                      | Direct native Fetch integration is demonstrated in `examples/hono`                                               |
| Elysia          | Route tree, schema, decorators, derives, hooks, Bun/Web Standard behavior | Native `app.fetch` plus Core host/lifecycle where appropriate                                            | Keep Bun-specific `.listen()` semantics; do not call it a cross-runtime go-like API                              |
| H3              | H3 router and native handler conversion                                   | Current H3 example's Fetch handler path                                                                  | H3 2.x `app.fetch` is the current demonstrated shape; older `toWebHandler` guidance needs its own pinned example |
| Koa             | Middleware and external router                                            | A custom owner wrapper or internal service call                                                          | `@go-like/web` does not accept Koa's Node request/reply object without an application bridge                     |
| tRPC            | Router, procedure middleware, input/output parsers, adapter               | Core lifecycle around the host or a separate internal transport boundary                                 | go-like Endpoint is not a tRPC procedure router                                                                  |

### Hono example

This is the demonstrated integration shape:

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/web/node"

const web = new Hono().get("/users/:id", (c) => c.json({ id: c.req.param("id") }))

const app = newApp(name("users"), server(newNodeServer(web.fetch, port(3000))), signal())

await app.run()
```

The current Hono example retains Hono's route ownership and passes the native Fetch handler to the Node host. It does not add a go-like route table or Hono-specific bridge package.

### Elysia and H3

Apply the same boundary to a framework that exposes a standard Fetch handler:

```text
framework route table
  -> framework native Fetch handler
  -> @go-like/web/node (when using the Node host)
  -> @go-like/core App
```

Check the framework's runtime adapter before importing a Node subpath. Elysia's Bun adapter and Web Standard adapter do not have identical listen behavior. H3 versions and handler conversion APIs also need a pinned example. Do not use the existence of one example to promise every framework version or runtime combination.

## Go service migration

For a Go or Kratos reader, migrate concepts rather than spelling:

| Go concept        | go-like concept                                                                                                    | Important mismatch                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `context.Context` | `@go-like/context` `Context`                                                                                       | `done()` is an `AbortSignal` or null, not a Go channel                 |
| Server lifecycle  | Core structural `Server`                                                                                           | `start(ctx)` may be long-lived and is not readiness                    |
| App runner        | `newApp`, `App.run`, `App.stop`                                                                                    | `App.stop()` has no caller Context and returns one shared Promise      |
| RPC client        | `@go-like/client`                                                                                                  | Internal calls are unary `Message`; retry is opt-in                    |
| Transport         | `@go-like/transport`                                                                                               | Providers and Message headers are TypeScript/Web contracts             |
| Registry          | `@go-like/registry`                                                                                                | Watchers return complete replacement snapshots                         |
| Selector          | `newRoundRobinSelector`, `newRandomSelector`, `newWeightedRoundRobinSelector`, `newP2CSelector`, `newEWMASelector` | Feedback is synchronous and policy-specific                            |
| Protobuf/IDL      | no go-like equivalent                                                                                              | `Endpoint` + `Struct` is runtime validation, not generated schema code |
| gRPC stream       | no current go-like equivalent                                                                                      | Public Web streaming is separate from internal unary transport         |

An incremental first move is a direct-address typed call over Memory Transport:

```ts
const transport = newMemoryTransport()
const server = newServer(
  serverTransport(transport),
  address("memory://pricing"),
  handler(pricingEndpoint, pricingHandler)
)
const client = newClient(withTransport(transport))

const result = await client.call(ctx, pricingEndpoint, request, withAddress("memory://pricing"))
```

Only after this boundary is tested should you introduce Discovery, a real Registry provider, or an HTTP transport. This preserves the domain contract while replacing the destination and ownership plumbing.

## Kubernetes adoption

Keep Kubernetes native:

- Deployments, Services, DNS, Ingress, RBAC, probes, rollout strategy, HPA, and network policy remain platform responsibilities;
- `@go-like/config-kubernetes` reads one key from one namespaced ConfigMap or Secret through an injected Fetch capability;
- `@go-like/registry-kubernetes` uses EndpointSlice records when direct discovery is a real requirement;
- an EndpointSlice is not Kubernetes Service DNS and does not provide a universal registration TTL;
- optional Pod owner references and explicit deregistration have different failure semantics.

Start with health and configuration before direct EndpointSlice selection. If the application already has a stable Service DNS name, `withAddress(...)` plus an HTTP transport may be simpler and more honest than adding a Registry provider.

## Broker and job adoption

Keep native settlement and job policy:

| Existing data plane | Keep                                                             | Add go-like for                                                                   |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| NATS Core           | Connection, subscription, queue group, `Msg`, drain              | `newNatsCoreServer`, `newNatsCoreBroker`, lifecycle and byte boundary             |
| NATS JetStream      | Stream, durable consumer, `JsMsg`, ack/nak/term, redelivery, DLQ | `newNatsJetStreamServer`, `newNatsJetStreamBroker`, lifecycle                     |
| RabbitMQ            | Connection, topology, confirm policy, channel                    | Borrowed or recovering subscriber lifecycle and generation-safe native settlement |
| BullMQ              | Queue, Worker, processor, retry/backoff, Redis                   | `newBullMqWorkerServer` around an official dormant Worker                         |
| Croner              | Cron expression, time zone, callback, overlap policy             | `newCronerServer` around paused native Cron jobs                                  |
| Memory Broker       | In-process topic map and test semantics                          | `newBrokerServer` and optional event codec                                        |

Do not migrate NATS ack/nak/term, JetStream durable settlement, RabbitMQ confirmations, or BullMQ retries into a generic go-like Broker abstraction. Those semantics are why the provider-native object remains visible.

## State migration

Choose one state domain at a time:

- Config for immutable process configuration snapshots and reload;
- Registry for ephemeral service reachability;
- Store for authoritative records, revisions, CAS, TTL, and pages;
- Cache for disposable values that can be recomputed.

A useful migration test is to write down what happens after a process restart, a stale read, a provider outage, a watcher compaction, a CAS conflict, and a cache miss. If the answer differs, these should not share one generic repository interface.

## Adding observability

Add the native provider first, then wrap the boundary:

```text
application creates logger / Registry / MeterProvider / TracerProvider
  -> go-like wrapper records bounded operation facts
  -> application-owned exporter or destination
  -> explicit Core lifecycle adapter closes the admitted resource
```

`@go-like/prometheus` does not use the global registry. `@go-like/otel` does not install global providers or exporters. Pino and Winston adapters do not replace native logger configuration. Keep labels and attributes bounded and redact application-owned logs separately.

## Migration acceptance checklist

Before merging one boundary, verify:

- one clearly named owner exists;
- the owner receives the right Context and does not replace it with `background()`;
- startup admission and readiness are distinct;
- stop timeout behavior is documented as a wait boundary;
- native terminal observation is retained where available;
- external Web and internal unary handlers are not mixed;
- retry authorization matches the business operation;
- credentials, metadata, logs, and trace attributes have a redaction policy;
- provider-specific semantics remain visible;
- the focused unit/typecheck command passed in the target checkout;
- the relevant runtime, provider, published, or example E2E command was either run and recorded or explicitly marked as not run.

## Current support boundary

The repository contains direct examples for vanilla Fetch, Hono, Elysia, H3, Memory Transport, typed internal calls, health, brokers, workers, and observability adapters. It does not prove automatic bridges for NestJS or Fastify, gRPC/Protobuf/IDL compatibility, full-duplex internal streams, universal authentication, or deployment orchestration. Those would require separate adapters, tests, and product commitments.

# Architecture

go-like is a composition layer for backend services. It has several small package contracts instead of one framework container. The application constructs the real dependencies, passes them into options or factories, and chooses where lifecycle ownership begins.

The useful question is not “which package has the most features?” It is “who owns this state, who admits it, who observes its terminal result, and which runtime or backend gives it meaning?”

## The planes

```text
Application composition root
  |
  +--> Context plane
  |      @go-like/context: cancel, deadline, cause, values
  |
  +--> Lifecycle plane
  |      @go-like/core: App, Server, hooks, registration, stop result
  |
  +--> External Web plane
  |      framework or application Handler: Request -> Response
  |      @go-like/web: Context bridge
  |      runtime host: listener, sockets, Web API conversion
  |
  +--> Internal call plane
  |      Client -> Discovery -> Filter -> Selector -> Transport -> Server
  |      one unary Message exchange
  |
  +--> State and control plane
  |      Config snapshots, Registry reachability, Store records, Cache values
  |
  +--> Event and work plane
  |      Broker/Event, NATS, RabbitMQ, Croner, BullMQ
  |
  +--> Operations plane
         Health, Resilience, Pino, Winston, OpenTelemetry, Prometheus
```

The arrows are composition dependencies, not global service lookups. A package can be portable while a selected provider is runtime-specific. For example, the root `@go-like/transport-http` client path uses standard Fetch, while `@go-like/transport-http/node` adds a Node host and native HTTP/TLS behavior.

## Ownership map

| Boundary                               | go-like owns                                                                                      | The application or provider still owns                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@go-like/core` App                    | Startup admission, hooks, registration calls, stop coordination, lifecycle result                 | Construction, dependency graph, business policy, native resources not handed to a Server |
| Structural `Server`                    | One `start(ctx)` / `stop(ctx)` contract                                                           | The actual resource and its terminal semantics                                           |
| `@go-like/web`                         | Standard Handler type and request Context bridge                                                  | URL routes, framework middleware, authentication, authorization, Web Streams, upgrades   |
| `@go-like/client`                      | Logical call middleware, discovery watchers, logical Transport Client owners, explicit retry loop | Business idempotency, provider connection reuse, credentials, deployment policy          |
| `@go-like/server`                      | Internal unary route table, Message dispatch, route validation, operation middleware              | External HTTP routes, business validation, transport listener implementation             |
| `@go-like/registry`                    | Snapshot, filter, selector, feedback contracts                                                    | Backend leases, TTL, sessions, revisions, consistency, authentication                    |
| `@go-like/config`                      | Immutable merged snapshots, accepted source watchers, last-good publication                       | Source credentials, backend watch model, application schema and rollout policy           |
| `@go-like/store`                       | Context-first records, revisions, CAS options, pages                                              | Durability, transaction scope, multi-process guarantees, backend limits                  |
| `@go-like/cache`                       | Disposable values and TTL option                                                                  | Cache invalidation policy, authority, persistence, cross-process semantics               |
| `@go-like/broker` and `@go-like/event` | Byte boundary, optional codec, accepted subscription stop, native delivery identity               | Ack/nack/term, redelivery, durable consumers, DLQ, connection and stream                 |
| Observability adapters                 | Explicit wrapper and admitted shutdown boundary                                                   | Logger, exporter, provider, registry, labels, redaction, global setup                    |

A resource may be borrowed at construction and transferred into a go-like lifecycle adapter only after successful admission. The adapter must document that transfer. A timeout while waiting for an owner does not automatically mean that the native object has stopped.

## Context scopes

Core creates three important scopes:

```text
parent Context
      |
      v
appContext = withCancel(withValue(parent, AppInfo))
      |
      +--> startup hooks, endpoint preparation, registration, afterStart
      |
      +--> withoutCancel(appContext)
              |
              v
      serverContext = withCancel(...)
              |
              +--> long-lived Server.start(ctx)
              |
              +--> canceled during App.stop after deregistration

cleanupContext = withoutCancel(appContext)
      |
      +--> optional absolute stopTimeout
      +--> beforeStop, deregistration, Server.stop, terminal joins, afterStop
```

A caller's cancellation and an owner's lifecycle are different facts:

- `ctx.err()` reports the Context's cancellation or deadline result.
- `cause(ctx)` can expose a caller-supplied `Error` while `err()` remains the stable cancellation category.
- `waitForContext(ctx, operation)` lets a caller stop waiting without canceling the underlying `operation`.
- `App.stop()` has no caller Context parameter. It returns one stable, shared Promise for the application's idempotent stop operation.
- A `Server.stop(ctx)` implementation may use its `ctx` to bound one caller's wait while continuing owner cleanup in a detached operation.

## App lifecycle

The public Core contracts are structural:

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

The startup path is:

1. Run `beforeStart` hooks sequentially in declaration order.
2. Invoke each `Server.start(serverContext)` in declaration order. Invoking a start is not the same as waiting for readiness; a long-lived server may keep its Promise pending until termination.
3. Resolve `Endpointer.endpoint(startContext)` values for registration, sequentially.
4. Register one immutable `ServiceInstance` when `registrar(...)` is configured.
5. Run `afterStart` hooks sequentially.
6. Continue until `App.stop()` is requested or a launched Server reports a terminal failure.

The stop path is:

1. Create a detached cleanup Context and, when configured, one absolute `stopTimeout` budget.
2. Cancel the application Context so startup work and admission can stop.
3. Join startup within the remaining stop budget.
4. Run `beforeStop` hooks.
5. Deregister the accepted `ServiceInstance`.
6. Cancel the detached Server runtime Context.
7. Invoke applicable `Server.stop(stopContext)` calls concurrently.
8. Join all `Server.start()` terminal Promises.
9. Run `afterStop` hooks and aggregate lifecycle failures.

Sibling Servers do not receive a general reverse-dependency shutdown guarantee. If a worker must stop before its queue or a client must close after a server, put that order inside one composed Server or an explicit hook. The `server(...)` option alone is not a dependency graph scheduler.

```text
app.run()
  -> beforeStart hooks, sequential
  -> Server.start calls, declaration order, long-lived allowed
  -> endpoint preparation, if needed
  -> Registrar.register, if configured
  -> afterStart hooks, sequential
  -> running
  -> stop request or first Server terminal failure
  -> startup join under stop budget
  -> beforeStop hooks
  -> Registrar.deregister
  -> cancel Server runtime Context
  -> Server.stop calls, concurrent
  -> Server.start terminal joins
  -> afterStop hooks
  -> one success or aggregated failure
```

`startTimeout(...)` covers startup hooks, endpoint preparation, registration, and `afterStart`. It does not turn `Server.start()` into a readiness Promise. `stopTimeout(...)` is one shared caller-wait budget across cleanup phases. A late native resource may still settle after Core returns; record that as a cleanup failure or provider-specific terminal fact instead of reporting a clean close by assumption.

## Request and dependency DAGs

The external Web path and internal service path deliberately do not share a handler type:

```text
External Web
  Request
    -> framework route / application policy
    -> Handler(request)
    -> Response
    -> host writes response and owns sockets

Internal unary
  Context + Endpoint + typed input
    -> Client middleware
    -> direct address OR Discovery snapshot
    -> ordered Filters
    -> Selector.select
    -> Transport.dial or resident owner
    -> send(Message)
    -> Server recv and route validation
    -> operation middleware
    -> typed decode, business handler, typed encode
    -> send(response Message)
    -> Client recv, ServiceError decode, typed validation
    -> SelectionDone feedback
    -> owner reuse or close
```

The internal operation identity is `service/endpoint`, for example `orders/Orders.Get`. A `ServiceInstance.endpoints` value is an opaque transport address, for example `http://10.0.0.4:8080` or `memory://orders`. Do not use one in place of the other.

## Runtime portability

“Portable” means that a shared entrypoint uses standard JavaScript and Web capabilities or explicitly injected capabilities. It does not mean every runtime can provide a TCP listener, process signals, file watching, UDP multicast, custom TLS, or a vendor client.

| Entry point or capability                                                                                                  | Bun                                        | Node.js                                   | Deno                              | Boundary                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@go-like/context`, root `@go-like/core`, `@go-like/health`, `@go-like/metadata`, `@go-like/resilience`, `@go-like/struct` | source/runtime lane in repository          | source/runtime lane in repository         | source/runtime lane in repository | Portable package design; see the current verification lane before treating it as a release result |
| `@go-like/web`, `@go-like/web/health`                                                                                      | standard Web handler                       | standard Web handler                      | standard Web handler              | A Handler still needs a host                                                                      |
| `@go-like/transport-memory`                                                                                                | process-local                              | process-local                             | process-local                     | Same Transport instance required; no cross-process behavior                                       |
| `@go-like/transport-http` root                                                                                             | Fetch client path                          | Fetch client path                         | Fetch client path                 | `listen` needs an injected `HTTPHost`; root does not expose the Node host                         |
| `@go-like/web/node`                                                                                                        | may execute Node APIs in some environments | Node host                                 | not a Deno entrypoint             | This is a Node-specific subpath, not a portable TLS host                                          |
| `@go-like/transport-http/node`                                                                                             | not the documented Deno path               | Node HTTP/1.1, HTTP/2, TLS, mTLS, pooling | not a Deno entrypoint             | Native Node listener and client behavior                                                          |
| `@go-like/core/node`                                                                                                       | Bun/Node process signal APIs               | Node process signal APIs                  | not a Deno entrypoint             | Explicit runtime-specific import                                                                  |
| mDNS `/node`, file Store `/node`, ZooKeeper, NATS, Redis, RabbitMQ, BullMQ                                                 | provider-dependent                         | provider-dependent                        | provider-dependent or unsupported | Read the provider row, not only the root package name                                             |

The TypeScript `DOM` library setting supplies types. It is not a runtime polyfill and does not prove semantic parity. Runtime subpaths are explicit because package exports do not currently use conditional `bun`, `node`, or `deno` conditions.

## Composition, not a container

A composition root should make ownership visible:

```ts
const transport = newMemoryTransport()
const policyServer = newServer(
  serverTransport(transport),
  address("memory://policy"),
  handler(policyEndpoint, policyHandler)
)
const policyClient = newClient(withTransport(transport))
const webServer = newNodeServer(webHandler, port(3000))

const app = newApp(
  name("appointments"),
  server(policyServer, webServer),
  afterStop(async (ctx) => {
    await policyClient.close(ctx)
  }),
  signal()
)
```

The example is a composition pattern. It does not make `newApp` a DI container, and it does not make a memory transport distributed. The application still chooses credentials, provider factories, authentication, data ownership, and shutdown ordering.

## Historical API warning

Current documentation follows the source and public API tests at the `0.0.1` baseline. Older ADRs and design notes mention superseded names such as `ServerHandle`, `AppHandle`, automatic registration designs, and other lifecycle shapes. Treat those documents as historical; do not copy their signatures into new code.

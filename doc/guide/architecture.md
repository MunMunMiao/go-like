# Architecture

go-like is a composition layer. `@go-like/core` declares sockets and implements the mechanisms that do not need a third-party client. A plug fills a socket. The application constructs the native object, builds the plug, and chooses which App tier owns it.

The useful question is: who admits this object, which tier it sits in, who observes its terminal result, and which runtime or backend gives that result meaning?

## Sockets and plugs

```text
Application composition root
  |
  +--> Context, metadata, struct, health, resilience     core mechanisms
  |
  +--> Lifecycle
  |      telemetry(tel) -> resources(...) -> server(...) -> registrar
  |
  +--> External Web
  |      Handler on @go-like/core/web
  |      host on @go-like/core/web/node or @go-like/core/web/bun
  |
  +--> Internal calls
  |      Client, Server, Transport
  |      memory and Fetch transports in core; gRPC on @go-like/connectrpc
  |
  +--> State
  |      Config, Registry, Store, Cache sockets
  |      memory references in core; Consul, etcd, Vault, Kubernetes,
  |      ZooKeeper, mDNS, YAML, Redis, and file plugs
  |
  +--> Messages and jobs
  |      Broker and Job sockets
  |      memory broker in core; NATS, RabbitMQ, BullMQ, and Croner plugs
  |
  +--> Telemetry sockets
         LogHandler, TracerProvider, MeterProvider, Propagator
         filled by @go-like/otel, @go-like/pino/log, @go-like/winston/log,
         @go-like/prometheus/metric
```

Core records each work unit at a fixed call site. A plug does not wrap `newClient` or a Web handler to add a span. Import direction inside core is enforced by `test/portable-lane.test.ts`: lower layers do not import the root entry.

## Three tiers

`newApp(...options)` applies options in argument order. The same object cannot appear in both `resources(...)` and `server(...)`. Passing a `Telemetry` bundle to either list is a type error and a runtime `TypeError`.

| Tier      | Option                                        | Start                                                                                                                                                         | Stop                                                                                                                                   |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry | `telemetry(tel)` replaces the previous bundle | First. Log handlers, then the tracer, then meters. Each `lifecycle.start` is checked for an immediate failure. A failure rolls back the ones already started. | Last, after `afterStop`, on its own `stopTimeout` budget. Tracer and meters drain together, then log handlers.                         |
| Resources | `resources(...)` replaces the previous list   | After `beforeStart`, before any server. Declaration order. Each `start(ctx)` is awaited and must resolve when the resource is usable.                         | After every launched server has been stopped, reverse declaration order. A stop failure is recorded and the next resource still stops. |
| Servers   | `server(...)` replaces the previous list      | All `start` calls are issued, then one immediate failure check. `start` may stay pending until the native object ends. Optional `Endpointer`.                 | Concurrent `stop`, then each `start` promise is joined.                                                                                |

Hooks: `beforeStart` runs before the resource tier. `afterStart` runs after registration. `beforeStop` runs before deregistration. `afterStop` runs after the resource tier and before telemetry drain. Startup hooks fail fast. Stop hooks run as cleanup.

Registration uses the server tier only. A resource is a dependency, not an address to advertise.

```text
run()
  1  install signal() or another runtime option
  2  phase = starting
  3  admit telemetry
  4  open the start budget, if startTimeout is set
  5  beforeStart
  6  admit each resource and wait
  7  launch every server, then check for an immediate failure
  8  prepare endpoints and register, server tier only
  9  afterStart
 10  phase = ready; go_like.app.ready flips with the ready probe
 11  wait for stop or the first participant failure

stop()
  1  phase = stopping; the ready probe fails from this moment
  2  open the shared stop budget, if stopTimeout is set
  3  cancel the application Context
  4  join startup inside that budget
  5  beforeStop
  6  deregister
  7  cancel the server Context and stop launched servers concurrently
  8  join server start promises
  9  cancel the resource Context and stop owned resources in reverse order
 10  join resource start promises inside the same budget
 11  afterStop
 12  cancel the telemetry Context and stop the bundle on a fresh budget of the same length
```

`run()` is one-shot. `stop()` is idempotent and shares one promise. `App.stop()` takes no Context. The first stop reason wins: `requested` for `App.stop()` and `signal()`, `context_canceled` when the parent Context ends, `start_failed` when startup fails, `server_failed` when an admitted participant fails after ready. One failure is thrown as itself. Several failures become one `AggregateError` in phase order, with telemetry last.

Sibling servers have no reverse-order guarantee. If a worker must stop before its queue, put the queue in `resources(...)` and the worker in `server(...)`. The resource tier exists so that combination waits for admission. A hand-written `Server` whose `start` never resolves will stall resource admission; use `newResourceServer` for a native object, or put a long-lived participant in `server(...)`.

## Context scopes

```text
parent
  -> appContext          canceled at the start of stop
       -> telemetryContext    canceled just before Telemetry.stop
       -> resourceContext     canceled just before the resource tier stops
       -> serverContext       canceled just before Server.stop
       -> startContext        appContext, plus startTimeout when configured
       -> stopContext         withoutCancel(appContext), plus the shared stopTimeout
       -> telemetryStop       a second stopTimeout, opened when the drain begins
```

A long-running `start(ctx)` receives the Context of its own tier. That Context stays alive until that tier is asked to stop, so a resource does not see cancellation while servers are still draining. Telemetry uses its own Context for the same reason: canceling `appContext` at the beginning of stop must not drain telemetry before the servers it observes.

## Budgets and ownership

`startTimeout` covers hooks, resource admission, endpoint preparation, registration, and `afterStart`. It does not cover telemetry admission, and it does not turn a server `start` into a readiness promise. The default `0` means no limit. `registrarTimeout` defaults to 10 seconds and bounds the register and deregister calls.

`stopTimeout` is the caller-wait budget shared by hooks, deregistration, the server tier, and the resource tier. The telemetry drain opens a second budget of the same length when that phase begins, so an export can still finish after the shared budget is exhausted. A drain that never settles makes `App.run()` wait about twice `stopTimeout`. The default `0` means no limit for either. When the shared budget is already exhausted, later `stop` calls are still issued. Core does not keep waiting, and a timeout is not a native terminal state. Plug-owned timeouts stay with the plug: the OpenTelemetry shutdown default is 25 seconds, the Pino drain default is 25 seconds, and the Winston handler has no drain timeout of its own.

After `start` resolves, the App owns the participant. `newResourceServer({ open, terminal, close })` resolves `start` when `open` finishes, or immediately when `open` is omitted. `close` is the single owner drain and is called with `withoutCancel` of the first stop Context. If `open` fails, `close` is not called. A second `start` rejects with `GO_LIKE_RESOURCE_ALREADY_STARTED`. A clean `terminal` settlement before stop fails the App with `GO_LIKE_RESOURCE_CLOSED`. An `Error` resolution or a rejection fails the App with that error. The terminal promise is watched privately; it is not a public socket field.

## Readiness

`readyProbe(registry, name?)` registers a synchronous probe, default name `"app"`. It passes only while `run()` is in the ready phase, and it flips at the same moment as the `go_like.app.ready` gauge. Outside that window it throws `AppNotReadyError` (`GO_LIKE_APP_NOT_READY`) with `phase` `created`, `starting`, `stopping`, or `stopped`. After `run()` settles, the probe is removed. An App that never ran stays `created`.

`createHealthHandler(probes)` projects `/livez` and `/readyz`. Empty liveness passes. Empty readiness fails closed, so a handler without `readyProbe` or another ready probe returns 503 for `/readyz`. Every registered ready probe must pass. Core does not register a liveness probe.

An internal `newServer` listener still answers `GET` and `HEAD` `/healthz` with an empty 200. That response means the unary listener accepted the request. It is not the probe registry.

## Listeners and published ports

Examples that bind `127.0.0.1` and then call that address are the right local shape. A Docker published port can accept TCP through the proxy before the container is serving the protocol. Reach Redis, AMQP, etcd, and application HTTP on the Compose network by service DNS when that is the topology you started.

`Server.start(ctx)` on the server tier does not mean ready. `Endpointer.endpoint(ctx)` returns an address that can be advertised. `afterStart` means Core reached that hook.

`startRecoveringRabbitMqBroker` can admit a broker handle before connector setup finishes, so HTTP can bind without waiting for AMQP. Publish stays closed until a generation exists. That is admission of the handle, not a health route.

## Request path

```text
External Web
  Request -> framework or Handler -> Response -> host writes the body

Internal unary
  Context + operation
    -> Client middleware
    -> direct address or Discovery snapshot
    -> Filters, then Selector
    -> Transport
    -> POST /<service>/<endpoint>
    -> Server middleware, Struct decode, handler, Struct encode
```

Operation identity is `service/endpoint`, for example `appointment-policy.v1/check`. A `ServiceInstance` endpoint is an opaque transport address, for example `memory://orders` or `https://orders.example`.

## Runtime portability

Portable entries use standard JavaScript and Web APIs, or capabilities the caller injects. A portable entry does not promise a TCP listener, process signals, file watches, UDP multicast, or vendor client.

| Entry                                                                                         | Where it runs                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@go-like/core` concept entries, including `/web`, `/transport/http`, `/transport/memory`     | Portable. `/transport/http` dials with Fetch. Listening needs an injected host.             |
| `@go-like/core/node`, `/transport/http/node`, `/web/node`, `/config/node`                     | Node APIs. `/web/node` may also run where those APIs exist.                                 |
| `@go-like/core/web/bun`                                                                       | Bun host.                                                                                   |
| `@go-like/mdns/registry/node`, `@go-like/zookeeper/registry/node`, `@go-like/file/store/node` | Node host for that plug. The sibling entry stays portable over an injected host or factory. |
| `@go-like/connectrpc`                                                                         | Portable Fetch handler.                                                                     |
| `@go-like/connectrpc/node`                                                                    | Node gRPC server and client.                                                                |
| NATS, RabbitMQ, Redis, BullMQ                                                                 | Node and Bun, following the native client.                                                  |

Package exports do not use conditional `bun` or `node` conditions. Import the subpath you mean. The TypeScript `DOM` library supplies types. It is not a runtime polyfill.

## Composition

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { newNodeServer, port } from "@go-like/core/web/node"

const policy = defineService("policy", {
  check: {
    request: struct.object({ ok: struct.boolean() }),
    response: struct.object({ ok: struct.boolean() })
  }
})

const transport = newMemoryTransport()
const policyServer = newServer(serverTransport(transport), address("memory://policy"))
policy.registerHandler(policyServer, {
  check() {
    return { ok: true }
  }
})
const policyClient = newClient(withTransport(transport), withEndpoint("memory://policy"))
const webServer = newNodeServer((_request: Request) => new Response("ok"), port(3000))

const app = newApp(
  name("appointments"),
  server(policyServer, webServer),
  afterStop(async (ctx) => {
    await policyClient.close(ctx)
  }),
  signal()
)
void app
```

`newApp` does not become a container, and a memory transport does not become a network. Credentials, factories, and shutdown of objects the App was not given stay in the composition root.

Older design notes use names such as `ServerHandle` and `AppHandle`. The signatures on this page are the ones exported today. `Server` and `Endpointer` are exported from `@go-like/core/lifecycle`, not from the root entry.

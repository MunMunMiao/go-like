# Package and provider reference

This page is organized by the question an application is trying to answer, not by the `packages/` directory layout. Import from the smallest public package that owns the contract. Runtime-specific behavior is exposed by an explicit subpath. Provider packages are not interchangeable implementations with a single universal guarantee.

## Reading this page

- **Contract** means a portable or provider-neutral interface.
- **Provider** means an implementation backed by memory, a file, a network service, or a native library.
- **Lifecycle adapter** means a Server wrapper around an application-created native resource.
- **Evidence** identifies the kind of repository support: source/export, declared tests, or a reported local command result. It does not turn a package version into an npm or production claim.

The current source inventory is 43 non-private `@go-like/*` package manifests and 23 public source subpaths, all at version `0.0.1` in this checkout. The 44 `examples/*` workspaces are private applications, not public packages.

## Choose by job

| Job                                 | Start with                               | Add when needed                                                           | go-like does not own                                         |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Expose a Web API                    | `@go-like/web`, `@go-like/core`          | `@go-like/web/node` or a framework's native Fetch handler                 | Router, framework middleware, auth, response policy          |
| Call an internal service            | `@go-like/client`, `@go-like/transport`  | `@go-like/transport-memory`, `@go-like/transport-http`, `@go-like/struct` | Business idempotency, generated IDL, full-duplex RPC         |
| Discover service instances          | `@go-like/registry`                      | One Registry provider, filters, a Selector                                | Backend lease/revision consistency or global service locator |
| Load configuration                  | `@go-like/config`                        | env/file/YAML or one external Config provider                             | Ambient global configuration and cross-resource transactions |
| Store authoritative bytes           | `@go-like/store`                         | Memory, File, Consul, etcd, or Vault provider                             | A generic database/ORM or uniform provider guarantees        |
| Cache disposable values             | `@go-like/cache`                         | Memory or Redis provider                                                  | Authority, persistence, CAS, durable business state          |
| Publish or consume bytes            | `@go-like/broker`                        | Memory, RabbitMQ, or NATS                                                 | Universal ack/nack/term, DLQ, durable offset, exactly-once   |
| Add typed event payloads            | `@go-like/event`                         | An application Codec                                                      | Schema registry, replay, settlement policy                   |
| Run an existing scheduler or worker | `@go-like/core`                          | `@go-like/croner`, `@go-like/bullmq`, `@go-like/nats`                     | Native queue, processor, job policy, or broker connection    |
| Add operations                      | `@go-like/health`, `@go-like/resilience` | Pino, Winston, OTel, Prometheus                                           | Global instrumentation, auth, deployment policy              |

## Foundation packages

| Package               | Use it for                                                      | Principal public API                                                                                                                                                                                              | Runtime and ownership note                                                                      |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `@go-like/context`    | Explicit cancellation, deadlines, causes, and values            | `background`, `todo`, `withCancel`, `withCancelCause`, `withDeadline`, `withDeadlineCause`, `withTimeout`, `withTimeoutCause`, `cause`, `withoutCancel`, `withValue`, `afterFunc`, `canceled`, `deadlineExceeded` | Portable source contract. `Context` uses `AbortSignal` internally; it is not a Go ABI or DI bag |
| `@go-like/core`       | Compose application and resource lifecycle                      | `newApp`, `server`, `registrar`, `beforeStart`, `afterStart`, `beforeStop`, `afterStop`, `startTimeout`, `stopTimeout`, `context`, `id`, `name`, `version`, `metadata`, `endpoint`, `newContext`, `fromContext`   | Portable structural `Server` and `App`. Sibling stop calls are concurrent                       |
| `@go-like/metadata`   | Immutable multi-value metadata and explicit propagation         | metadata types and propagation functions                                                                                                                                                                          | Client and server metadata domains are separate; metadata is not trusted identity               |
| `@go-like/struct`     | Runtime Struct validation for typed endpoints and JSON          | `struct`, `Infer`, `Struct`, `StructError`, `setErrorMap`                                                                                                                                                         | Current public package. It is runtime validation, not Protobuf, IDL, or generated code          |
| `@go-like/health`     | Liveness and readiness probe registry                           | `newProbeRegistry`, `ProbeRegistry`, `Probe`, `ProbeReport`                                                                                                                                                       | Empty liveness passes; empty readiness fails closed; default probe timeout is 1,000 ms          |
| `@go-like/resilience` | Explicit retry, circuit breaker, and non-blocking rate limiting | `retry`, `exponentialBackoff`, `newCircuitBreaker`, `newTokenBucketLimiter`, `circuitOpen`                                                                                                                        | Retry authorization is caller-declared; no automatic idempotency or background limiter task     |

## Web and internal call packages

| Package                        | Use it for                                                               | Principal public API                                                                                                                                                                                         | Does not own                                                                          |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `@go-like/web`                 | Standard Web Handler and request Context bridge                          | `Handler`, `ContextHandler`, `contextHandler`                                                                                                                                                                | Routes, WebSockets, SSE policy, listener, authentication                              |
| `@go-like/web/health`          | Health Handler routes                                                    | `createHealthHandler`                                                                                                                                                                                        | Probe registration or framework route mounting                                        |
| `@go-like/web/node`            | Node listener around a Fetch Handler                                     | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`                                                                                                                                                   | Internal HTTP Transport TLS/HTTP2; use `@go-like/transport-http/node` for that        |
| `@go-like/client`              | Internal unary calls, discovery, selection, middleware, retries, pooling | `newClient`, `withTransport`, `withAddress`, `withDiscovery`, `withSelector`, `withFilter`, `withBlock`, `withRetry`, `middleware`, `use`, `circuitBreakerMiddleware`, `closeTimeout`, `poolSize`, `poolTtl` | Framework routes, business replay safety, physical socket limits                      |
| `@go-like/server`              | Internal unary Message server and route dispatch                         | `newServer`, `transport`, `address`, `advertise`, `handler`, `middleware`, `use`, `listenOption`, `rateLimitMiddleware`                                                                                      | External Fetch routes and protocol-specific business authorization                    |
| `@go-like/transport`           | Transport SPI and Message boundary                                       | `Transport`, `Client`, `Listener`, `Socket`, `Message`, `TransportInfo`, `Endpoint`, `endpoint`, `chain`, `serviceError`                                                                                     | A concrete wire unless a provider is selected; no internal full-duplex promise        |
| `@go-like/transport-memory`    | In-process unary Transport                                               | `newMemoryTransport`                                                                                                                                                                                         | Cross-process behavior, persistence, network fallback, TLS                            |
| `@go-like/transport-http`      | Fetch-backed internal HTTP Transport                                     | `newHTTPTransport`, `executor`, `maxMessageBytes`                                                                                                                                                            | A complete portable listener without an injected `HTTPHost`; native Node TLS controls |
| `@go-like/transport-http/node` | Native Node internal HTTP Transport                                      | `newNodeHTTPTransport`, `allowHTTP1`, `clientAuth`                                                                                                                                                           | Deno listener or automatic security policy                                            |

## Config packages

| Package or subpath           | Use it for                             | Principal function                                                                                                     | Boundary                                                                        |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@go-like/config`            | Config manager and object sources      | `newConfig`, `source`, `objectSource`, `schema`, `resolver`, `placeholderResolver`, `onReloadError`, `onTerminalError` | Immutable snapshots and accepted watcher lifecycle; not a Core Server by itself |
| `@go-like/config/env`        | Explicit environment record source     | `envSource`                                                                                                            | Accepts an injected record; does not read ambient runtime globals               |
| `@go-like/config/file`       | File source and JSON decoder contract  | `fileSource`, `jsonFileDecoder`                                                                                        | Needs an explicit file capability                                               |
| `@go-like/config/node`       | Node file capability                   | `newNodeFileCapability`                                                                                                | Runtime-specific Node subpath                                                   |
| `@go-like/config/yaml`       | YAML decoding into ConfigObject        | `decodeYaml`                                                                                                           | Decoding is not source watching or schema publication                           |
| `@go-like/config-consul`     | Consul HTTP configuration source       | `consulSource`, `jsonConsulDecoder`                                                                                    | Consul blocking-query and consistency behavior                                  |
| `@go-like/config-etcd`       | etcd gateway configuration source      | `etcdSource`, `jsonEtcdDecoder`                                                                                        | Revision, compaction, and gateway protocol behavior                             |
| `@go-like/config-kubernetes` | One Kubernetes ConfigMap or Secret key | `kubernetesSource`, `jsonKubernetesDecoder`                                                                            | Resource-version/relist semantics; no cross-resource transaction                |
| `@go-like/config-vault`      | Vault KV v2 source                     | `vaultSource`                                                                                                          | Vault authentication, TLS, token policy, and KV semantics                       |

Config external providers use injected standard Fetch. Credentials and redirects have provider-specific security behavior; `http` versus `https` remains an application or deployment decision unless a provider rejects it.

## Registry packages

| Package                        | Use it for                                           | Principal function                                                                                                                                 | Runtime/backend note                                                    |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `@go-like/registry`            | Contract, snapshot, filters, selectors               | `filterVersion`, `filterLabel`, `newRandomSelector`, `newRoundRobinSelector`, `newWeightedRoundRobinSelector`, `newP2CSelector`, `newEWMASelector` | Complete replacement snapshots; selection feedback is explicit          |
| `@go-like/registry/provider`   | Provider author helpers and registration diagnostics | `providerOptions`, `notifyRegistrationError`, snapshot/provider helpers                                                                            | Provider-facing subpath, not usual application entrypoint               |
| `@go-like/registry-consul`     | Consul registration and discovery                    | `newConsulRegistry`                                                                                                                                | Health-filtered, blocking-query, TTL/critical behavior is Consul-native |
| `@go-like/registry-etcd`       | etcd registration and discovery                      | `newEtcdRegistry`                                                                                                                                  | Leases, revisions, watch/relist, compaction behavior                    |
| `@go-like/registry-kubernetes` | EndpointSlice discovery and optional registration    | `newKubernetesRegistry`                                                                                                                            | Kubernetes EndpointSlice, owner references, no fabricated TTL           |
| `@go-like/registry-mdns`       | Local multicast discovery                            | `newMDNSRegistry`                                                                                                                                  | Root provider is portable by design; UDP host is `/node`                |
| `@go-like/registry-mdns/node`  | Node UDP multicast capability                        | `newNodeMDNSHost`                                                                                                                                  | Explicit Node runtime subpath                                           |
| `@go-like/registry-zookeeper`  | ZooKeeper ephemeral registration and discovery       | `newZookeeperRegistry`                                                                                                                             | Node.js and Bun documented; Deno explicitly unsupported                 |

Registry is reachability state, not durable business data. A provider may retain a last snapshot while rebuilding a transient watcher, but an authoritative empty snapshot must fail closed.

## Store and Cache packages

| Package                    | Use it for                         | Principal function                                                                                                 | Boundary                                                                                  |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `@go-like/store`           | Record contract and options        | `expiresIn`, `ifAbsent`, `ifRevision`, `prefix`, `limit`, `cursor`, `writeOptions`, `deleteOptions`, `listOptions` | Revisions, CAS, TTL, pagination; provider capabilities vary                               |
| `@go-like/store/provider`  | Provider write/delete/list helpers | `writeOptions`, `deleteOptions`, `listOptions`, snapshot and conflict helpers                                      | Provider-facing; not a durable backend by itself                                          |
| `@go-like/store-memory`    | Process-local Store tests          | `newMemoryStore`, `clock`                                                                                          | No restart durability or cross-process state                                              |
| `@go-like/store-file`      | Local file Store                   | `newFileStore`                                                                                                     | Single-owner local state; use `/node` for the Node host                                   |
| `@go-like/store-file/node` | Node file capability               | `newNodeFileStoreHost`                                                                                             | Explicit Node subpath                                                                     |
| `@go-like/store-consul`    | Consul KV Store                    | `newConsulStore`                                                                                                   | Consul sessions, TTL/CAS combinations, and uncertain mutation behavior                    |
| `@go-like/store-etcd`      | etcd KV Store                      | `newEtcdStore`                                                                                                     | Gateway, lease, revision, compaction and uncertain mutation behavior                      |
| `@go-like/store-vault`     | Vault KV v2 Store                  | `newVaultStore`                                                                                                    | Does not promise uniform Store TTL/CAS semantics                                          |
| `@go-like/cache`           | Disposable value/TTL contract      | `expiresIn`, `putOptions`                                                                                          | No CAS, revision, durability, or authority                                                |
| `@go-like/cache-memory`    | Process-local cache                | `newMemoryCache`, `clock`                                                                                          | No persistence; lazy expiry; suitable for tests and local acceleration                    |
| `@go-like/cache-redis`     | Redis-backed cache                 | `newRedisCache`                                                                                                    | Native Redis connection, URL credential handling, and runtime requirements remain visible |

## Broker, event, and work packages

| Package or subpath               | Use it for                                       | Principal function                                                             | Boundary                                                               |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `@go-like/broker`                | Byte/topic Broker contract                       | `newBrokerServer`                                                              | No portable ack/nack/term, DLQ, retry, or durable offset               |
| `@go-like/broker/provider`       | Provider terminal registration                   | `registerSubscriberTerminal`, `subscriberTerminal`                             | Provider-facing lifecycle bookkeeping                                  |
| `@go-like/broker-memory`         | Exact-topic in-process broker                    | `newMemoryBroker`                                                              | Instance-private, broadcast, no durable settlement                     |
| `@go-like/broker-rabbitmq`       | RabbitMQ borrowed, confirm, or recovering broker | `newRabbitMqBroker`, `newConfirmRabbitMqBroker`, `newRecoveringRabbitMqBroker` | `amqplib` channel/connection and native settlement semantics           |
| `@go-like/event`                 | Typed codec over a Broker                        | `eventBroker`                                                                  | Native delivery remains visible; no replay or schema registry          |
| `@go-like/nats`                  | NATS lifecycle and native broker entrypoints     | `newNatsCoreServer`, `natsCoreDrainTimeout`                                    | Core connection and subscription semantics remain native               |
| `@go-like/nats/broker`           | NATS Core Broker                                 | `newNatsCoreBroker`                                                            | Native `Msg`, queue group, drain, and at-most-once semantics           |
| `@go-like/nats/jetstream`        | JetStream ConsumerMessages lifecycle             | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout`                          | Native ConsumerMessages close/stop/closed behavior                     |
| `@go-like/nats/jetstream/broker` | Typed byte Broker over JetStream                 | `newNatsJetStreamBroker`                                                       | `JsMsg`, `PubAck`, ack/nak/term, redelivery, and DLQ remain native     |
| `@go-like/croner`                | Lifecycle for existing Croner jobs               | `newCronerServer`                                                              | Croner schedule, callback, overlap, and passive terminal semantics     |
| `@go-like/bullmq`                | Lifecycle for existing BullMQ Worker             | `newBullMqWorkerServer`, `bullMqWorkerShutdownTimeout`                         | Queue, Redis, processor, retry/backoff, stalled jobs, and job identity |

## Logging and observability packages

| Package               | Use it for                                       | Principal function                                                                                                                                                                  | Does not own                                                                |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@go-like/pino`       | Pino request/broker wrappers and drain lifecycle | `logClient`, `logUnaryMiddleware`, `logWebHandler`, `logBroker`, `newPinoServer`, `pinoDrainTimeout`                                                                                | Logger construction, destination policy, redaction, global setup            |
| `@go-like/winston`    | Winston wrappers and shutdown lifecycle          | logging wrappers, `newWinstonServer`                                                                                                                                                | Logger/transports and their native finish/close semantics                   |
| `@go-like/otel`       | Explicit OpenTelemetry trace/metric wrappers     | `newOtelServer`, `traceClient`, `traceUnaryMiddleware`, `traceWebHandler`, `traceBroker`, `measureClient`, `measureClientMiddleware`, `measureUnaryMiddleware`, `newRequestMetrics` | Global providers, exporters, context manager, automatic instrumentation     |
| `@go-like/prometheus` | Prometheus request metrics and scrape Handler    | `newRequestMetrics`, `measureClient`, `measureUnaryMiddleware`, `measureWebHandler`, `measureBroker`, `createPrometheusHandler`                                                     | Global Registry, collectors outside the supplied Registry, background tasks |

## Complete public source subpath inventory

These are the 23 explicit source subpaths declared by the current package manifests. Generated packages may add a metadata-only `./package.json` export; that is not a source API.

|   # | Subpath                          | Principal exports                                          | Audience                      |
| --: | -------------------------------- | ---------------------------------------------------------- | ----------------------------- |
|   1 | `@go-like/broker/provider`       | `registerSubscriberTerminal`, `subscriberTerminal`         | Provider authors              |
|   2 | `@go-like/cache/provider`        | `putOptions`                                               | Provider authors              |
|   3 | `@go-like/config/env`            | `envSource`                                                | Application authors           |
|   4 | `@go-like/config/file`           | `fileSource`, `jsonFileDecoder`                            | Application authors           |
|   5 | `@go-like/config/node`           | `newNodeFileCapability`                                    | Node runtime authors          |
|   6 | `@go-like/config/yaml`           | `decodeYaml`                                               | Application authors           |
|   7 | `@go-like/core/lifecycle`        | `waitForContext`                                           | Lifecycle/provider authors    |
|   8 | `@go-like/core/node`             | `signal`                                                   | Node/Bun process integration  |
|   9 | `@go-like/nats/broker`           | `newNatsCoreBroker`                                        | NATS Core applications        |
|  10 | `@go-like/nats/jetstream`        | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout`      | JetStream applications        |
|  11 | `@go-like/nats/jetstream/broker` | `newNatsJetStreamBroker`                                   | JetStream Broker applications |
|  12 | `@go-like/registry/provider`     | provider options and snapshot helpers                      | Provider authors              |
|  13 | `@go-like/registry-mdns/node`    | `newNodeMDNSHost`                                          | Node mDNS applications        |
|  14 | `@go-like/store/provider`        | write/delete/list options and snapshots                    | Provider authors              |
|  15 | `@go-like/store-file/node`       | `newNodeFileStoreHost`                                     | Node file Store applications  |
|  16 | `@go-like/struct/codec`          | `encodeJson`, `decodeJson`                                 | Typed contract authors        |
|  17 | `@go-like/struct/runtime`        | introspection and parsing helpers                          | Runtime/provider authors      |
|  18 | `@go-like/transport/headers`     | `Go-Like-*` header constants                               | Transport/provider authors    |
|  19 | `@go-like/transport/json`        | `encodeJsonBody`, `decodeJsonBody`, `jsonContentType`      | Typed/raw transport authors   |
|  20 | `@go-like/transport/provider`    | Message, metadata, ServiceError codecs and errors          | Provider authors              |
|  21 | `@go-like/transport-http/node`   | `newNodeHTTPTransport`, `allowHTTP1`, `clientAuth`         | Node HTTP applications        |
|  22 | `@go-like/web/health`            | `createHealthHandler`                                      | Web applications              |
|  23 | `@go-like/web/node`              | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout` | Node Web host applications    |

The current TypeScript configuration contains stale path mappings for `@go-like/otel/testing` and `@go-like/web/node/testing`, but those are not current package manifest exports. Do not document them as public entrypoints until the repository reconciles them.

## Runtime decision matrix

| Entry or provider family                                       | Portable source                    | Bun/Node native                                        | Deno claim                                  | Evidence wording                                                      |
| -------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------- |
| Context, Core root, Health, Metadata, Resilience, Struct       | Yes                                | No native import required                              | Selected runtime lanes are declared         | Source contract; check current executed matrix before release wording |
| Web root and Web health                                        | Yes                                | Host required separately                               | Standard Handler boundary                   | Handler is portable; a Handler is not a listener                      |
| Memory Transport, Memory Store, Memory Cache, Memory Broker    | Process-local source               | No external service                                    | Same process-local meaning                  | Not distributed, durable, or cross-process                            |
| HTTP root and Fetch-backed Config/Registry/Store providers     | Injected Fetch                     | Runtime chooses Fetch                                  | Source-backed where the package lane exists | Portable by source or declared runtime lane, not universal parity     |
| `/node` subpaths                                               | No                                 | Node-specific, with some Bun execution possible        | No Deno entrypoint                          | Explicit import changes runtime graph                                 |
| NATS, RabbitMQ, BullMQ, Redis, Pino, Winston, OTel native SDKs | Provider-dependent                 | Node/Bun fixtures or package-specific runtime evidence | Do not infer Deno support                   | Read the provider README and E2E scope                                |
| ZooKeeper                                                      | No Deno support in provider README | Node/Bun                                               | Explicitly unsupported                      | Do not generalize from Registry root                                  |

## Function selection rules

- Use `contextHandler` at the Web edge when you need Context, not a custom framework request bag.
- Use `newApp` and `server(...)` when one process has more than one admitted resource or when signal and shutdown ownership should be explicit.
- Use typed `endpoint(...)` and `handler(contract, fn)` when both sides should share runtime Struct validation. Use raw `handler(service, endpoint, fn)` when the application owns a different byte contract.
- Use `withAddress(...)` before Discovery. It is easier to test and makes destination identity explicit.
- Use `withDiscovery(...)`, `withSelector(...)`, `withFilter(...)`, and `withBlock()` only when the service needs the control-plane behavior they add.
- Use `withRetry(...)` only after writing down replay authorization, maximum total attempts, failure predicate, and business idempotency.
- Use `newMemoryStore` for deterministic tests, not for a durability claim.
- Use `newMemoryCache` for disposable acceleration, not as the appointment or payment authority.
- Use `newBrokerServer` to attach one subscription to Core, not to obtain a universal queue worker or settlement API.
- Use `newOtelServer`, `newPinoServer`, `newWinstonServer`, or a Prometheus Handler only after the application has created the native provider or registry.

## Explicit exclusions

No package in the current public inventory should be documented as owning gRPC, Protobuf, IDL code generation, generated RPC clients, internal full-duplex streams, Event Store/history/replay, generic authentication/authorization, ORM behavior, a global service locator, or cluster orchestration. A provider or application may use an unrelated library for one of those concerns, but that would be outside go-like's current contract.

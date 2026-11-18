# Packages

The workspace contains **20** public `@go-like/*` packages, each at version `0.0.1` in this checkout. The root workspace is private. The version does not establish npm availability. The 44 `examples/*` directories are private applications.

There are **75** public entries: 41 on `@go-like/core` and 34 on the plugs and the generator. A generated `dist/package.json` `./package.json` export is metadata, not another entry.

`@go-like/core` has no third-party runtime dependency. Every other package except `@go-like/protoc-gen-like` peer-depends on the same core version. The generator does not depend on core. Plug behavior and limits are in each plug README. This page is the inventory.

## The 20 packages

| Package                    | Entries                                  | Fills                                                        |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `@go-like/core`            | 41                                       | Sockets, mechanisms, memory references, and runtime bindings |
| `@go-like/otel`            | `.`                                      | Tracer, meter, log handler, propagator                       |
| `@go-like/pino`            | `./log`                                  | `LogHandler`                                                 |
| `@go-like/winston`         | `./log`                                  | `LogHandler`                                                 |
| `@go-like/prometheus`      | `./metric`                               | `MeterProvider` and a scrape `Handler`                       |
| `@go-like/consul`          | `.`, `./registry`, `./config`, `./store` | Shared client, registry, config, store                       |
| `@go-like/etcd`            | `.`, `./registry`, `./config`, `./store` | Shared client, registry, config, store                       |
| `@go-like/vault`           | `.`, `./config`, `./store`               | Shared client, config, store                                 |
| `@go-like/kubernetes`      | `.`, `./registry`, `./config`            | Shared client, registry, config                              |
| `@go-like/zookeeper`       | `./registry`, `./registry/node`          | Registry over a client factory; Node factory                 |
| `@go-like/mdns`            | `./registry`, `./registry/node`          | Registry over an `MDNSHost`; Node host                       |
| `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                                              |
| `@go-like/nats`            | `./broker`, `./jetstream`                | Core and JetStream brokers                                   |
| `@go-like/rabbitmq`        | `./broker`                               | Broker                                                       |
| `@go-like/redis`           | `./cache`                                | Cache and a resource-tier `Server`                           |
| `@go-like/bullmq`          | `./job`                                  | `JobQueue` and a resource-tier `Server`                      |
| `@go-like/croner`          | `./job`                                  | `Schedule`                                                   |
| `@go-like/file`            | `./store`, `./store/node`                | Store and a resource-tier `Server`; Node host                |
| `@go-like/connectrpc`      | `.`, `./node`                            | Fetch handler; Node gRPC server and client                   |
| `@go-like/protoc-gen-like` | `.`                                      | Buf plugin and `bin`. No socket                              |

Count: 41 + 4 + 8 + 6 + 10 + 6 = 75. The plug and generator entries are the 34 after core's 41.

## Core entries

| Entry                               | Role         | First exports                                                                           |
| ----------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `@go-like/core`                     | App          | `newApp`, `telemetry`, `resources`, `server`, `registrar`, `readyProbe`, hooks, budgets |
| `@go-like/core/node`                | Node binding | `signal`                                                                                |
| `@go-like/core/lifecycle`           | Socket       | `Server`, `Endpointer`, `newResourceServer`                                             |
| `@go-like/core/context`             | Socket       | `background`, `withCancel`, `withTimeout`, `waitForContext`                             |
| `@go-like/core/metadata`            | Mechanism    | `newMetadata`, client and server Context helpers                                        |
| `@go-like/core/struct`              | Mechanism    | `struct`, `StructError`, `encodeJson`, `decodeJson`, `jsonCodec`                        |
| `@go-like/core/health`              | Socket       | `newProbeRegistry`                                                                      |
| `@go-like/core/resilience`          | Socket       | `retry`, `newCircuitBreaker`, `newTokenBucketLimiter`                                   |
| `@go-like/core/telemetry`           | Socket       | `newTelemetry`, `withTelemetry`, semantic-convention constants                          |
| `@go-like/core/telemetry/provider`  | Plug SDK     | `beginUnit`, `logCorrelation`, `resourceFromContext`                                    |
| `@go-like/core/log`                 | Socket       | `log`, `info`, `error`, `LogHandler`                                                    |
| `@go-like/core/trace`               | Socket       | `inSpan`, `newTraceContextPropagator`                                                   |
| `@go-like/core/metric`              | Socket       | `newCounter`, `newHistogram`, `newGauge`, `newUpDownCounter`                            |
| `@go-like/core/testing`             | Tests        | `newTelemetryRecorder`, `<concept>Conformance`                                          |
| `@go-like/core/transport`           | Socket       | `defineService`, `serviceError`, `isServiceError`, `ServerStream`                       |
| `@go-like/core/transport/provider`  | Plug SDK     | Transport error factories, `newServerContext`                                           |
| `@go-like/core/transport/memory`    | Reference    | `newMemoryTransport`                                                                    |
| `@go-like/core/transport/http`      | Reference    | `newHTTPTransport`                                                                      |
| `@go-like/core/transport/http/node` | Node binding | `newNodeHTTPTransport`                                                                  |
| `@go-like/core/server`              | Mechanism    | `newServer`, `address`, `advertise`, `rateLimitMiddleware`                              |
| `@go-like/core/client`              | Mechanism    | `newClient`, `withEndpoint`, `withDiscovery`, `withRetry`, `circuitBreakerMiddleware`   |
| `@go-like/core/web`                 | Socket       | `Handler`, `contextHandler`, `requestContext`, `createHealthHandler`                    |
| `@go-like/core/web/node`            | Node binding | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`                              |
| `@go-like/core/web/bun`             | Bun binding  | `newBunServer`, `hostname`, `port`, `bunShutdownTimeout`                                |
| `@go-like/core/registry`            | Socket       | selectors, filters, `newDiscoveryResolver`, `selectEndpoint`                            |
| `@go-like/core/registry/provider`   | Plug SDK     | `newSnapshotWatcher`, `startHeartbeat`                                                  |
| `@go-like/core/registry/memory`     | Reference    | `newMemoryRegistry`                                                                     |
| `@go-like/core/config`              | Socket       | `newConfig`, `objectSource`, `envSource`, `fileSource`, `jsonDecoder`                   |
| `@go-like/core/config/provider`     | Plug SDK     | `newSourceWatcher`, `admitConfigObject`                                                 |
| `@go-like/core/config/node`         | Node binding | `newNodeFileCapability`                                                                 |
| `@go-like/core/fetch`               | Socket       | `Fetch`, `newFetchClient`                                                               |
| `@go-like/core/cache`               | Socket       | `Cache`, `expiresIn`                                                                    |
| `@go-like/core/cache/memory`        | Reference    | `newMemoryCache`                                                                        |
| `@go-like/core/store`               | Socket       | `Store`, `ifAbsent`, `ifRevision`, `StoreConflictError`                                 |
| `@go-like/core/store/provider`      | Plug SDK     | Option parsers, conflict factory                                                        |
| `@go-like/core/store/memory`        | Reference    | `newMemoryStore`                                                                        |
| `@go-like/core/broker`              | Socket       | `Broker`, `newBrokerServer`, `eventBroker`                                              |
| `@go-like/core/broker/provider`     | Plug SDK     | `deliver`, `publish`                                                                    |
| `@go-like/core/broker/memory`       | Reference    | `newMemoryBroker`                                                                       |
| `@go-like/core/job`                 | Socket       | `newScheduleServer`, `newIntervalSchedule`, `JobQueue`                                  |
| `@go-like/core/job/provider`        | Plug SDK     | `runJob`, `enqueue`, `dispatchJob`                                                      |

`@go-like/core/server` and `@go-like/core/client` both export `middleware` and `use`. Import one as a namespace when a file needs both. The root entry's `context`, `endpoint`, `server`, and `metadata` options are App options. Import the root as a namespace when those names collide with OpenTelemetry or with `defineService`.

Application code does not import `/provider` or `/testing` except tests and plug implementations.

## Runtime subpaths

Import the subpath you intend. Exports are not conditional on `bun` or `node`.

- Node: `@go-like/core/node`, `@go-like/core/transport/http/node`, `@go-like/core/web/node`, `@go-like/core/config/node`, `@go-like/mdns/registry/node`, `@go-like/zookeeper/registry/node`, `@go-like/file/store/node`, `@go-like/connectrpc/node`.
- Bun host: `@go-like/core/web/bun`.
- NATS, RabbitMQ, Redis, and BullMQ follow their native clients on Node and Bun.

## What this catalog leaves out

Memory references are process-local. A plug README is the limit for leases, acknowledgement, TTL, and transactions. [Providers](/reference/providers) links those READMEs. [Errors](/reference/errors) lists the public codes. [Migration](/guide/migration) maps historical specifiers onto this table.

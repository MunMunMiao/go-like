# Packages

The current source manifests contain **43 non-private `@go-like/*` packages**. Every package is version `0.0.1` in this checkout. The root workspace is private, and repository documentation says these packages are not yet published to npm. The 44 `examples/*` directories are private workspace applications, not public packages.

Use [Providers](/reference/providers) for the detailed “what to use, when, and what it does not own” reference. This page is the inventory and import map.

## Package inventory

| Capability                  | Public packages                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundations                 | `@go-like/context`, `@go-like/core`, `@go-like/metadata`, `@go-like/struct`, `@go-like/health`, `@go-like/resilience`                                                                                       |
| Web and internal calls      | `@go-like/web`, `@go-like/client`, `@go-like/server`, `@go-like/transport`, `@go-like/transport-http`, `@go-like/transport-memory`                                                                          |
| Configuration               | `@go-like/config`, `@go-like/config-consul`, `@go-like/config-etcd`, `@go-like/config-kubernetes`, `@go-like/config-vault`                                                                                  |
| Registration and selection  | `@go-like/registry`, `@go-like/registry-consul`, `@go-like/registry-etcd`, `@go-like/registry-kubernetes`, `@go-like/registry-mdns`, `@go-like/registry-zookeeper`                                          |
| Records and cache           | `@go-like/store`, `@go-like/store-consul`, `@go-like/store-etcd`, `@go-like/store-file`, `@go-like/store-memory`, `@go-like/store-vault`, `@go-like/cache`, `@go-like/cache-memory`, `@go-like/cache-redis` |
| Broker and events           | `@go-like/broker`, `@go-like/broker-memory`, `@go-like/broker-rabbitmq`, `@go-like/event`, `@go-like/nats`                                                                                                  |
| Jobs and lifecycle adapters | `@go-like/croner`, `@go-like/bullmq`                                                                                                                                                                        |
| Logging and observability   | `@go-like/pino`, `@go-like/winston`, `@go-like/otel`, `@go-like/prometheus`                                                                                                                                 |

Count check: 6 + 6 + 5 + 6 + 9 + 5 + 2 + 4 = 43.

## Core import map

| Need                        | Import                                      | First API to read                                        |
| --------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Cancellation or deadline    | `@go-like/context`                          | `background`, `withCancel`, `withTimeout`, `cause`       |
| App lifecycle               | `@go-like/core`                             | `newApp`, `server`, hooks, `stopTimeout`                 |
| Process signals             | `@go-like/core/node`                        | `signal`                                                 |
| Web handler                 | `@go-like/web`                              | `Handler`, `contextHandler`                              |
| Node Web host               | `@go-like/web/node`                         | `newNodeServer`, `hostname`, `port`                      |
| Internal unary contract     | `@go-like/transport`                        | `Message`, `Endpoint`, `endpoint`, `serviceError`        |
| Typed runtime validation    | `@go-like/struct`                           | `struct`, `Infer`, `StructError`                         |
| Internal Client             | `@go-like/client`                           | `newClient`, `withTransport`, `withAddress`, `withRetry` |
| Internal Server             | `@go-like/server`                           | `newServer`, `handler`, `address`, `advertise`           |
| In-process transport        | `@go-like/transport-memory`                 | `newMemoryTransport`                                     |
| Fetch-backed HTTP transport | `@go-like/transport-http`                   | `newHTTPTransport`                                       |
| Native Node HTTP/TLS        | `@go-like/transport-http/node`              | `newNodeHTTPTransport`, `clientAuth`, `allowHTTP1`       |
| Discovery and selection     | `@go-like/registry`                         | `Discovery`, `Watcher`, `filterVersion`, selectors       |
| Configuration               | `@go-like/config`                           | `newConfig`, `source`, `objectSource`                    |
| Durable records             | `@go-like/store`                            | `Store`, `ifAbsent`, `ifRevision`, `prefix`              |
| Disposable values           | `@go-like/cache`                            | `Cache`, `expiresIn`                                     |
| Broker bytes                | `@go-like/broker`                           | `Broker`, `BrokerEvent`, `newBrokerServer`               |
| Typed broker payloads       | `@go-like/event`                            | `Codec`, `eventBroker`                                   |
| Health                      | `@go-like/health` and `@go-like/web/health` | `newProbeRegistry`, `createHealthHandler`                |
| Retry/circuit/rate limit    | `@go-like/resilience`                       | `retry`, `newCircuitBreaker`, `newTokenBucketLimiter`    |

## All 23 public source subpaths

|   # | Public entrypoint                | Main exports                                                 |
| --: | -------------------------------- | ------------------------------------------------------------ |
|   1 | `@go-like/broker/provider`       | `registerSubscriberTerminal`, `subscriberTerminal`           |
|   2 | `@go-like/cache/provider`        | `putOptions`                                                 |
|   3 | `@go-like/config/env`            | `envSource`                                                  |
|   4 | `@go-like/config/file`           | `fileSource`, `jsonFileDecoder`                              |
|   5 | `@go-like/config/node`           | `newNodeFileCapability`                                      |
|   6 | `@go-like/config/yaml`           | `decodeYaml`                                                 |
|   7 | `@go-like/core/lifecycle`        | `waitForContext`                                             |
|   8 | `@go-like/core/node`             | `signal`                                                     |
|   9 | `@go-like/nats/broker`           | `newNatsCoreBroker`                                          |
|  10 | `@go-like/nats/jetstream`        | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout`        |
|  11 | `@go-like/nats/jetstream/broker` | `newNatsJetStreamBroker`                                     |
|  12 | `@go-like/registry/provider`     | provider options, snapshot helpers, registration diagnostics |
|  13 | `@go-like/registry-mdns/node`    | `newNodeMDNSHost`                                            |
|  14 | `@go-like/store/provider`        | Store option and snapshot helpers                            |
|  15 | `@go-like/store-file/node`       | `newNodeFileStoreHost`                                       |
|  16 | `@go-like/struct/codec`          | `encodeJson`, `decodeJson`                                   |
|  17 | `@go-like/struct/runtime`        | Struct introspection and parsing helpers                     |
|  18 | `@go-like/transport/headers`     | `Go-Like-*` and `Content-Type` constants                     |
|  19 | `@go-like/transport/json`        | `encodeJsonBody`, `decodeJsonBody`, `jsonContentType`        |
|  20 | `@go-like/transport/provider`    | metadata, Message, ServiceError codecs and errors            |
|  21 | `@go-like/transport-http/node`   | `newNodeHTTPTransport`, `allowHTTP1`, `clientAuth`           |
|  22 | `@go-like/web/health`            | `createHealthHandler`                                        |
|  23 | `@go-like/web/node`              | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`   |

Generated `dist/package.json` files add a metadata-only `./package.json` export. That generated export is not a package and is not counted above.

## Runtime subpaths and stale aliases

Runtime selection is explicit in package names. Current Node-oriented subpaths include:

- `@go-like/config/node`;
- `@go-like/core/node`;
- `@go-like/registry-mdns/node`;
- `@go-like/store-file/node`;
- `@go-like/transport-http/node`;
- `@go-like/web/node`.

The current TypeScript base configuration contains aliases for `@go-like/otel/testing` and `@go-like/web/node/testing`, but the package manifests do not export those paths. They are not public entrypoints for application documentation.

## What is not in this catalog

This catalog does not claim gRPC, Protobuf, IDL generation, generated RPC code, full-duplex internal RPC streams, Event Store/history/replay, generic auth, ORM, global DI, or cluster orchestration. Standard Web streaming and third-party provider features may exist outside go-like's internal contract; see [Streaming](/guide/streaming) and [Comparison](/guide/comparison).

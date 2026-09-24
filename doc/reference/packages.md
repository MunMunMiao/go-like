# Packages

The current source manifests contain **45 non-private `@go-like/*` packages**. Every package is version `0.0.1` in this checkout. The root workspace is private, and the manifest versions do not establish npm availability. The 44 `examples/*` directories are private workspace applications, not public packages.

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
| Generated RPC and codegen   | `@go-like/transport-grpc-buf`, `@go-like/protoc-gen-like`                                                                                                                                                   |

Count check: 6 + 6 + 5 + 6 + 9 + 5 + 2 + 4 + 2 = 45.

## Core import map

| Need                        | Import                                      | First API to read                                             |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| Cancellation or deadline    | `@go-like/context`                          | `background`, `withCancel`, `withTimeout`, `cause`            |
| App lifecycle               | `@go-like/core`                             | `newApp`, `server`, hooks, `stopTimeout`                      |
| Process signals             | `@go-like/core/node`                        | `signal`                                                      |
| Web handler                 | `@go-like/web`                              | `Handler`, `contextHandler`                                   |
| Node Web host               | `@go-like/web/node`                         | `newNodeServer`, `hostname`, `port`                           |
| Internal unary contract     | `@go-like/transport`                        | `Message`, `Endpoint`, `endpoint`, `serviceError`             |
| Typed runtime validation    | `@go-like/struct`                           | `struct`, `Infer`, `StructError`                              |
| Internal Client             | `@go-like/client`                           | `newClient`, `withTransport`, `withAddress`, `withService`    |
| Shared Discovery resolver   | `@go-like/client/discovery`                 | `newDiscoveryResolver`, `DiscoveryResolver`                   |
| Internal Server             | `@go-like/server`                           | `newServer`, `Server.registerHandler`, `address`, `advertise` |
| In-process transport        | `@go-like/transport-memory`                 | `newMemoryTransport`                                          |
| Fetch-backed HTTP transport | `@go-like/transport-http`                   | `newHTTPTransport`                                            |
| Native Node HTTP/TLS        | `@go-like/transport-http/node`              | `newNodeHTTPTransport`, `clientAuth`, `allowHTTP1`            |
| Portable generated RPC      | `@go-like/transport-grpc-buf`               | `newHandler`, `fromHandlerContext`, `callOptions`             |
| Managed standard gRPC       | `@go-like/transport-grpc-buf/native`        | `newClient`, `newServer`, construction options                |
| Project-local RPC codegen   | `@go-like/protoc-gen-like`                  | `protoc-gen-like` Node binary, `protocGenLike`                |
| Discovery and selection     | `@go-like/registry`                         | `Discovery`, `Watcher`, `filterVersion`, selectors            |
| Configuration               | `@go-like/config`                           | `newConfig`, `source`, `objectSource`                         |
| Records                     | `@go-like/store`                            | `Store`, `ifAbsent`, `ifRevision`, `prefix`                   |
| Disposable values           | `@go-like/cache`                            | `Cache`, `expiresIn`                                          |
| Broker bytes                | `@go-like/broker`                           | `Broker`, `BrokerEvent`, `newBrokerServer`                    |
| Typed broker payloads       | `@go-like/event`                            | `Codec`, `eventBroker`                                        |
| Health                      | `@go-like/health` and `@go-like/web/health` | `newProbeRegistry`, `createHealthHandler`                     |
| Retry/circuit/rate limit    | `@go-like/resilience`                       | `retry`, `newCircuitBreaker`, `newTokenBucketLimiter`         |

## All 25 public source subpaths

|   # | Public entrypoint                    | Main exports                                                 |
| --: | ------------------------------------ | ------------------------------------------------------------ |
|   1 | `@go-like/broker/provider`           | `registerSubscriberTerminal`, `subscriberTerminal`           |
|   2 | `@go-like/cache/provider`            | `putOptions`                                                 |
|   3 | `@go-like/client/discovery`          | `newDiscoveryResolver`, `DiscoveryResolver`                  |
|   4 | `@go-like/config/env`                | `envSource`                                                  |
|   5 | `@go-like/config/file`               | `fileSource`, `jsonFileDecoder`                              |
|   6 | `@go-like/config/node`               | `newNodeFileCapability`                                      |
|   7 | `@go-like/config/yaml`               | `decodeYaml`                                                 |
|   8 | `@go-like/core/lifecycle`            | `waitForContext`                                             |
|   9 | `@go-like/core/node`                 | `signal`                                                     |
|  10 | `@go-like/nats/broker`               | `newNatsCoreBroker`                                          |
|  11 | `@go-like/nats/jetstream`            | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout`        |
|  12 | `@go-like/nats/jetstream/broker`     | `newNatsJetStreamBroker`                                     |
|  13 | `@go-like/registry/provider`         | provider options, snapshot helpers, registration diagnostics |
|  14 | `@go-like/registry-mdns/node`        | `newNodeMDNSHost`                                            |
|  15 | `@go-like/store/provider`            | Store option and snapshot helpers                            |
|  16 | `@go-like/store-file/node`           | `newNodeFileStoreHost`                                       |
|  17 | `@go-like/struct/codec`              | `encodeJson`, `decodeJson`                                   |
|  18 | `@go-like/struct/runtime`            | Struct introspection and parsing helpers                     |
|  19 | `@go-like/transport/headers`         | `Go-Like-*` and `Content-Type` constants                     |
|  20 | `@go-like/transport/json`            | `encodeJsonBody`, `decodeJsonBody`, `jsonContentType`        |
|  21 | `@go-like/transport/provider`        | metadata, Message, ServiceError codecs and errors            |
|  22 | `@go-like/transport-grpc-buf/native` | managed standard-gRPC `newClient`, `newServer`, options      |
|  23 | `@go-like/transport-http/node`       | `newNodeHTTPTransport`, `allowHTTP1`, `clientAuth`           |
|  24 | `@go-like/web/health`                | `createHealthHandler`                                        |
|  25 | `@go-like/web/node`                  | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`   |

Generated `dist/package.json` files add a metadata-only `./package.json` export. That generated export is not a package and is not counted above.

## Runtime subpaths and stale aliases

Runtime selection is explicit in package names. Current Node-oriented subpaths include:

- `@go-like/config/node`;
- `@go-like/core/node`;
- `@go-like/registry-mdns/node`;
- `@go-like/store-file/node`;
- `@go-like/transport-http/node`;
- `@go-like/web/node`.

`@go-like/transport-grpc-buf/native` is capability-specific rather than runtime-named: Node is supported by upstream
Connect-ES, while Bun 1.4.0 and Deno 2.9.5 are pinned LikeGo compatibility targets using the same public API.
Subsequent slow-consumer drain tests fail on Deno 2.9.5 and 2.9.7; see the [native gRPC drain status](/reference/claims#native-grpc-drain-status) before treating the four-cardinality result as production shutdown evidence.

The package manifests do not export `@go-like/otel/testing` or `@go-like/web/node/testing`; neither is a public entrypoint for application documentation.

## What is not in this catalog

This catalog includes generated ctx-first Protobuf RPC glue, a portable Connect/gRPC-Web Fetch bridge, and managed standard-gRPC owners at `/native`. Portable Fetch is limited to unary/server-streaming; managed standard gRPC covers all four cardinalities in the pinned Node 26.7.0, Bun 1.4.0, and Deno 2.9.5 physical-package matrix. It does not claim browser standard gRPC, official health/reflection, validation, canonical error-details mapping, a Google gRPC runtime, Buf online services, or future runtime-version compatibility. It also does not claim Event Store/history/replay, generic auth, ORM, global DI, or cluster orchestration. Standard Web streaming and third-party provider features may exist outside go-like's internal contract; see [Streaming](/guide/streaming) and [Comparison](/guide/comparison).

For the tested Connect, Bun Fetch, and Deno cancellation/drain limitations, see the [claims ledger](/reference/claims#stream-cancellation-limits). Interoperability results do not establish production shutdown or stream cleanup.

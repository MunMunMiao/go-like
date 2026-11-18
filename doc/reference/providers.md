# Providers

Each ecosystem plug has its own README for options, native ownership, and error fields. This page is the index. Concept entries live on `@go-like/core` and are listed in [Packages](/reference/packages).

The application constructs the native client and passes it in. Plugs that share a protocol share one root client. Each socket is a separate subpath. README paths below are files in this repository.

## Telemetry

| Plug                  | README                          | Constructors                                                                              |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@go-like/otel`       | `packages/otel/README.md`       | `newOtelTracerProvider`, `newOtelMeterProvider`, `newOtelLogHandler`, `newOtelPropagator` |
| `@go-like/pino`       | `packages/pino/README.md`       | `newPinoHandler` from `@go-like/pino/log`                                                 |
| `@go-like/winston`    | `packages/winston/README.md`    | `newWinstonHandler` from `@go-like/winston/log`                                           |
| `@go-like/prometheus` | `packages/prometheus/README.md` | `newPrometheusMeterProvider`, `createPrometheusHandler` from `@go-like/prometheus/metric` |

Install the bundle with `telemetry(tel)`. The guide is [Health and observability](/guide/health-observability). Winston needs an Error-aware format in front of `format.json()`.

## Registries, config, and stores

| Plug                  | README                          | Entries                                  |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `@go-like/consul`     | `packages/consul/README.md`     | `.`, `./registry`, `./config`, `./store` |
| `@go-like/etcd`       | `packages/etcd/README.md`       | `.`, `./registry`, `./config`, `./store` |
| `@go-like/vault`      | `packages/vault/README.md`      | `.`, `./config`, `./store`               |
| `@go-like/kubernetes` | `packages/kubernetes/README.md` | `.`, `./registry`, `./config`            |
| `@go-like/zookeeper`  | `packages/zookeeper/README.md`  | `./registry`, `./registry/node`          |
| `@go-like/mdns`       | `packages/mdns/README.md`       | `./registry`, `./registry/node`          |
| `@go-like/yaml`       | `packages/yaml/README.md`       | `./config` (`decodeYaml`)                |
| `@go-like/file`       | `packages/file/README.md`       | `./store`, `./store/node`                |

Shared HTTP, transport, and protocol errors are exported from the package root. Store-only outcomes stay on the store entry. See [Error handling](/reference/errors).

## Brokers, cache, and jobs

| Plug                | README                        | Entry                     |
| ------------------- | ----------------------------- | ------------------------- |
| `@go-like/nats`     | `packages/nats/README.md`     | `./broker`, `./jetstream` |
| `@go-like/rabbitmq` | `packages/rabbitmq/README.md` | `./broker`                |
| `@go-like/redis`    | `packages/redis/README.md`    | `./cache`                 |
| `@go-like/bullmq`   | `packages/bullmq/README.md`   | `./job`                   |
| `@go-like/croner`   | `packages/croner/README.md`   | `./job`                   |

The guide is [Broker, events, and jobs](/guide/broker-events).

## RPC

| Package                    | README                               | Entry                                     |
| -------------------------- | ------------------------------------ | ----------------------------------------- |
| `@go-like/connectrpc`      | `packages/connectrpc/README.md`      | `.` Fetch handler, `./node` standard gRPC |
| `@go-like/protoc-gen-like` | `packages/protoc-gen-like/README.md` | Generator binary. No runtime socket       |

The guide is [Streaming](/guide/streaming).

## Core

Memory transports, caches, stores, brokers, and the App itself are `@go-like/core` entries, not plugs. The package README indexes those 41 entries: `packages/core/README.md`.

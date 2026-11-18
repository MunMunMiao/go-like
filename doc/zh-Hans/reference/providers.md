# 插头

每个生态插头都有自己的 README，说明选项、原生所有权和错误字段。本页是索引。概念入口位于 `@go-like/core`，列在[包参考](/zh-Hans/reference/packages)。

应用构造原生客户端并传进去。共用一种协议的插头共用一个根客户端。每个插座是单独的子路径。下面的 README 路径是本仓库中的文件。

## 观测

| 插头                  | README                          | 构造函数                                                                                  |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@go-like/otel`       | `packages/otel/README.md`       | `newOtelTracerProvider`、`newOtelMeterProvider`、`newOtelLogHandler`、`newOtelPropagator` |
| `@go-like/pino`       | `packages/pino/README.md`       | `@go-like/pino/log` 的 `newPinoHandler`                                                   |
| `@go-like/winston`    | `packages/winston/README.md`    | `@go-like/winston/log` 的 `newWinstonHandler`                                             |
| `@go-like/prometheus` | `packages/prometheus/README.md` | `@go-like/prometheus/metric` 的 `newPrometheusMeterProvider`、`createPrometheusHandler`   |

用 `telemetry(tel)` 安装这份 bundle。指南是[健康与可观测性](/zh-Hans/guide/health-observability)。Winston 需要在 `format.json()` 之前放一个能识别 Error 的 format。

## 注册中心、配置与存储

| 插头                  | README                          | 入口                                     |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `@go-like/consul`     | `packages/consul/README.md`     | `.`、`./registry`、`./config`、`./store` |
| `@go-like/etcd`       | `packages/etcd/README.md`       | `.`、`./registry`、`./config`、`./store` |
| `@go-like/vault`      | `packages/vault/README.md`      | `.`、`./config`、`./store`               |
| `@go-like/kubernetes` | `packages/kubernetes/README.md` | `.`、`./registry`、`./config`            |
| `@go-like/zookeeper`  | `packages/zookeeper/README.md`  | `./registry`、`./registry/node`          |
| `@go-like/mdns`       | `packages/mdns/README.md`       | `./registry`、`./registry/node`          |
| `@go-like/yaml`       | `packages/yaml/README.md`       | `./config`（`decodeYaml`）               |
| `@go-like/file`       | `packages/file/README.md`       | `./store`、`./store/node`                |

共享的 HTTP、传输和协议错误从包根导出。仅属于 store 的结果留在 store 入口上。见[错误处理](/reference/errors)。

## Broker、缓存与任务

| 插头                | README                        | 入口                      |
| ------------------- | ----------------------------- | ------------------------- |
| `@go-like/nats`     | `packages/nats/README.md`     | `./broker`、`./jetstream` |
| `@go-like/rabbitmq` | `packages/rabbitmq/README.md` | `./broker`                |
| `@go-like/redis`    | `packages/redis/README.md`    | `./cache`                 |
| `@go-like/bullmq`   | `packages/bullmq/README.md`   | `./job`                   |
| `@go-like/croner`   | `packages/croner/README.md`   | `./job`                   |

指南是[消息、事件与任务](/zh-Hans/guide/broker-events)。

## RPC

| 包                         | README                               | 入口                                  |
| -------------------------- | ------------------------------------ | ------------------------------------- |
| `@go-like/connectrpc`      | `packages/connectrpc/README.md`      | `.` Fetch handler，`./node` 标准 gRPC |
| `@go-like/protoc-gen-like` | `packages/protoc-gen-like/README.md` | 生成器二进制。没有运行时插座          |

指南是[流式传输](/zh-Hans/guide/streaming)。

## Core

Memory 传输、缓存、存储、broker 和 App 本身是 `@go-like/core` 的入口，不是插头。包 README 索引那 41 个入口：`packages/core/README.md`。

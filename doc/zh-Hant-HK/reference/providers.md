# Provider

每隻生態插頭有自己嘅 README，講 option、原生持有同錯誤欄位。呢頁係索引。概念入口喺 `@go-like/core`，列喺[套件](/zh-Hant-HK/reference/packages)。

應用建立原生 client 再傳入。共用協議嘅插頭共用一個根 client。每個插座係獨立 subpath。下面嘅 README 路徑係呢個 repo 入面嘅檔案。

## 遙測

| 插頭                  | README                          | 建構函式                                                                                  |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@go-like/otel`       | `packages/otel/README.md`       | `newOtelTracerProvider`、`newOtelMeterProvider`、`newOtelLogHandler`、`newOtelPropagator` |
| `@go-like/pino`       | `packages/pino/README.md`       | `@go-like/pino/log` 嘅 `newPinoHandler`                                                   |
| `@go-like/winston`    | `packages/winston/README.md`    | `@go-like/winston/log` 嘅 `newWinstonHandler`                                             |
| `@go-like/prometheus` | `packages/prometheus/README.md` | `@go-like/prometheus/metric` 嘅 `newPrometheusMeterProvider`、`createPrometheusHandler`   |

用 `telemetry(tel)` 安裝 bundle。指南係[健康檢查與可觀測性](/zh-Hant-HK/guide/health-observability)。Winston 要喺 `format.json()` 之前有一個識 `Error` 嘅 format。

## 註冊中心、設定同儲存

| 插頭                  | README                          | 入口                                     |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `@go-like/consul`     | `packages/consul/README.md`     | `.`、`./registry`、`./config`、`./store` |
| `@go-like/etcd`       | `packages/etcd/README.md`       | `.`、`./registry`、`./config`、`./store` |
| `@go-like/vault`      | `packages/vault/README.md`      | `.`、`./config`、`./store`               |
| `@go-like/kubernetes` | `packages/kubernetes/README.md` | `.`、`./registry`、`./config`            |
| `@go-like/zookeeper`  | `packages/zookeeper/README.md`  | `./registry`、`./registry/node`          |
| `@go-like/mdns`       | `packages/mdns/README.md`       | `./registry`、`./registry/node`          |
| `@go-like/yaml`       | `packages/yaml/README.md`       | `./config`（`decodeYaml`）               |
| `@go-like/file`       | `packages/file/README.md`       | `./store`、`./store/node`                |

共用 HTTP、transport 同協議錯誤由套件根匯出。只屬於儲存嘅結果留喺儲存入口。見[錯誤處理](/reference/errors)。

## Broker、快取同作業

| 插頭                | README                        | 入口                      |
| ------------------- | ----------------------------- | ------------------------- |
| `@go-like/nats`     | `packages/nats/README.md`     | `./broker`、`./jetstream` |
| `@go-like/rabbitmq` | `packages/rabbitmq/README.md` | `./broker`                |
| `@go-like/redis`    | `packages/redis/README.md`    | `./cache`                 |
| `@go-like/bullmq`   | `packages/bullmq/README.md`   | `./job`                   |
| `@go-like/croner`   | `packages/croner/README.md`   | `./job`                   |

指南係[Broker、事件同作業](/zh-Hant-HK/guide/broker-events)。

## RPC

| 套件                       | README                               | 入口                                  |
| -------------------------- | ------------------------------------ | ------------------------------------- |
| `@go-like/connectrpc`      | `packages/connectrpc/README.md`      | `.` Fetch Handler，`./node` 標準 gRPC |
| `@go-like/protoc-gen-like` | `packages/protoc-gen-like/README.md` | 產生器二進位。冇 runtime 插座         |

指南係[串流](/zh-Hant-HK/guide/streaming)。

## Core

Memory transport、快取、儲存、broker 同 App 本身係 `@go-like/core` 入口，唔係插頭。套件 README 索引呢 41 個入口：`packages/core/README.md`。

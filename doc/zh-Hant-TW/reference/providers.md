# Provider

每個生態系插頭都有自己的 README，寫選項、原生擁有權與錯誤欄位。本頁是索引。概念入口在 `@go-like/core`，列在[套件參考](/zh-Hant-TW/reference/packages)。

應用程式建立原生用戶端再傳進來。共用同一套協定的插頭，共用一個根用戶端。每個插座是獨立的子路徑。下面的 README 路徑是這個 repository 裡的檔案。

## Telemetry

| 插頭                  | README                          | 建構函式                                                                                  |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@go-like/otel`       | `packages/otel/README.md`       | `newOtelTracerProvider`、`newOtelMeterProvider`、`newOtelLogHandler`、`newOtelPropagator` |
| `@go-like/pino`       | `packages/pino/README.md`       | `@go-like/pino/log` 的 `newPinoHandler`                                                   |
| `@go-like/winston`    | `packages/winston/README.md`    | `@go-like/winston/log` 的 `newWinstonHandler`                                             |
| `@go-like/prometheus` | `packages/prometheus/README.md` | `@go-like/prometheus/metric` 的 `newPrometheusMeterProvider`、`createPrometheusHandler`   |

用 `telemetry(tel)` 裝上這個套組。指南是[健康檢查與可觀測性](/zh-Hant-TW/guide/health-observability)。Winston 需要在 `format.json()` 之前放一個認得 Error 的 format。

## 服務註冊、設定與儲存

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

共用的 HTTP、傳輸與協定錯誤從套件根入口匯出。只屬於 Store 的結果留在 store 入口。見[錯誤處理](/reference/errors)。

## 訊息代理、快取與工作

| 插頭                | README                        | 入口                      |
| ------------------- | ----------------------------- | ------------------------- |
| `@go-like/nats`     | `packages/nats/README.md`     | `./broker`、`./jetstream` |
| `@go-like/rabbitmq` | `packages/rabbitmq/README.md` | `./broker`                |
| `@go-like/redis`    | `packages/redis/README.md`    | `./cache`                 |
| `@go-like/bullmq`   | `packages/bullmq/README.md`   | `./job`                   |
| `@go-like/croner`   | `packages/croner/README.md`   | `./job`                   |

指南是[訊息代理、事件與工作](/zh-Hant-TW/guide/broker-events)。

## RPC

| 套件                       | README                               | 入口                                  |
| -------------------------- | ------------------------------------ | ------------------------------------- |
| `@go-like/connectrpc`      | `packages/connectrpc/README.md`      | `.` Fetch handler，`./node` 標準 gRPC |
| `@go-like/protoc-gen-like` | `packages/protoc-gen-like/README.md` | 產生器執行檔。沒有 runtime 插座       |

指南是[串流處理](/zh-Hant-TW/guide/streaming)。

## Core

Memory transport、快取、儲存、訊息代理，以及 App 本身，都是 `@go-like/core` 的入口，不是插頭。套件 README 索引那 41 個入口：`packages/core/README.md`。

# 套件

Workspace 有 **20** 個公開 `@go-like/*` 套件，呢個 checkout 每個都係版本 `0.0.1`。根 workspace 係私人嘅。版本唔能夠證明 npm 可用。44 個 `examples/*` 目錄係私人應用。

公開入口有 **75** 個：41 個喺 `@go-like/core`，34 個喺插頭同產生器。產生出嚟嘅 `dist/package.json` `./package.json` export 係 metadata，唔係另一個入口。

`@go-like/core` 冇第三方 runtime 依賴。除 `@go-like/protoc-gen-like` 之外，其他每個套件都 peer 依賴同一個 core 版本。產生器唔依賴 core。插頭行為同限制喺每隻插頭 README。呢頁係清單。

## 20 個套件

| 套件                       | 入口                                     | 填咩                                           |
| -------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `@go-like/core`            | 41                                       | 插座、機制、記憶體參考實作同 runtime 綁定      |
| `@go-like/otel`            | `.`                                      | Tracer、meter、log handler、propagator         |
| `@go-like/pino`            | `./log`                                  | `LogHandler`                                   |
| `@go-like/winston`         | `./log`                                  | `LogHandler`                                   |
| `@go-like/prometheus`      | `./metric`                               | `MeterProvider` 同 scrape `Handler`            |
| `@go-like/consul`          | `.`、`./registry`、`./config`、`./store` | 共用 client、註冊中心、設定、儲存              |
| `@go-like/etcd`            | `.`、`./registry`、`./config`、`./store` | 共用 client、註冊中心、設定、儲存              |
| `@go-like/vault`           | `.`、`./config`、`./store`               | 共用 client、設定、儲存                        |
| `@go-like/kubernetes`      | `.`、`./registry`、`./config`            | 共用 client、註冊中心、設定                    |
| `@go-like/zookeeper`       | `./registry`、`./registry/node`          | 喺 client factory 之上嘅註冊中心；Node factory |
| `@go-like/mdns`            | `./registry`、`./registry/node`          | 喺 `MDNSHost` 之上嘅註冊中心；Node host        |
| `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                                |
| `@go-like/nats`            | `./broker`、`./jetstream`                | Core 同 JetStream broker                       |
| `@go-like/rabbitmq`        | `./broker`                               | Broker                                         |
| `@go-like/redis`           | `./cache`                                | 快取同資源層 `Server`                          |
| `@go-like/bullmq`          | `./job`                                  | `JobQueue` 同資源層 `Server`                   |
| `@go-like/croner`          | `./job`                                  | `Schedule`                                     |
| `@go-like/file`            | `./store`、`./store/node`                | 儲存同資源層 `Server`；Node host               |
| `@go-like/connectrpc`      | `.`、`./node`                            | Fetch Handler；Node gRPC server 同 client      |
| `@go-like/protoc-gen-like` | `.`                                      | Buf plugin 同 `bin`。冇插座                    |

計數：41 + 4 + 8 + 6 + 10 + 6 = 75。插頭同產生器入口係 core 41 個之後嘅 34 個。

## Core 入口

| 入口                                | 角色      | 首批匯出                                                                              |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `@go-like/core`                     | App       | `newApp`、`telemetry`、`resources`、`server`、`registrar`、`readyProbe`、hook、時限   |
| `@go-like/core/node`                | Node 綁定 | `signal`                                                                              |
| `@go-like/core/lifecycle`           | 插座      | `Server`、`Endpointer`、`newResourceServer`                                           |
| `@go-like/core/context`             | 插座      | `background`、`withCancel`、`withTimeout`、`waitForContext`                           |
| `@go-like/core/metadata`            | 機制      | `newMetadata`、client 同 server Context helper                                        |
| `@go-like/core/struct`              | 機制      | `struct`、`StructError`、`encodeJson`、`decodeJson`、`jsonCodec`                      |
| `@go-like/core/health`              | 插座      | `newProbeRegistry`                                                                    |
| `@go-like/core/resilience`          | 插座      | `retry`、`newCircuitBreaker`、`newTokenBucketLimiter`                                 |
| `@go-like/core/telemetry`           | 插座      | `newTelemetry`、`withTelemetry`、語意慣例常數                                         |
| `@go-like/core/telemetry/provider`  | 插頭 SDK  | `beginUnit`、`logCorrelation`、`resourceFromContext`                                  |
| `@go-like/core/log`                 | 插座      | `log`、`info`、`error`、`LogHandler`                                                  |
| `@go-like/core/trace`               | 插座      | `inSpan`、`newTraceContextPropagator`                                                 |
| `@go-like/core/metric`              | 插座      | `newCounter`、`newHistogram`、`newGauge`、`newUpDownCounter`                          |
| `@go-like/core/testing`             | 測試      | `newTelemetryRecorder`、`<concept>Conformance`                                        |
| `@go-like/core/transport`           | 插座      | `defineService`、`serviceError`、`isServiceError`、`ServerStream`                     |
| `@go-like/core/transport/provider`  | 插頭 SDK  | Transport 錯誤 factory、`newServerContext`                                            |
| `@go-like/core/transport/memory`    | 參考實作  | `newMemoryTransport`                                                                  |
| `@go-like/core/transport/http`      | 參考實作  | `newHTTPTransport`                                                                    |
| `@go-like/core/transport/http/node` | Node 綁定 | `newNodeHTTPTransport`                                                                |
| `@go-like/core/server`              | 機制      | `newServer`、`address`、`advertise`、`rateLimitMiddleware`                            |
| `@go-like/core/client`              | 機制      | `newClient`、`withEndpoint`、`withDiscovery`、`withRetry`、`circuitBreakerMiddleware` |
| `@go-like/core/web`                 | 插座      | `Handler`、`contextHandler`、`requestContext`、`createHealthHandler`                  |
| `@go-like/core/web/node`            | Node 綁定 | `newNodeServer`、`hostname`、`port`、`nodeShutdownTimeout`                            |
| `@go-like/core/web/bun`             | Bun 綁定  | `newBunServer`、`hostname`、`port`、`bunShutdownTimeout`                              |
| `@go-like/core/registry`            | 插座      | selector、filter、`newDiscoveryResolver`、`selectEndpoint`                            |
| `@go-like/core/registry/provider`   | 插頭 SDK  | `newSnapshotWatcher`、`startHeartbeat`                                                |
| `@go-like/core/registry/memory`     | 參考實作  | `newMemoryRegistry`                                                                   |
| `@go-like/core/config`              | 插座      | `newConfig`、`objectSource`、`envSource`、`fileSource`、`jsonDecoder`                 |
| `@go-like/core/config/provider`     | 插頭 SDK  | `newSourceWatcher`、`admitConfigObject`                                               |
| `@go-like/core/config/node`         | Node 綁定 | `newNodeFileCapability`                                                               |
| `@go-like/core/fetch`               | 插座      | `Fetch`、`newFetchClient`                                                             |
| `@go-like/core/cache`               | 插座      | `Cache`、`expiresIn`                                                                  |
| `@go-like/core/cache/memory`        | 參考實作  | `newMemoryCache`                                                                      |
| `@go-like/core/store`               | 插座      | `Store`、`ifAbsent`、`ifRevision`、`StoreConflictError`                               |
| `@go-like/core/store/provider`      | 插頭 SDK  | Option parser、conflict factory                                                       |
| `@go-like/core/store/memory`        | 參考實作  | `newMemoryStore`                                                                      |
| `@go-like/core/broker`              | 插座      | `Broker`、`newBrokerServer`、`eventBroker`                                            |
| `@go-like/core/broker/provider`     | 插頭 SDK  | `deliver`、`publish`                                                                  |
| `@go-like/core/broker/memory`       | 參考實作  | `newMemoryBroker`                                                                     |
| `@go-like/core/job`                 | 插座      | `newScheduleServer`、`newIntervalSchedule`、`JobQueue`                                |
| `@go-like/core/job/provider`        | 插頭 SDK  | `runJob`、`enqueue`、`dispatchJob`                                                    |

`@go-like/core/server` 同 `@go-like/core/client` 都匯出 `middleware` 同 `use`。一個檔案兩邊都要時，將其中一個當 namespace import。根入口嘅 `context`、`endpoint`、`server` 同 `metadata` option 係 App option。呢啲名稱同 OpenTelemetry 或 `defineService` 相撞時，將根入口當 namespace import。

應用程式碼唔 import `/provider` 或 `/testing`，測試同插頭實作除外。

## Runtime subpath

Import 你想要嘅 subpath。Export 唔以 `bun` 或 `node` 做條件。

- Node：`@go-like/core/node`、`@go-like/core/transport/http/node`、`@go-like/core/web/node`、`@go-like/core/config/node`、`@go-like/mdns/registry/node`、`@go-like/zookeeper/registry/node`、`@go-like/file/store/node`、`@go-like/connectrpc/node`。
- Bun host：`@go-like/core/web/bun`。
- NATS、RabbitMQ、Redis 同 BullMQ 喺 Node 同 Bun 上跟佢哋嘅原生 client。

## 呢份目錄留低嘅

記憶體參考實作係程序內嘅。Lease、acknowledgement、TTL 同交易嘅限制喺插頭 README。[Provider](/zh-Hant-HK/reference/providers)連去呢啲 README。[錯誤處理](/reference/errors)列出公開代碼。[遷移](/zh-Hant-HK/guide/migration)將歷史 specifier 對應到呢張表。

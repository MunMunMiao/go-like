# 套件

這個工作區有 **20** 個公開的 `@go-like/*` 套件，在這個 checkout 每個都是版本 `0.0.1`。根工作區是私人的。這個版本不能證明 npm 上已可安裝。44 個 `examples/*` 目錄是私人應用程式。

公開入口有 **75** 個：41 個在 `@go-like/core`，34 個在插頭與產生器。產生出來的 `dist/package.json` 的 `./package.json` export 是 metadata，不是另一個入口。

`@go-like/core` 沒有第三方 runtime 依賴。除了 `@go-like/protoc-gen-like` 以外，其他每個套件都以同儕依賴指向同一個 core 版本。產生器不依賴 core。插頭的行為與限制寫在各自的 README。本頁是清單。

## 這 20 個套件

| 套件                       | 入口                                     | 填入的位置                                         |
| -------------------------- | ---------------------------------------- | -------------------------------------------------- |
| `@go-like/core`            | 41                                       | 插座、機制、記憶體參考實作，以及 runtime 綁定      |
| `@go-like/otel`            | `.`                                      | Tracer、meter、log handler、propagator             |
| `@go-like/pino`            | `./log`                                  | `LogHandler`                                       |
| `@go-like/winston`         | `./log`                                  | `LogHandler`                                       |
| `@go-like/prometheus`      | `./metric`                               | `MeterProvider` 與一個 scrape `Handler`            |
| `@go-like/consul`          | `.`、`./registry`、`./config`、`./store` | 共用用戶端、registry、config、store                |
| `@go-like/etcd`            | `.`、`./registry`、`./config`、`./store` | 共用用戶端、registry、config、store                |
| `@go-like/vault`           | `.`、`./config`、`./store`               | 共用用戶端、config、store                          |
| `@go-like/kubernetes`      | `.`、`./registry`、`./config`            | 共用用戶端、registry、config                       |
| `@go-like/zookeeper`       | `./registry`、`./registry/node`          | 建在用戶端 factory 上的 registry；Node factory     |
| `@go-like/mdns`            | `./registry`、`./registry/node`          | 建在 `MDNSHost` 上的 registry；Node host           |
| `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                                    |
| `@go-like/nats`            | `./broker`、`./jetstream`                | Core 與 JetStream 訊息代理                         |
| `@go-like/rabbitmq`        | `./broker`                               | 訊息代理                                           |
| `@go-like/redis`           | `./cache`                                | 快取，以及一個 resource 層級的 `Server`            |
| `@go-like/bullmq`          | `./job`                                  | `JobQueue`，以及一個 resource 層級的 `Server`      |
| `@go-like/croner`          | `./job`                                  | `Schedule`                                         |
| `@go-like/file`            | `./store`、`./store/node`                | 儲存，以及一個 resource 層級的 `Server`；Node host |
| `@go-like/connectrpc`      | `.`、`./node`                            | Fetch handler；Node gRPC server 與用戶端           |
| `@go-like/protoc-gen-like` | `.`                                      | Buf 外掛與 `bin`。沒有插座                         |

計數：41 + 4 + 8 + 6 + 10 + 6 = 75。插頭與產生器的入口，是 core 那 41 個之後的 34 個。

## Core 入口

| 入口                                | 角色      | 首先會看到的匯出                                                                        |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `@go-like/core`                     | App       | `newApp`、`telemetry`、`resources`、`server`、`registrar`、`readyProbe`、hook、時間預算 |
| `@go-like/core/node`                | Node 綁定 | `signal`                                                                                |
| `@go-like/core/lifecycle`           | 插座      | `Server`、`Endpointer`、`newResourceServer`                                             |
| `@go-like/core/context`             | 插座      | `background`、`withCancel`、`withTimeout`、`waitForContext`                             |
| `@go-like/core/metadata`            | 機制      | `newMetadata`，以及用戶端與 server 的 Context 輔助函式                                  |
| `@go-like/core/struct`              | 機制      | `struct`、`StructError`、`encodeJson`、`decodeJson`、`jsonCodec`                        |
| `@go-like/core/health`              | 插座      | `newProbeRegistry`                                                                      |
| `@go-like/core/resilience`          | 插座      | `retry`、`newCircuitBreaker`、`newTokenBucketLimiter`                                   |
| `@go-like/core/telemetry`           | 插座      | `newTelemetry`、`withTelemetry`、語意慣例常數                                           |
| `@go-like/core/telemetry/provider`  | 插頭 SDK  | `beginUnit`、`logCorrelation`、`resourceFromContext`                                    |
| `@go-like/core/log`                 | 插座      | `log`、`info`、`error`、`LogHandler`                                                    |
| `@go-like/core/trace`               | 插座      | `inSpan`、`newTraceContextPropagator`                                                   |
| `@go-like/core/metric`              | 插座      | `newCounter`、`newHistogram`、`newGauge`、`newUpDownCounter`                            |
| `@go-like/core/testing`             | 測試      | `newTelemetryRecorder`、`<concept>Conformance`                                          |
| `@go-like/core/transport`           | 插座      | `defineService`、`serviceError`、`isServiceError`、`ServerStream`                       |
| `@go-like/core/transport/provider`  | 插頭 SDK  | Transport 錯誤工廠、`newServerContext`                                                  |
| `@go-like/core/transport/memory`    | 參考實作  | `newMemoryTransport`                                                                    |
| `@go-like/core/transport/http`      | 參考實作  | `newHTTPTransport`                                                                      |
| `@go-like/core/transport/http/node` | Node 綁定 | `newNodeHTTPTransport`                                                                  |
| `@go-like/core/server`              | 機制      | `newServer`、`address`、`advertise`、`rateLimitMiddleware`                              |
| `@go-like/core/client`              | 機制      | `newClient`、`withEndpoint`、`withDiscovery`、`withRetry`、`circuitBreakerMiddleware`   |
| `@go-like/core/web`                 | 插座      | `Handler`、`contextHandler`、`requestContext`、`createHealthHandler`                    |
| `@go-like/core/web/node`            | Node 綁定 | `newNodeServer`、`hostname`、`port`、`nodeShutdownTimeout`                              |
| `@go-like/core/web/bun`             | Bun 綁定  | `newBunServer`、`hostname`、`port`、`bunShutdownTimeout`                                |
| `@go-like/core/registry`            | 插座      | selector、篩選、`newDiscoveryResolver`、`selectEndpoint`                                |
| `@go-like/core/registry/provider`   | 插頭 SDK  | `newSnapshotWatcher`、`startHeartbeat`                                                  |
| `@go-like/core/registry/memory`     | 參考實作  | `newMemoryRegistry`                                                                     |
| `@go-like/core/config`              | 插座      | `newConfig`、`objectSource`、`envSource`、`fileSource`、`jsonDecoder`                   |
| `@go-like/core/config/provider`     | 插頭 SDK  | `newSourceWatcher`、`admitConfigObject`                                                 |
| `@go-like/core/config/node`         | Node 綁定 | `newNodeFileCapability`                                                                 |
| `@go-like/core/fetch`               | 插座      | `Fetch`、`newFetchClient`                                                               |
| `@go-like/core/cache`               | 插座      | `Cache`、`expiresIn`                                                                    |
| `@go-like/core/cache/memory`        | 參考實作  | `newMemoryCache`                                                                        |
| `@go-like/core/store`               | 插座      | `Store`、`ifAbsent`、`ifRevision`、`StoreConflictError`                                 |
| `@go-like/core/store/provider`      | 插頭 SDK  | 選項解析器、衝突工廠                                                                    |
| `@go-like/core/store/memory`        | 參考實作  | `newMemoryStore`                                                                        |
| `@go-like/core/broker`              | 插座      | `Broker`、`newBrokerServer`、`eventBroker`                                              |
| `@go-like/core/broker/provider`     | 插頭 SDK  | `deliver`、`publish`                                                                    |
| `@go-like/core/broker/memory`       | 參考實作  | `newMemoryBroker`                                                                       |
| `@go-like/core/job`                 | 插座      | `newScheduleServer`、`newIntervalSchedule`、`JobQueue`                                  |
| `@go-like/core/job/provider`        | 插頭 SDK  | `runJob`、`enqueue`、`dispatchJob`                                                      |

`@go-like/core/server` 與 `@go-like/core/client` 都匯出 `middleware` 與 `use`。同一個檔案兩邊都需要時，把其中一個當成 namespace import。根入口的 `context`、`endpoint`、`server` 與 `metadata` 選項是 App 選項。這些名稱與 OpenTelemetry 或 `defineService` 衝突時，把根入口當成 namespace import。

應用程式的程式碼不 import `/provider` 或 `/testing`，測試與插頭實作除外。

## Runtime 子路徑

Import 你要的那個子路徑。Export 不會依 `bun` 或 `node` 條件切換。

- Node：`@go-like/core/node`、`@go-like/core/transport/http/node`、`@go-like/core/web/node`、`@go-like/core/config/node`、`@go-like/mdns/registry/node`、`@go-like/zookeeper/registry/node`、`@go-like/file/store/node`、`@go-like/connectrpc/node`。
- Bun host：`@go-like/core/web/bun`。
- NATS、RabbitMQ、Redis 與 BullMQ 跟隨它們在 Node 與 Bun 上的原生用戶端。

## 這份清單沒有涵蓋的部分

記憶體參考實作只活在這個程序裡。Lease、acknowledgement、TTL 與交易的限制，以插頭 README 為準。[Provider](/zh-Hant-TW/reference/providers)連結那些 README。[錯誤處理](/reference/errors)列出公開的 code。[遷移與導入](/zh-Hant-TW/guide/migration)把歷史 specifier 對到這張表。

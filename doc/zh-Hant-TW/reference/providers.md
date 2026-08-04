# 套件與 provider 參考

本頁是依照應用程式想回答的問題來組織，而不是依照 `packages/` 目錄布局。請從擁有該契約的最小 public package 匯入；runtime-specific 行為會透過明確的 subpath 暴露。Provider（具體實作方）套件也不是帶著單一通用保證、可以彼此任意替換的實作。

## 如何閱讀本頁

- **Contract**：可攜式或與 provider 無關的介面。
- **Provider**：由記憶體、檔案、網路服務或原生函式庫支援的實作。
- **Lifecycle adapter**：圍繞應用程式建立的原生資源包上一層 Server wrapper。
- **Evidence**：指出 repository 支援的證據類型：source/export、宣告過的測試，或回報過的本機指令結果。它不會把 package version 變成 npm 發布或正式環境可用性的聲明。

目前 source inventory 有 43 個非 private 的 `@go-like/*` package manifest 與 23 個 public source subpath；在這個 checkout 中，它們的版本都是 `0.0.1`。`examples/*` 下的 44 個 workspace 是 private applications，不是 public packages。

## 依工作選擇

| 工作                         | 從這裡開始                               | 需要時再加上                                                              | go-like 不擁有                                               |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 暴露 Web API                 | `@go-like/web`、`@go-like/core`          | `@go-like/web/node` 或框架的原生 Fetch handler                            | Router、framework middleware、auth、response policy          |
| 呼叫內部服務                 | `@go-like/client`、`@go-like/transport`  | `@go-like/transport-memory`、`@go-like/transport-http`、`@go-like/struct` | Business idempotency、generated IDL、全雙工 RPC              |
| 探索服務實例                 | `@go-like/registry`                      | 一個 Registry provider、filters、一個 Selector                            | Backend lease/revision consistency 或 global service locator |
| 載入設定                     | `@go-like/config`                        | env/file/YAML 或一個外部 Config provider                                  | Ambient global configuration 與跨資源交易                    |
| 儲存權威位元組資料           | `@go-like/store`                         | Memory、File、Consul、etcd 或 Vault provider                              | 通用 database/ORM 或統一的 provider 保證                     |
| 快取可丟棄的值               | `@go-like/cache`                         | Memory 或 Redis provider                                                  | Authority、persistence、CAS、持久化業務狀態                  |
| 發布或消費位元組資料         | `@go-like/broker`                        | Memory、RabbitMQ 或 NATS                                                  | 通用 ack/nack/term、DLQ、持久 offset、exactly-once           |
| 增加 typed event payload     | `@go-like/event`                         | 一個應用程式自己的 Codec                                                  | Schema registry、replay、settlement policy                   |
| 執行既有 scheduler 或 worker | `@go-like/core`                          | `@go-like/croner`、`@go-like/bullmq`、`@go-like/nats`                     | 原生 queue、processor、job policy 或 broker connection       |
| 增加維運能力                 | `@go-like/health`、`@go-like/resilience` | Pino、Winston、OTel、Prometheus                                           | Global instrumentation、auth、deployment policy              |

## 基礎套件

| Package               | 用途                                                        | 主要 public API                                                                                                                                                                                                   | Runtime 與所有權說明                                                                     |
| --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@go-like/context`    | 明確的取消、deadline、cause 與 value                        | `background`、`todo`、`withCancel`、`withCancelCause`、`withDeadline`、`withDeadlineCause`、`withTimeout`、`withTimeoutCause`、`cause`、`withoutCancel`、`withValue`、`afterFunc`、`canceled`、`deadlineExceeded` | Portable source contract。`Context` 內部使用 `AbortSignal`；它不是 Go ABI，也不是 DI bag |
| `@go-like/core`       | 組合 application 與 resource lifecycle                      | `newApp`、`server`、`registrar`、`beforeStart`、`afterStart`、`beforeStop`、`afterStop`、`startTimeout`、`stopTimeout`、`context`、`id`、`name`、`version`、`metadata`、`endpoint`、`newContext`、`fromContext`   | Portable structural `Server` 與 `App`。Siblings 的 stop calls 是並行的                   |
| `@go-like/metadata`   | 不可變的多值 metadata 與明確傳遞                            | metadata types 與 propagation functions                                                                                                                                                                           | Client 與 server metadata domains 分開；metadata 不是可信任的 identity                   |
| `@go-like/struct`     | typed endpoints 與 JSON 的 runtime Struct validation        | `struct`、`Infer`、`Struct`、`StructError`、`setErrorMap`                                                                                                                                                         | 目前的 public package。它是 runtime validation，不是 Protobuf、IDL 或 generated code     |
| `@go-like/health`     | Liveness 與 readiness probe registry                        | `newProbeRegistry`、`ProbeRegistry`、`Probe`、`ProbeReport`                                                                                                                                                       | 空 liveness 會通過；空 readiness fail closed；預設 probe timeout 是 1,000 ms             |
| `@go-like/resilience` | 明確的 retry、circuit breaker 與 non-blocking rate limiting | `retry`、`exponentialBackoff`、`newCircuitBreaker`、`newTokenBucketLimiter`、`circuitOpen`                                                                                                                        | Retry authorization 由呼叫方宣告；沒有自動冪等判斷，也沒有背景 limiter task              |

## Web 與內部呼叫套件

| Package                        | 用途                                                                 | 主要 public API                                                                                                                                                                                              | 不負責                                                                               |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `@go-like/web`                 | 標準 Web Handler 與 request Context bridge                           | `Handler`、`ContextHandler`、`contextHandler`                                                                                                                                                                | Routes、WebSockets、SSE policy、listener、authentication                             |
| `@go-like/web/health`          | Health Handler routes                                                | `createHealthHandler`                                                                                                                                                                                        | Probe registration 或 framework route mounting                                       |
| `@go-like/web/node`            | 圍繞 Fetch Handler 的 Node listener                                  | `newNodeServer`、`hostname`、`port`、`nodeShutdownTimeout`                                                                                                                                                   | Internal HTTP Transport TLS/HTTP2；這些請使用 `@go-like/transport-http/node`         |
| `@go-like/client`              | 內部 unary calls、discovery、selection、middleware、retries、pooling | `newClient`、`withTransport`、`withAddress`、`withDiscovery`、`withSelector`、`withFilter`、`withBlock`、`withRetry`、`middleware`、`use`、`circuitBreakerMiddleware`、`closeTimeout`、`poolSize`、`poolTtl` | Framework routes、business replay safety、physical socket limits                     |
| `@go-like/server`              | 內部 unary Message server 與 route dispatch                          | `newServer`、`transport`、`address`、`advertise`、`handler`、`middleware`、`use`、`listenOption`、`rateLimitMiddleware`                                                                                      | 外部 Fetch routes 與 protocol-specific business authorization                        |
| `@go-like/transport`           | Transport SPI 與 Message boundary                                    | `Transport`、`Client`、`Listener`、`Socket`、`Message`、`TransportInfo`、`Endpoint`、`endpoint`、`chain`、`serviceError`                                                                                     | 除非選擇 provider，否則不提供具體 wire；沒有 internal full-duplex promise            |
| `@go-like/transport-memory`    | 程序內 unary Transport                                               | `newMemoryTransport`                                                                                                                                                                                         | 跨程序行為、持久化、網路 fallback、TLS                                               |
| `@go-like/transport-http`      | 以 Fetch 為基礎的內部 HTTP Transport                                 | `newHTTPTransport`、`executor`、`maxMessageBytes`                                                                                                                                                            | 沒有注入 `HTTPHost` 時，不是完整的 portable listener；也不提供原生 Node TLS controls |
| `@go-like/transport-http/node` | 原生 Node internal HTTP Transport                                    | `newNodeHTTPTransport`、`allowHTTP1`、`clientAuth`                                                                                                                                                           | Deno listener 或自動安全策略                                                         |

## Config 套件

| Package 或 subpath           | 用途                                    | 主要 function                                                                                                          | 邊界                                                                   |
| ---------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `@go-like/config`            | Config manager 與 object sources        | `newConfig`、`source`、`objectSource`、`schema`、`resolver`、`placeholderResolver`、`onReloadError`、`onTerminalError` | Immutable snapshots 與已接納的 watcher lifecycle；本身不是 Core Server |
| `@go-like/config/env`        | 明確的 environment record source        | `envSource`                                                                                                            | 接收注入的 record；不讀取 ambient runtime globals                      |
| `@go-like/config/file`       | File source 與 JSON decoder contract    | `fileSource`、`jsonFileDecoder`                                                                                        | 需要明確的 file capability                                             |
| `@go-like/config/node`       | Node file capability                    | `newNodeFileCapability`                                                                                                | Runtime-specific Node subpath                                          |
| `@go-like/config/yaml`       | 把 YAML 解碼成 ConfigObject             | `decodeYaml`                                                                                                           | Decoding 不是 source watching 或 schema publication                    |
| `@go-like/config-consul`     | Consul HTTP configuration source        | `consulSource`、`jsonConsulDecoder`                                                                                    | Consul blocking-query 與 consistency behavior                          |
| `@go-like/config-etcd`       | etcd gateway configuration source       | `etcdSource`、`jsonEtcdDecoder`                                                                                        | Revision、compaction 與 gateway protocol behavior                      |
| `@go-like/config-kubernetes` | 一個 Kubernetes ConfigMap 或 Secret key | `kubernetesSource`、`jsonKubernetesDecoder`                                                                            | Resource-version/relist semantics；沒有跨資源交易                      |
| `@go-like/config-vault`      | Vault KV v2 source                      | `vaultSource`                                                                                                          | Vault authentication、TLS、token policy 與 KV semantics                |

Config external providers 使用注入的標準 Fetch。憑證與 redirects 的安全行為取決於 provider；使用 `http` 還是 `https` 由應用程式或部署決定，除非 provider 主動拒絕。

## Registry 套件

| Package                        | 用途                                                | 主要 function                                                                                                                                      | Runtime/backend 說明                                                 |
| ------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `@go-like/registry`            | Contract、snapshot、filters、selectors              | `filterVersion`、`filterLabel`、`newRandomSelector`、`newRoundRobinSelector`、`newWeightedRoundRobinSelector`、`newP2CSelector`、`newEWMASelector` | Complete replacement snapshots；selection feedback 是明確的          |
| `@go-like/registry/provider`   | Provider author helpers 與 registration diagnostics | `providerOptions`、`notifyRegistrationError`、snapshot/provider helpers                                                                            | 面向 provider 的 subpath，不是一般應用程式入口                       |
| `@go-like/registry-consul`     | Consul registration 與 discovery                    | `newConsulRegistry`                                                                                                                                | Health-filtered、blocking-query、TTL/critical 行為由 Consul 原生決定 |
| `@go-like/registry-etcd`       | etcd registration 與 discovery                      | `newEtcdRegistry`                                                                                                                                  | Leases、revisions、watch/relist、compaction 行為                     |
| `@go-like/registry-kubernetes` | EndpointSlice discovery 與可選的 registration       | `newKubernetesRegistry`                                                                                                                            | Kubernetes EndpointSlice、owner references；不虛構 TTL               |
| `@go-like/registry-mdns`       | 本地 multicast discovery                            | `newMDNSRegistry`                                                                                                                                  | Root provider 按設計可攜；UDP host 在 `/node`                        |
| `@go-like/registry-mdns/node`  | Node UDP multicast capability                       | `newNodeMDNSHost`                                                                                                                                  | 明確的 Node runtime subpath                                          |
| `@go-like/registry-zookeeper`  | ZooKeeper ephemeral registration 與 discovery       | `newZookeeperRegistry`                                                                                                                             | 文件支援 Node.js 與 Bun；明確不支援 Deno                             |

Registry 保存的是可達性狀態，不是持久業務資料。Provider 在重建暫時性 watcher 時可以保留上一份 snapshot，但權威的空 snapshot 必須 fail closed。

## Store 與 Cache 套件

| Package                    | 用途                               | 主要 function                                                                                                      | 邊界                                                                            |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `@go-like/store`           | Record contract 與 options         | `expiresIn`、`ifAbsent`、`ifRevision`、`prefix`、`limit`、`cursor`、`writeOptions`、`deleteOptions`、`listOptions` | Revisions、CAS、TTL、pagination；各 provider 的能力不同                         |
| `@go-like/store/provider`  | Provider write/delete/list helpers | `writeOptions`、`deleteOptions`、`listOptions`、snapshot 與 conflict helpers                                       | 面向 provider；本身不是 durable backend                                         |
| `@go-like/store-memory`    | 程序內 Store tests                 | `newMemoryStore`、`clock`                                                                                          | 沒有重啟持久化或跨程序狀態                                                      |
| `@go-like/store-file`      | 本地 file Store                    | `newFileStore`                                                                                                     | 單一擁有者的本地狀態；Node host 使用 `/node`                                    |
| `@go-like/store-file/node` | Node file capability               | `newNodeFileStoreHost`                                                                                             | 明確的 Node subpath                                                             |
| `@go-like/store-consul`    | Consul KV Store                    | `newConsulStore`                                                                                                   | Consul sessions、TTL/CAS combinations，以及不確定的 mutation behavior           |
| `@go-like/store-etcd`      | etcd KV Store                      | `newEtcdStore`                                                                                                     | Gateway、lease、revision、compaction 與不確定的 mutation behavior               |
| `@go-like/store-vault`     | Vault KV v2 Store                  | `newVaultStore`                                                                                                    | 不承諾統一的 Store TTL/CAS semantics                                            |
| `@go-like/cache`           | Disposable value/TTL contract      | `expiresIn`、`putOptions`                                                                                          | 沒有 CAS、revision、durability 或 authority                                     |
| `@go-like/cache-memory`    | 程序內 cache                       | `newMemoryCache`、`clock`                                                                                          | 沒有持久化；lazy expiry；適合測試與本地加速                                     |
| `@go-like/cache-redis`     | Redis-backed cache                 | `newRedisCache`                                                                                                    | 原生 Redis connection、URL credential handling 與 runtime requirements 仍然可見 |

## Broker、event 與工作套件

| Package 或 subpath               | 用途                                            | 主要 function                                                                  | 邊界                                                                 |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `@go-like/broker`                | Byte/topic Broker contract                      | `newBrokerServer`                                                              | 沒有 portable ack/nack/term、DLQ、retry 或 durable offset            |
| `@go-like/broker/provider`       | Provider terminal registration                  | `registerSubscriberTerminal`、`subscriberTerminal`                             | 面向 provider 的生命週期 bookkeeping                                 |
| `@go-like/broker-memory`         | Exact-topic 程序內 broker                       | `newMemoryBroker`                                                              | 實例私有、broadcast，沒有 durable settlement                         |
| `@go-like/broker-rabbitmq`       | RabbitMQ borrowed、confirm 或 recovering broker | `newRabbitMqBroker`、`newConfirmRabbitMqBroker`、`newRecoveringRabbitMqBroker` | `amqplib` channel/connection 與原生 settlement semantics             |
| `@go-like/event`                 | Broker 之上的 typed codec                       | `eventBroker`                                                                  | 原生 delivery 仍然可見；沒有 replay 或 schema registry               |
| `@go-like/nats`                  | NATS lifecycle 與原生 broker entrypoints        | `newNatsCoreServer`、`natsCoreDrainTimeout`                                    | Core connection 與 subscription semantics 仍是原生的                 |
| `@go-like/nats/broker`           | NATS Core Broker                                | `newNatsCoreBroker`                                                            | 原生 `Msg`、queue group、drain 與 at-most-once semantics             |
| `@go-like/nats/jetstream`        | JetStream ConsumerMessages lifecycle            | `newNatsJetStreamServer`、`natsJetStreamCloseTimeout`                          | 原生 ConsumerMessages close/stop/closed behavior                     |
| `@go-like/nats/jetstream/broker` | JetStream 上的 typed byte Broker                | `newNatsJetStreamBroker`                                                       | `JsMsg`、`PubAck`、ack/nak/term、redelivery 與 DLQ 仍是原生語意      |
| `@go-like/croner`                | 既有 Croner jobs 的 lifecycle                   | `newCronerServer`                                                              | Croner schedule、callback、overlap 與 passive terminal semantics     |
| `@go-like/bullmq`                | 既有 BullMQ Worker 的 lifecycle                 | `newBullMqWorkerServer`、`bullMqWorkerShutdownTimeout`                         | Queue、Redis、processor、retry/backoff、stalled jobs 與 job identity |

## Logging 與可觀測性套件

| Package               | 用途                                           | 主要 function                                                                                                                                                                       | 不負責                                                                  |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `@go-like/pino`       | Pino request/broker wrapper 與 drain lifecycle | `logClient`、`logUnaryMiddleware`、`logWebHandler`、`logBroker`、`newPinoServer`、`pinoDrainTimeout`                                                                                | Logger construction、destination policy、redaction、global setup        |
| `@go-like/winston`    | Winston wrapper 與 shutdown lifecycle          | logging wrappers、`newWinstonServer`                                                                                                                                                | Logger/transports 與它們原生的 finish/close semantics                   |
| `@go-like/otel`       | 明確的 OpenTelemetry trace/metric wrapper      | `newOtelServer`、`traceClient`、`traceUnaryMiddleware`、`traceWebHandler`、`traceBroker`、`measureClient`、`measureClientMiddleware`、`measureUnaryMiddleware`、`newRequestMetrics` | Global providers、exporters、context manager、automatic instrumentation |
| `@go-like/prometheus` | Prometheus request metrics 與 scrape Handler   | `newRequestMetrics`、`measureClient`、`measureUnaryMiddleware`、`measureWebHandler`、`measureBroker`、`createPrometheusHandler`                                                     | Global Registry、提供的 Registry 以外的 collectors、background tasks    |

## 完整的 public source subpath 清單

以下是目前 package manifests 宣告的 23 個明確 source subpath。產生的 packages 可能額外匯出 metadata-only 的 `./package.json`；那不是 source API。

|   # | Subpath                          | 主要 exports                                               | 面向對象                     |
| --: | -------------------------------- | ---------------------------------------------------------- | ---------------------------- |
|   1 | `@go-like/broker/provider`       | `registerSubscriberTerminal`、`subscriberTerminal`         | Provider authors             |
|   2 | `@go-like/cache/provider`        | `putOptions`                                               | Provider authors             |
|   3 | `@go-like/config/env`            | `envSource`                                                | Application authors          |
|   4 | `@go-like/config/file`           | `fileSource`、`jsonFileDecoder`                            | Application authors          |
|   5 | `@go-like/config/node`           | `newNodeFileCapability`                                    | Node runtime authors         |
|   6 | `@go-like/config/yaml`           | `decodeYaml`                                               | Application authors          |
|   7 | `@go-like/core/lifecycle`        | `waitForContext`                                           | Lifecycle/provider authors   |
|   8 | `@go-like/core/node`             | `signal`                                                   | Node/Bun process integration |
|   9 | `@go-like/nats/broker`           | `newNatsCoreBroker`                                        | NATS Core applications       |
|  10 | `@go-like/nats/jetstream`        | `newNatsJetStreamServer`、`natsJetStreamCloseTimeout`      | JetStream applications       |
|  11 | `@go-like/nats/jetstream/broker` | `newNatsJetStreamBroker`                                   | JetStream applications       |
|  12 | `@go-like/registry/provider`     | provider options 與 snapshot helpers                       | Provider authors             |
|  13 | `@go-like/registry-mdns/node`    | `newNodeMDNSHost`                                          | Node mDNS applications       |
|  14 | `@go-like/store/provider`        | write/delete/list options 與 snapshots                     | Provider authors             |
|  15 | `@go-like/store-file/node`       | `newNodeFileStoreHost`                                     | Node file applications       |
|  16 | `@go-like/struct/codec`          | `encodeJson`、`decodeJson`                                 | Typed contract authors       |
|  17 | `@go-like/struct/runtime`        | introspection 與 parsing helpers                           | Runtime/provider authors     |
|  18 | `@go-like/transport/headers`     | `Go-Like-*` header constants                               | Transport/provider authors   |
|  19 | `@go-like/transport/json`        | `encodeJsonBody`、`decodeJsonBody`、`jsonContentType`      | Typed/raw transport authors  |
|  20 | `@go-like/transport/provider`    | Message、metadata、ServiceError codecs 與 errors           | Provider authors             |
|  21 | `@go-like/transport-http/node`   | `newNodeHTTPTransport`、`allowHTTP1`、`clientAuth`         | Node HTTP applications       |
|  22 | `@go-like/web/health`            | `createHealthHandler`                                      | Web applications             |
|  23 | `@go-like/web/node`              | `newNodeServer`、`hostname`、`port`、`nodeShutdownTimeout` | Node Web host applications   |

目前 TypeScript configuration 含有過時的 `@go-like/otel/testing` 與 `@go-like/web/node/testing` path mappings，但它們不是目前 package manifest exports。在 repository 解決這個不一致前，不要把它們寫成 public entrypoints。

## Runtime 選擇矩陣

| Entry 或 provider family                                       | Portable source                    | Bun/Node native                                        | Deno claim                                | 證據措辭                                                                |
| -------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------- |
| Context、Core root、Health、Metadata、Resilience、Struct       | Yes                                | 不需要 native import                                   | 已宣告選定的 runtime lanes                | Source contract；發布措辭前檢查目前已執行的 matrix                      |
| Web root 與 Web health                                         | Yes                                | 需要另外的 host                                        | Standard Handler boundary                 | Handler 可攜；Handler 不是 listener                                     |
| Memory Transport、Memory Store、Memory Cache、Memory Broker    | Process-local source               | 不需要 external service                                | 相同的程序內意義                          | 不是 distributed、durable 或 cross-process                              |
| HTTP root 與 Fetch-backed Config/Registry/Store providers      | Injected Fetch                     | Runtime 選擇 Fetch                                     | 在有 package lane 時有 source-backed 證據 | 可以依 source 或已宣告的 runtime lane 說可攜，不要承諾 universal parity |
| `/node` subpaths                                               | No                                 | Node-specific，部分可在 Bun 執行                       | 沒有 Deno entrypoint                      | 明確的 import 會改變 runtime graph                                      |
| NATS、RabbitMQ、BullMQ、Redis、Pino、Winston、OTel native SDKs | Provider-dependent                 | Node/Bun fixtures 或 package-specific runtime evidence | 不要推斷支援 Deno                         | 閱讀 provider README 與 E2E scope                                       |
| ZooKeeper                                                      | No Deno support in provider README | Node/Bun                                               | Explicitly unsupported                    | 不要從 Registry root 推廣結論                                           |

## Function 選擇規則

- 需要 Context 時，在 Web edge 使用 `contextHandler`，不要自造 framework request bag。
- 一個程序擁有多個 admitted resource，或需要明確的 signal 與 shutdown ownership 時，使用 `newApp` 與 `server(...)`。
- 兩端都需要共用 runtime Struct validation 時，使用 typed `endpoint(...)` 與 `handler(contract, fn)`；如果應用程式擁有另一種位元組契約，則使用 raw `handler(service, endpoint, fn)`。
- 在 Discovery 之前使用 `withAddress(...)`。它更容易測試，也會讓目標 identity 清楚。
- 只有服務確實需要它們增加的 control-plane 行為時，才使用 `withDiscovery(...)`、`withSelector(...)`、`withFilter(...)` 與 `withBlock()`。
- 只有寫清楚 replay authorization、最大總嘗試次數、failure predicate 與 business idempotency 後，才使用 `withRetry(...)`。
- 使用 `newMemoryStore` 做可重現的測試，不要用它做 durability 聲明。
- 使用 `newMemoryCache` 做可丟棄的加速，不要把它當成 appointment 或 payment authority。
- 使用 `newBrokerServer` 把一個 subscription 接進 Core，不要因此得到通用的 queue worker 或 settlement API。
- 只有在 application 已建立 native provider 或 registry 後，才使用 `newOtelServer`、`newPinoServer`、`newWinstonServer` 或 Prometheus Handler。

## 明確排除項

目前 public inventory 中沒有任何套件應被描述為擁有 gRPC、Protobuf、IDL code generation、generated RPC clients、internal full-duplex streams、Event Store/history/replay、通用 authentication/authorization、ORM behavior、global service locator 或 cluster orchestration。Provider 或 application 可以用無關的函式庫處理其中某一項，但那不屬於 go-like 目前的契約。

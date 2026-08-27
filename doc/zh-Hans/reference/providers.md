# 包与 provider 参考

本页按应用要回答的问题组织，而不是按 `packages/` 目录布局组织。请从拥有该契约的最小 public package 导入；runtime-specific 行为通过明确的 subpath 暴露。Provider（具体实现方）package 也不是带着一个统一保证、可以彼此随意替换的实现。

## 怎么读这页

- **Contract**：可移植的或与 provider 无关的接口。
- **Provider**：由内存、文件、网络服务或原生库提供支持的实现。
- **Lifecycle adapter**：围绕应用创建的原生资源包一层 Server wrapper。
- **Evidence**：说明仓库支持的证据类型：source/export、声明过的测试，或报告过的本地命令结果。它不会把 package version 变成 npm 发布或生产可用性声明。

当前 source inventory 有 43 个非 private 的 `@go-like/*` package manifest 和 23 个 public source subpath；在这个 checkout 中它们的版本都是 `0.0.1`。`examples/*` 下的 44 个 workspace 是 private applications，不是 public packages。

## 按任务选择

| 任务                         | 从这里开始                               | 按需增加                                                                  | go-like 不拥有                                               |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 暴露 Web API                 | `@go-like/web`、`@go-like/core`          | `@go-like/web/node` 或框架的原生 Fetch handler                            | Router、framework middleware、auth、response policy          |
| 调用内部服务                 | `@go-like/client`、`@go-like/transport`  | `@go-like/transport-memory`、`@go-like/transport-http`、`@go-like/struct` | Business idempotency、generated IDL、全双工 RPC              |
| 发现服务实例                 | `@go-like/registry`                      | 一个 Registry provider、filters、一个 Selector                            | Backend lease/revision consistency 或 global service locator |
| 加载配置                     | `@go-like/config`                        | env/file/YAML 或一个外部 Config provider                                  | Ambient global configuration 和跨资源事务                    |
| 保存权威字节数据             | `@go-like/store`                         | Memory、File、Consul、etcd 或 Vault provider                              | 通用 database/ORM 或统一的 provider 保证                     |
| 缓存可丢弃的值               | `@go-like/cache`                         | Memory 或 Redis provider                                                  | Authority、persistence、CAS、持久化业务状态                  |
| 发布或消费字节数据           | `@go-like/broker`                        | Memory、RabbitMQ 或 NATS                                                  | 通用 ack/nack/term、DLQ、持久 offset、exactly-once           |
| 增加 typed event payload     | `@go-like/event`                         | 一个应用自己的 Codec                                                      | Schema registry、replay、settlement policy                   |
| 运行已有 scheduler 或 worker | `@go-like/core`                          | `@go-like/croner`、`@go-like/bullmq`、`@go-like/nats`                     | 原生 queue、processor、job policy 或 broker connection       |
| 增加运维能力                 | `@go-like/health`、`@go-like/resilience` | Pino、Winston、OTel、Prometheus                                           | Global instrumentation、auth、deployment policy              |

## 基础包

| Package               | 用途                                                      | 主要 public API                                                                                                                                                                                                   | Runtime 与所有权说明                                                                     |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@go-like/context`    | 显式取消、截止时间、cause 和 value                        | `background`、`todo`、`withCancel`、`withCancelCause`、`withDeadline`、`withDeadlineCause`、`withTimeout`、`withTimeoutCause`、`cause`、`withoutCancel`、`withValue`、`afterFunc`、`canceled`、`deadlineExceeded` | Portable source contract。`Context` 内部使用 `AbortSignal`；它不是 Go ABI，也不是 DI bag |
| `@go-like/core`       | 组合 application 与 resource lifecycle                    | `newApp`、`server`、`registrar`、`beforeStart`、`afterStart`、`beforeStop`、`afterStop`、`startTimeout`、`stopTimeout`、`context`、`id`、`name`、`version`、`metadata`、`endpoint`、`newContext`、`fromContext`   | Portable structural `Server` 和 `App`。Sibling stop calls 是并发的                       |
| `@go-like/metadata`   | 不可变的多值 metadata 与显式传播                          | metadata types 和 propagation functions                                                                                                                                                                           | Client 与 server metadata domains 分开；metadata 不是可信 identity                       |
| `@go-like/struct`     | typed endpoints 和 JSON 的 runtime Struct validation      | `struct`、`Infer`、`Struct`、`StructError`、`setErrorMap`                                                                                                                                                         | 当前 public package。它是 runtime validation，不是 Protobuf、IDL 或 generated code       |
| `@go-like/health`     | Liveness 与 readiness probe registry                      | `newProbeRegistry`、`ProbeRegistry`、`Probe`、`ProbeReport`                                                                                                                                                       | 空 liveness 通过；空 readiness fail closed；默认 probe timeout 是 1,000 ms               |
| `@go-like/resilience` | 显式 retry、circuit breaker 和 non-blocking rate limiting | `retry`、`exponentialBackoff`、`newCircuitBreaker`、`newTokenBucketLimiter`、`circuitOpen`                                                                                                                        | Retry authorization 由调用方声明；没有自动幂等判断，也没有后台 limiter task              |

## Web 与内部调用包

| Package                        | 用途                                                                 | 主要 public API                                                                                                                                                                                              | 不负责                                                                               |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `@go-like/web`                 | 标准 Web Handler 和 request Context bridge                           | `Handler`、`ContextHandler`、`contextHandler`                                                                                                                                                                | Routes、WebSockets、SSE policy、listener、authentication                             |
| `@go-like/web/health`          | Health Handler routes                                                | `createHealthHandler`                                                                                                                                                                                        | Probe registration 或 framework route mounting                                       |
| `@go-like/web/node`            | 围绕 Fetch Handler 的 Node listener                                  | `newNodeServer`、`hostname`、`port`、`nodeShutdownTimeout`                                                                                                                                                   | Internal HTTP Transport TLS/HTTP2；这些用 `@go-like/transport-http/node`             |
| `@go-like/client`              | 内部 unary calls、discovery、selection、middleware、retries、pooling | `newClient`、`withTransport`、`withAddress`、`withDiscovery`、`withSelector`、`withFilter`、`withBlock`、`withRetry`、`middleware`、`use`、`circuitBreakerMiddleware`、`closeTimeout`、`poolSize`、`poolTtl` | Framework routes、business replay safety、physical socket limits                     |
| `@go-like/server`              | 内部 unary Message server 和 route dispatch                          | `newServer`、`transport`、`address`、`advertise`、`handler`、`middleware`、`use`、`listenOption`、`rateLimitMiddleware`                                                                                      | 外部 Fetch routes 和 protocol-specific business authorization                        |
| `@go-like/transport`           | Transport SPI 和 Message boundary                                    | `Transport`、`Client`、`Listener`、`Socket`、`Message`、`TransportInfo`、`Endpoint`、`endpoint`、`chain`、`serviceError`                                                                                     | 除非选择 provider，否则不提供具体 wire；没有 internal full-duplex promise            |
| `@go-like/transport-memory`    | 进程内 unary Transport                                               | `newMemoryTransport`                                                                                                                                                                                         | 跨进程行为、持久化、网络 fallback、TLS                                               |
| `@go-like/transport-http`      | 基于 Fetch 的内部 HTTP Transport                                     | `newHTTPTransport`、`executor`、`maxMessageBytes`                                                                                                                                                            | 没有注入 `HTTPHost` 时，不是完整的 portable listener；也不提供原生 Node TLS controls |
| `@go-like/transport-http/node` | 原生 Node internal HTTP Transport                                    | `newNodeHTTPTransport`、`allowHTTP1`、`clientAuth`                                                                                                                                                           | Deno listener 或自动安全策略                                                         |

## Config 包

| Package 或 subpath           | 用途                                    | 主要 function                                                                                                          | 边界                                                                   |
| ---------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `@go-like/config`            | Config manager 和 object sources        | `newConfig`、`source`、`objectSource`、`schema`、`resolver`、`placeholderResolver`、`onReloadError`、`onTerminalError` | Immutable snapshots 和已接纳的 watcher lifecycle；自身不是 Core Server |
| `@go-like/config/env`        | 显式的 environment record source        | `envSource`                                                                                                            | 接收注入的 record；不读取 ambient runtime globals                      |
| `@go-like/config/file`       | File source 和 JSON decoder contract    | `fileSource`、`jsonFileDecoder`                                                                                        | 需要显式的 file capability                                             |
| `@go-like/config/node`       | Node file capability                    | `newNodeFileCapability`                                                                                                | Runtime-specific Node subpath                                          |
| `@go-like/config/yaml`       | 把 YAML 解码成 ConfigObject             | `decodeYaml`                                                                                                           | Decoding 不是 source watching 或 schema publication                    |
| `@go-like/config-consul`     | Consul HTTP configuration source        | `consulSource`、`jsonConsulDecoder`                                                                                    | Consul blocking-query 和 consistency behavior                          |
| `@go-like/config-etcd`       | etcd gateway configuration source       | `etcdSource`、`jsonEtcdDecoder`                                                                                        | Revision、compaction 和 gateway protocol behavior                      |
| `@go-like/config-kubernetes` | 一个 Kubernetes ConfigMap 或 Secret key | `kubernetesSource`、`jsonKubernetesDecoder`                                                                            | Resource-version/relist semantics；没有跨资源事务                      |
| `@go-like/config-vault`      | Vault KV v2 source                      | `vaultSource`                                                                                                          | Vault authentication、TLS、token policy 和 KV semantics                |

Config external providers 使用注入的标准 Fetch。凭据和 redirects 的安全行为取决于 provider；`http` 还是 `https` 由应用或部署决定，除非 provider 主动拒绝。

## Registry 包

| Package                        | 用途                                                | 主要 function                                                                                                                                      | Runtime/backend 说明                                                 |
| ------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `@go-like/registry`            | Contract、snapshot、filters、selectors              | `filterVersion`、`filterLabel`、`newRandomSelector`、`newRoundRobinSelector`、`newWeightedRoundRobinSelector`、`newP2CSelector`、`newEWMASelector` | Complete replacement snapshots；selection feedback 是显式的          |
| `@go-like/registry/provider`   | Provider author helpers 和 registration diagnostics | `providerOptions`、`notifyRegistrationError`、snapshot/provider helpers                                                                            | 面向 provider 的 subpath，不是普通应用入口                           |
| `@go-like/registry-consul`     | Consul registration 和 discovery                    | `newConsulRegistry`                                                                                                                                | Health-filtered、blocking-query、TTL/critical 行为由 Consul 原生决定 |
| `@go-like/registry-etcd`       | etcd registration 和 discovery                      | `newEtcdRegistry`                                                                                                                                  | Leases、revisions、watch/relist、compaction 行为                     |
| `@go-like/registry-kubernetes` | EndpointSlice discovery 和可选 registration         | `newKubernetesRegistry`                                                                                                                            | Kubernetes EndpointSlice、owner references；不虚构 TTL               |
| `@go-like/registry-mdns`       | 本地 multicast discovery                            | `newMDNSRegistry`                                                                                                                                  | Root provider 按设计可移植；UDP host 在 `/node`                      |
| `@go-like/registry-mdns/node`  | Node UDP multicast capability                       | `newNodeMDNSHost`                                                                                                                                  | 明确的 Node runtime subpath                                          |
| `@go-like/registry-zookeeper`  | ZooKeeper ephemeral registration 和 discovery       | `newZookeeperRegistry`                                                                                                                             | 文档支持 Node.js 和 Bun；明确不支持 Deno                             |

Registry 保存的是可达性状态，不是持久业务数据。Provider 在重建临时 watcher 时可以保留上一份 snapshot，但权威的空 snapshot 必须 fail closed。

## Store 与 Cache 包

| Package                    | 用途                               | 主要 function                                                                                                      | 边界                                                                            |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `@go-like/store`           | Record contract 和 options         | `expiresIn`、`ifAbsent`、`ifRevision`、`prefix`、`limit`、`cursor`、`writeOptions`、`deleteOptions`、`listOptions` | Revisions、CAS、TTL、pagination；各 provider 的能力不同                         |
| `@go-like/store/provider`  | Provider write/delete/list helpers | `writeOptions`、`deleteOptions`、`listOptions`、snapshot 和 conflict helpers                                       | 面向 provider；自身不是 durable backend                                         |
| `@go-like/store-memory`    | 进程内 Store tests                 | `newMemoryStore`、`clock`                                                                                          | 没有重启持久化或跨进程状态                                                      |
| `@go-like/store-file`      | 本地 file Store                    | `newFileStore`                                                                                                     | 单所有者本地状态；Node host 使用 `/node`                                        |
| `@go-like/store-file/node` | Node file capability               | `newNodeFileStoreHost`                                                                                             | 明确的 Node subpath                                                             |
| `@go-like/store-consul`    | Consul KV Store                    | `newConsulStore`                                                                                                   | Consul sessions、TTL/CAS combinations，以及不确定的 mutation behavior           |
| `@go-like/store-etcd`      | etcd KV Store                      | `newEtcdStore`                                                                                                     | Gateway、lease、revision、compaction 和不确定的 mutation behavior               |
| `@go-like/store-vault`     | Vault KV v2 Store                  | `newVaultStore`                                                                                                    | 不承诺统一的 Store TTL/CAS semantics                                            |
| `@go-like/cache`           | Disposable value/TTL contract      | `expiresIn`、`putOptions`                                                                                          | 没有 CAS、revision、durability 或 authority                                     |
| `@go-like/cache-memory`    | 进程内 cache                       | `newMemoryCache`、`clock`                                                                                          | 没有持久化；lazy expiry；适合测试和本地加速                                     |
| `@go-like/cache-redis`     | Redis-backed cache                 | `newRedisCache`                                                                                                    | 原生 Redis connection、URL credential handling 和 runtime requirements 仍然可见 |

## Broker、event 与工作包

| Package 或 subpath               | 用途                                            | 主要 function                                                                  | 边界                                                                 |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `@go-like/broker`                | Byte/topic Broker contract                      | `newBrokerServer`                                                              | 没有 portable ack/nack/term、DLQ、retry 或 durable offset            |
| `@go-like/broker/provider`       | Provider terminal registration                  | `registerSubscriberTerminal`、`subscriberTerminal`                             | 面向 provider 的 lifecycle bookkeeping                               |
| `@go-like/broker-memory`         | Exact-topic 进程内 broker                       | `newMemoryBroker`                                                              | 实例私有、broadcast、没有 durable settlement                         |
| `@go-like/broker-rabbitmq`       | RabbitMQ borrowed、confirm 或 recovering broker | `newRabbitMqBroker`、`newConfirmRabbitMqBroker`、`newRecoveringRabbitMqBroker` | `amqplib` channel/connection 和原生 settlement semantics             |
| `@go-like/event`                 | Broker 之上的 typed codec                       | `eventBroker`                                                                  | 原生 delivery 仍可见；没有 replay 或 schema registry                 |
| `@go-like/nats`                  | NATS lifecycle 和原生 broker entrypoints        | `newNatsCoreServer`、`natsCoreDrainTimeout`                                    | Core connection 和 subscription semantics 仍是原生的                 |
| `@go-like/nats/broker`           | NATS Core Broker                                | `newNatsCoreBroker`                                                            | 原生 `Msg`、queue group、drain 和 at-most-once semantics             |
| `@go-like/nats/jetstream`        | JetStream ConsumerMessages lifecycle            | `newNatsJetStreamServer`、`natsJetStreamCloseTimeout`                          | 原生 ConsumerMessages close/stop/closed behavior                     |
| `@go-like/nats/jetstream/broker` | JetStream 上的 typed byte Broker                | `newNatsJetStreamBroker`                                                       | `JsMsg`、`PubAck`、ack/nak/term、redelivery 和 DLQ 仍是原生语义      |
| `@go-like/croner`                | 已有 Croner jobs 的 lifecycle                   | `newCronerServer`                                                              | Croner schedule、callback、overlap 和 passive terminal semantics     |
| `@go-like/bullmq`                | 已有 BullMQ Worker 的 lifecycle                 | `newBullMqWorkerServer`、`bullMqWorkerShutdownTimeout`                         | Queue、Redis、processor、retry/backoff、stalled jobs 和 job identity |

## 日志与可观测性包

| Package               | 用途                                            | 主要 function                                                                                                                                                                       | 不负责                                                                  |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `@go-like/pino`       | Pino request/broker wrappers 和 drain lifecycle | `logClient`、`logUnaryMiddleware`、`logWebHandler`、`logBroker`、`newPinoServer`、`pinoDrainTimeout`                                                                                | Logger construction、destination policy、redaction、global setup        |
| `@go-like/winston`    | Winston wrappers 和 shutdown lifecycle          | logging wrappers、`newWinstonServer`                                                                                                                                                | Logger/transports 以及它们原生的 finish/close semantics                 |
| `@go-like/otel`       | 显式的 OpenTelemetry trace/metric wrappers      | `newOtelServer`、`traceClient`、`traceUnaryMiddleware`、`traceWebHandler`、`traceBroker`、`measureClient`、`measureClientMiddleware`、`measureUnaryMiddleware`、`newRequestMetrics` | Global providers、exporters、context manager、automatic instrumentation |
| `@go-like/prometheus` | Prometheus request metrics 和 scrape Handler    | `newRequestMetrics`、`measureClient`、`measureUnaryMiddleware`、`measureWebHandler`、`measureBroker`、`createPrometheusHandler`                                                     | Global Registry、供给 Registry 之外的 collectors、background tasks      |

## 完整的 public source subpath 清单

以下是当前 package manifests 声明的 23 个显式 source subpath。生成的 packages 可能额外导出 metadata-only 的 `./package.json`；那不是 source API。

|   # | Subpath                          | 主要 exports                                               | 面向对象                      |
| --: | -------------------------------- | ---------------------------------------------------------- | ----------------------------- |
|   1 | `@go-like/broker/provider`       | `registerSubscriberTerminal`、`subscriberTerminal`         | Provider authors              |
|   2 | `@go-like/cache/provider`        | `putOptions`                                               | Provider authors              |
|   3 | `@go-like/config/env`            | `envSource`                                                | Application authors           |
|   4 | `@go-like/config/file`           | `fileSource`、`jsonFileDecoder`                            | Application authors           |
|   5 | `@go-like/config/node`           | `newNodeFileCapability`                                    | Node runtime authors          |
|   6 | `@go-like/config/yaml`           | `decodeYaml`                                               | Application authors           |
|   7 | `@go-like/core/lifecycle`        | `waitForContext`                                           | Lifecycle/provider authors    |
|   8 | `@go-like/core/node`             | `signal`                                                   | Node/Bun process integration  |
|   9 | `@go-like/nats/broker`           | `newNatsCoreBroker`                                        | NATS Core applications        |
|  10 | `@go-like/nats/jetstream`        | `newNatsJetStreamServer`、`natsJetStreamCloseTimeout`      | JetStream applications        |
|  11 | `@go-like/nats/jetstream/broker` | `newNatsJetStreamBroker`                                   | JetStream Broker applications |
|  12 | `@go-like/registry/provider`     | provider options 和 snapshot helpers                       | Provider authors              |
|  13 | `@go-like/registry-mdns/node`    | `newNodeMDNSHost`                                          | Node mDNS applications        |
|  14 | `@go-like/store/provider`        | write/delete/list options 和 snapshots                     | Provider authors              |
|  15 | `@go-like/store-file/node`       | `newNodeFileStoreHost`                                     | Node file Store applications  |
|  16 | `@go-like/struct/codec`          | `encodeJson`、`decodeJson`                                 | Typed contract authors        |
|  17 | `@go-like/struct/runtime`        | introspection 和 parsing helpers                           | Runtime/provider authors      |
|  18 | `@go-like/transport/headers`     | `Go-Like-*` header constants                               | Transport/provider authors    |
|  19 | `@go-like/transport/json`        | `encodeJsonBody`、`decodeJsonBody`、`jsonContentType`      | Typed/raw transport authors   |
|  20 | `@go-like/transport/provider`    | Message、metadata、ServiceError codecs 和 errors           | Provider authors              |
|  21 | `@go-like/transport-http/node`   | `newNodeHTTPTransport`、`allowHTTP1`、`clientAuth`         | Node HTTP applications        |
|  22 | `@go-like/web/health`            | `createHealthHandler`                                      | Web applications              |
|  23 | `@go-like/web/node`              | `newNodeServer`、`hostname`、`port`、`nodeShutdownTimeout` | Node Web host applications    |

当前 TypeScript configuration 含有过时的 `@go-like/otel/testing` 和 `@go-like/web/node/testing` path mappings，但它们不是当前 package manifest exports。在仓库解决这个不一致前，不要把它们写成 public entrypoints。

## Runtime 选择矩阵

| Entry 或 provider family                                       | Portable source                    | Bun/Node native                                        | Deno claim                                  | 证据措辞                                                                |
| -------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------- |
| Context、Core root、Health、Metadata、Resilience、Struct       | Yes                                | 不需要 native import                                   | 已声明选定的 runtime lanes                  | Source contract；发布措辞前检查当前已执行的 matrix                      |
| Web root 和 Web health                                         | Yes                                | 需要单独的 host                                        | Standard Handler boundary                   | Handler 可移植；Handler 不是 listener                                   |
| Memory Transport、Memory Store、Memory Cache、Memory Broker    | Process-local source               | 不需要 external service                                | 相同的进程内含义                            | 不是 distributed、durable 或 cross-process                              |
| HTTP root 与 Fetch-backed Config/Registry/Store providers      | Injected Fetch                     | Runtime 选择 Fetch                                     | 在存在 package lane 时有 source-backed 证据 | 可以按 source 或已声明 runtime lane 说可移植，不要承诺 universal parity |
| `/node` subpaths                                               | No                                 | Node-specific，部分可在 Bun 执行                       | 没有 Deno entrypoint                        | 显式 import 会改变 runtime graph                                        |
| NATS、RabbitMQ、BullMQ、Redis、Pino、Winston、OTel native SDKs | Provider-dependent                 | Node/Bun fixtures 或 package-specific runtime evidence | 不要推断支持 Deno                           | 阅读 provider README 和 E2E scope                                       |
| ZooKeeper                                                      | No Deno support in provider README | Node/Bun                                               | Explicitly unsupported                      | 不要从 Registry root 推广结论                                           |

## Function 选择规则

- 需要 Context 时，在 Web edge 使用 `contextHandler`，不要自造 framework request bag。
- 一个进程拥有多个 admitted resource，或者需要明确 signal 和 shutdown ownership 时，使用 `newApp` 和 `server(...)`。
- 两端都需要共享 runtime Struct validation 时，使用 typed `endpoint(...)` 和 `handler(contract, fn)`；如果应用拥有另一种字节契约，则使用 raw `handler(service, endpoint, fn)`。
- 在 Discovery 之前使用 `withAddress(...)`。它更容易测试，也会让目标 identity 明确。
- 只有服务确实需要它们增加的 control-plane 行为时，才使用 `withDiscovery(...)`、`withSelector(...)`、`withFilter(...)` 和 `withBlock()`。
- 只有写清楚 replay authorization、最大总尝试次数、failure predicate 和 business idempotency 后，才使用 `withRetry(...)`。
- 用 `newMemoryStore` 做确定性的测试，不要用它做 durability 声明。
- 用 `newMemoryCache` 做可丢弃的加速，不要把它当作 appointment 或 payment authority。
- 用 `newBrokerServer` 把一个 subscription 接进 Core，不要因此得到通用 queue worker 或 settlement API。
- 只有在 application 已创建 native provider 或 registry 后，才使用 `newOtelServer`、`newPinoServer`、`newWinstonServer` 或 Prometheus Handler。

## 明确排除项

当前 public inventory 中没有任何 package 应被描述为拥有 gRPC、Protobuf、IDL code generation、generated RPC clients、internal full-duplex streams、Event Store/history/replay、通用 authentication/authorization、ORM behavior、global service locator 或 cluster orchestration。Provider 或 application 可以用无关库处理其中某一项，但那不属于 go-like 当前契约。

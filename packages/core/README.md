# @go-like/core

`@go-like/core` 是唯一的零运行时依赖包。它提供应用 API、插座、机制、参考实现、运行时绑定和插头作者 SDK。
公开入口 41 个。没有全局默认实例，也没有全局注册；应用构造实现并传入。

清单的 `devDependencies` 声明 `@types/node` `26.6.6`。发布的 dist 清单不携带它。源码不导入第三方运行时包。指南见
[文档首页](../../doc/index.md)，可运行案例见 [examples](../../examples/README.md)。

角色：`app` 应用 API，`binding` 运行时绑定，`socket` 插座，`machinery` 机制，`reference` 参考实现，
`sdk` 插头作者 SDK，`testing` 一致性测试。通道：`P` 可移植，`N` Node.js，`B` Bun。

## 应用与生命周期

| #   | 入口                      | 角色             | 通道 | 关键导出                                                                                                                                                                                                                                                                  |
| --- | ------------------------- | ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `@go-like/core`           | app              | P    | `newApp`、`App`、`AppInfo`、`AppHook`、`AppOption`、`AppNotReadyError`；`context`、`id`、`name`、`version`、`metadata`、`endpoint`；`telemetry`、`resources`、`server`、`registrar`、`readyProbe`；预算与钩子；`newContext`、`fromContext`。不导出 `Server`、`Endpointer` |
| 2   | `@go-like/core/node`      | binding          | N, B | `signal`、`ProcessSignal`                                                                                                                                                                                                                                                 |
| 3   | `@go-like/core/lifecycle` | socket+machinery | P    | `Server`、`Endpointer`；`newResourceServer`、`ResourceServerOptions`、`ResourceServerError`（`GO_LIKE_RESOURCE_ALREADY_STARTED`、`GO_LIKE_RESOURCE_CLOSED`）                                                                                                              |

`signal()` 必须显式传入。core 不安装隐式进程钩子。

## 基础概念

| #   | 入口                       | 角色             | 通道 | 关键导出                                                                                              |
| --- | -------------------------- | ---------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| 4   | `@go-like/core/context`    | socket+machinery | P    | `Context`；`background`、`todo`、派生函数、`waitForContext`                                           |
| 5   | `@go-like/core/metadata`   | machinery        | P    | 元数据模型与 client/server Context 辅助函数                                                           |
| 6   | `@go-like/core/struct`     | machinery        | P    | `struct` 构建器、`StructError`、`isStructError`、`encodeJson`、`decodeJson`、`jsonCodec`              |
| 7   | `@go-like/core/health`     | socket+machinery | P    | `ProbeRegistry`、`Probe`；`newProbeRegistry`                                                          |
| 8   | `@go-like/core/resilience` | socket+machinery | P    | `RateLimiter`；`retry`、`Backoff`、`exponentialBackoff`、`newCircuitBreaker`、`newTokenBucketLimiter` |

## 观测

| #   | 入口                               | 角色             | 通道 | 关键导出                                                                                                                                                                                         |
| --- | ---------------------------------- | ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | `@go-like/core/telemetry`          | socket+machinery | P    | `TelemetryLifecycle`；`Telemetry`、`newTelemetry`、`withTelemetry`；语义约定常量                                                                                                                 |
| 10  | `@go-like/core/telemetry/provider` | sdk              | P    | `beginUnit`、`observing`、`logEvent`、`logCorrelation`、`resourceFromContext`、`withRemoteSpanContext`、`isValidSpanContext`                                                                     |
| 11  | `@go-like/core/log`                | socket+machinery | P    | `LogHandler`；`log`、`debug`、`info`、`warn`、`error`、`withLogAttrs`                                                                                                                            |
| 12  | `@go-like/core/trace`              | socket+machinery | P    | `TracerProvider`、`Span`、`Propagator`；`inSpan`、`spanFromContext`、`newTraceContextPropagator`                                                                                                 |
| 13  | `@go-like/core/metric`             | socket+machinery | P    | `MeterProvider`、`Instrument`；`newCounter`、`newUpDownCounter`、`newHistogram`、`newGauge`                                                                                                      |
| 14  | `@go-like/core/testing`            | testing          | P    | `newTelemetryRecorder`、`ConformanceCase`；`cacheConformance`、`registryConformance`、`storeConformance`、`brokerConformance`、`jobQueueConformance`、`scheduleConformance` 以及四个观测插座用例 |

## RPC 与 Web

| #   | 入口                                | 角色             | 通道 | 关键导出                                                                                                                  |
| --- | ----------------------------------- | ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| 15  | `@go-like/core/transport`           | socket+machinery | P    | `Transport`、`Client`、`Listener`、`TransportHandler`、`TransportInfo`；`defineService`、`serviceError`、`isServiceError` |
| 16  | `@go-like/core/transport/provider`  | sdk              | P    | 四个传输错误工厂、`newServerContext`、`observeResponseBody`                                                               |
| 17  | `@go-like/core/transport/memory`    | reference        | P    | `newMemoryTransport`                                                                                                      |
| 18  | `@go-like/core/transport/http`      | reference        | P    | `newHTTPTransport`。`listen` 拒绝，可移植入口只拨号                                                                       |
| 19  | `@go-like/core/transport/http/node` | binding          | N    | `newNodeHTTPTransport`。Bun 上也可以作监听器                                                                              |
| 20  | `@go-like/core/server`              | machinery        | P    | `newServer`、`address`、`advertise`、`transport`、`rateLimitMiddleware`                                                   |
| 21  | `@go-like/core/client`              | machinery        | P    | `newClient`、`withEndpoint`、`withDiscovery`、`withRetry`、`circuitBreakerMiddleware`                                     |
| 22  | `@go-like/core/web`                 | socket+machinery | P    | `Handler`；`contextHandler`、`requestContext`、`createHealthHandler`                                                      |
| 23  | `@go-like/core/web/node`            | binding          | N    | `newNodeServer`、`port`、`hostname`、`nodeShutdownTimeout`                                                                |
| 24  | `@go-like/core/web/bun`             | binding          | B    | `newBunServer`、`port`、`hostname`、`bunShutdownTimeout`                                                                  |

`@go-like/core/web` 的 `Handler` 是单参数 `(request: Request) => Response | Promise<Response>`。core 没有路由器。

## 发现、配置与 fetch

| #   | 入口                              | 角色             | 通道 | 关键导出                                                                                                                                                                                                  |
| --- | --------------------------------- | ---------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 25  | `@go-like/core/registry`          | socket+machinery | P    | `Registrar`、`Discovery`、`Watcher`、`Registry`、`Selector`、`Filter`；`newDiscoveryResolver`、`selectEndpoint`、`snapshotServiceInstance`                                                                |
| 26  | `@go-like/core/registry/provider` | sdk              | P    | `newSnapshotWatcher`、`newIdentityLocks`、`startHeartbeat`、`sha256Base32`、错误工厂                                                                                                                      |
| 27  | `@go-like/core/registry/memory`   | reference        | P    | `newMemoryRegistry`                                                                                                                                                                                       |
| 28  | `@go-like/core/config`            | socket+machinery | P    | `ConfigSource`、`ConfigSourceWatcher`、`ConfigDecoder`、`ConfigResolver`、`FileCapability`、`FileWatcher`；`newConfig`、`objectSource`、`envSource`、`fileSource`、`jsonDecoder`；类型 `StandardSchemaV1` |
| 29  | `@go-like/core/config/provider`   | sdk              | P    | `newSourceWatcher`、`newConfigSourceMissingError`、`admitConfigObject`                                                                                                                                    |
| 30  | `@go-like/core/config/node`       | binding          | N    | `newNodeFileCapability`                                                                                                                                                                                   |
| 31  | `@go-like/core/fetch`             | socket+machinery | P    | `Fetch`；`newFetchClient`、`parseOrigin`、`headerValue`、`isRetryableStatus`                                                                                                                              |

## 数据、消息与任务

| #   | 入口                            | 角色             | 通道 | 关键导出                                                                                                     |
| --- | ------------------------------- | ---------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| 32  | `@go-like/core/cache`           | socket           | P    | `Cache`；`expiresIn`、`putOptions`                                                                           |
| 33  | `@go-like/core/cache/memory`    | reference        | P    | `newMemoryCache`                                                                                             |
| 34  | `@go-like/core/store`           | socket           | P    | `Store`；选项函数、`StoreConflictError`（`GO_LIKE_STORE_CONFLICT`）                                          |
| 35  | `@go-like/core/store/provider`  | sdk              | P    | 选项解析、冲突错误工厂、快照                                                                                 |
| 36  | `@go-like/core/store/memory`    | reference        | P    | `newMemoryStore`                                                                                             |
| 37  | `@go-like/core/broker`          | socket+machinery | P    | `Broker`、`Subscriber`、`Codec`；`newBrokerServer`、`eventBroker`                                            |
| 38  | `@go-like/core/broker/provider` | sdk              | P    | `deliver`、`publish`；`registerSubscriberTerminal`、`brokerTopic`、`snapshotBrokerMessage`、`newBrokerEvent` |
| 39  | `@go-like/core/broker/memory`   | reference        | P    | `newMemoryBroker`                                                                                            |
| 40  | `@go-like/core/job`             | socket+machinery | P    | `Schedule`、`JobQueue`；`newScheduleServer`、`newIntervalSchedule`、`newPermanentJobError`                   |
| 41  | `@go-like/core/job/provider`    | sdk              | P    | `runJob`、`enqueue`、`dispatchJob`；选项解析与错误工厂                                                       |

计数：`app` 1，`binding` 5，`/provider` SDK 7，`testing` 1，参考实现 6，其余 21 个是概念入口。

## 刻意不在 core 中

这些能力有意留在 core 外面。

| 概念                       | 理由                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| 鉴权                       | 没有使用者。对端身份只有 mTLS 的 `TransportInfo.peerIdentity()`                            |
| 错误 `reason` 与 gRPC 映射 | 仍待确认（OQ11）。Connect 集成不使用 core 的 `ServiceError` 映射                           |
| 熔断器工厂与分布式限流     | 没有这些使用者。进程内的 `newCircuitBreaker` 与 `newTokenBucketLimiter` 仍在 `/resilience` |
| 自适应削峰                 | 没有使用者                                                                                 |
| 默认信号处理               | 必须显式传入 `signal()`。没有隐式进程钩子                                                  |
| RPC 编解码插座             | 内部 RPC 只用 JSON                                                                         |
| 路由器                     | 不提供。同一个宿主上的路径分派由应用自己的函数完成                                         |

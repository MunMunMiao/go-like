# 包参考

本 workspace 包含 **20** 个公共 `@go-like/*` 包，在此 checkout 中每个的版本都是 `0.0.1`。根 workspace 是私有的。该版本不能证明 npm 可用。44 个 `examples/*` 目录是私有应用。

共有 **75** 个公共入口：41 个在 `@go-like/core` 上，34 个在插头和生成器上。生成的 `dist/package.json` 里的 `./package.json` 导出是 metadata，不是另一个入口。

`@go-like/core` 没有第三方运行时依赖。除 `@go-like/protoc-gen-like` 以外的每个包都以 peer 依赖同一版本的 core。生成器不依赖 core。插头的行为和限制在各自的 README 里。本页是清单。

## 20 个包

| 包                         | 入口                                     | 填入的内容                                 |
| -------------------------- | ---------------------------------------- | ------------------------------------------ |
| `@go-like/core`            | 41                                       | 插座、机制、memory 参考实现和 runtime 绑定 |
| `@go-like/otel`            | `.`                                      | Tracer、meter、日志 handler、propagator    |
| `@go-like/pino`            | `./log`                                  | `LogHandler`                               |
| `@go-like/winston`         | `./log`                                  | `LogHandler`                               |
| `@go-like/prometheus`      | `./metric`                               | `MeterProvider` 和一个抓取 `Handler`       |
| `@go-like/consul`          | `.`、`./registry`、`./config`、`./store` | 共享客户端、注册中心、配置、存储           |
| `@go-like/etcd`            | `.`、`./registry`、`./config`、`./store` | 共享客户端、注册中心、配置、存储           |
| `@go-like/vault`           | `.`、`./config`、`./store`               | 共享客户端、配置、存储                     |
| `@go-like/kubernetes`      | `.`、`./registry`、`./config`            | 共享客户端、注册中心、配置                 |
| `@go-like/zookeeper`       | `./registry`、`./registry/node`          | 建在客户端工厂上的注册中心；Node 工厂      |
| `@go-like/mdns`            | `./registry`、`./registry/node`          | 建在 `MDNSHost` 上的注册中心；Node 宿主    |
| `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                            |
| `@go-like/nats`            | `./broker`、`./jetstream`                | Core 与 JetStream broker                   |
| `@go-like/rabbitmq`        | `./broker`                               | Broker                                     |
| `@go-like/redis`           | `./cache`                                | Cache，以及一个资源层 `Server`             |
| `@go-like/bullmq`          | `./job`                                  | `JobQueue`，以及一个资源层 `Server`        |
| `@go-like/croner`          | `./job`                                  | `Schedule`                                 |
| `@go-like/file`            | `./store`、`./store/node`                | Store 和一个资源层 `Server`；Node 宿主     |
| `@go-like/connectrpc`      | `.`、`./node`                            | Fetch handler；Node gRPC 服务端和客户端    |
| `@go-like/protoc-gen-like` | `.`                                      | Buf 插件和 `bin`。没有插座                 |

计数：41 + 4 + 8 + 6 + 10 + 6 = 75。插头和生成器的入口是 core 的 41 个之后的那 34 个。

## Core 入口

| 入口                                | 角色      | 主要导出                                                                              |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `@go-like/core`                     | 应用      | `newApp`、`telemetry`、`resources`、`server`、`registrar`、`readyProbe`、hook、预算   |
| `@go-like/core/node`                | Node 绑定 | `signal`                                                                              |
| `@go-like/core/lifecycle`           | 插座      | `Server`、`Endpointer`、`newResourceServer`                                           |
| `@go-like/core/context`             | 插座      | `background`、`withCancel`、`withTimeout`、`waitForContext`                           |
| `@go-like/core/metadata`            | 机制      | `newMetadata`，以及客户端和服务端 Context 辅助                                        |
| `@go-like/core/struct`              | 机制      | `struct`、`StructError`、`encodeJson`、`decodeJson`、`jsonCodec`                      |
| `@go-like/core/health`              | 插座      | `newProbeRegistry`                                                                    |
| `@go-like/core/resilience`          | 插座      | `retry`、`newCircuitBreaker`、`newTokenBucketLimiter`                                 |
| `@go-like/core/telemetry`           | 插座      | `newTelemetry`、`withTelemetry`、语义约定常量                                         |
| `@go-like/core/telemetry/provider`  | 插头 SDK  | `beginUnit`、`logCorrelation`、`resourceFromContext`                                  |
| `@go-like/core/log`                 | 插座      | `log`、`info`、`error`、`LogHandler`                                                  |
| `@go-like/core/trace`               | 插座      | `inSpan`、`newTraceContextPropagator`                                                 |
| `@go-like/core/metric`              | 插座      | `newCounter`、`newHistogram`、`newGauge`、`newUpDownCounter`                          |
| `@go-like/core/testing`             | 测试      | `newTelemetryRecorder`、`<concept>Conformance`                                        |
| `@go-like/core/transport`           | 插座      | `defineService`、`serviceError`、`isServiceError`、`ServerStream`                     |
| `@go-like/core/transport/provider`  | 插头 SDK  | 传输错误工厂、`newServerContext`                                                      |
| `@go-like/core/transport/memory`    | 参考实现  | `newMemoryTransport`                                                                  |
| `@go-like/core/transport/http`      | 参考实现  | `newHTTPTransport`                                                                    |
| `@go-like/core/transport/http/node` | Node 绑定 | `newNodeHTTPTransport`                                                                |
| `@go-like/core/server`              | 机制      | `newServer`、`address`、`advertise`、`rateLimitMiddleware`                            |
| `@go-like/core/client`              | 机制      | `newClient`、`withEndpoint`、`withDiscovery`、`withRetry`、`circuitBreakerMiddleware` |
| `@go-like/core/web`                 | 插座      | `Handler`、`contextHandler`、`requestContext`、`createHealthHandler`                  |
| `@go-like/core/web/node`            | Node 绑定 | `newNodeServer`、`hostname`、`port`、`nodeShutdownTimeout`                            |
| `@go-like/core/web/bun`             | Bun 绑定  | `newBunServer`、`hostname`、`port`、`bunShutdownTimeout`                              |
| `@go-like/core/registry`            | 插座      | Selector、filter、`newDiscoveryResolver`、`selectEndpoint`                            |
| `@go-like/core/registry/provider`   | 插头 SDK  | `newSnapshotWatcher`、`startHeartbeat`                                                |
| `@go-like/core/registry/memory`     | 参考实现  | `newMemoryRegistry`                                                                   |
| `@go-like/core/config`              | 插座      | `newConfig`、`objectSource`、`envSource`、`fileSource`、`jsonDecoder`                 |
| `@go-like/core/config/provider`     | 插头 SDK  | `newSourceWatcher`、`admitConfigObject`                                               |
| `@go-like/core/config/node`         | Node 绑定 | `newNodeFileCapability`                                                               |
| `@go-like/core/fetch`               | 插座      | `Fetch`、`newFetchClient`                                                             |
| `@go-like/core/cache`               | 插座      | `Cache`、`expiresIn`                                                                  |
| `@go-like/core/cache/memory`        | 参考实现  | `newMemoryCache`                                                                      |
| `@go-like/core/store`               | 插座      | `Store`、`ifAbsent`、`ifRevision`、`StoreConflictError`                               |
| `@go-like/core/store/provider`      | 插头 SDK  | 选项解析器、冲突工厂                                                                  |
| `@go-like/core/store/memory`        | 参考实现  | `newMemoryStore`                                                                      |
| `@go-like/core/broker`              | 插座      | `Broker`、`newBrokerServer`、`eventBroker`                                            |
| `@go-like/core/broker/provider`     | 插头 SDK  | `deliver`、`publish`                                                                  |
| `@go-like/core/broker/memory`       | 参考实现  | `newMemoryBroker`                                                                     |
| `@go-like/core/job`                 | 插座      | `newScheduleServer`、`newIntervalSchedule`、`JobQueue`                                |
| `@go-like/core/job/provider`        | 插头 SDK  | `runJob`、`enqueue`、`dispatchJob`                                                    |

`@go-like/core/server` 和 `@go-like/core/client` 都导出 `middleware` 和 `use`。一个文件两边都需要时，把其中一个作为命名空间导入。根入口的 `context`、`endpoint`、`server` 和 `metadata` 选项是 App 选项。这些名字与 OpenTelemetry 或 `defineService` 冲突时，把根入口作为命名空间导入。

除了测试和插头实现，应用代码不导入 `/provider` 或 `/testing`。

## Runtime 子路径

导入你打算使用的子路径。导出不以 `bun` 或 `node` 为条件。

- Node：`@go-like/core/node`、`@go-like/core/transport/http/node`、`@go-like/core/web/node`、`@go-like/core/config/node`、`@go-like/mdns/registry/node`、`@go-like/zookeeper/registry/node`、`@go-like/file/store/node`、`@go-like/connectrpc/node`。
- Bun 宿主：`@go-like/core/web/bun`。
- NATS、RabbitMQ、Redis 和 BullMQ 在 Node 和 Bun 上跟随它们的原生客户端。

## 这份目录没有写的内容

Memory 参考实现只在进程内。租约、确认、TTL 和事务的限制以插头 README 为准。[插头](/zh-Hans/reference/providers)链接那些 README。[错误](/reference/errors)列出公共代码。[迁移与接入](/zh-Hans/guide/migration)把历史 specifier 映射到这张表。

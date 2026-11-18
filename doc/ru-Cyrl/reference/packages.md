# Пакеты

В workspace **20** публичных пакетов `@go-like/*`. В этой рабочей копии каждый имеет версию `0.0.1`. Корневой workspace приватный. Версия не доказывает доступность в npm. 44 каталога `examples/*` — приватные приложения.

Публичных точек входа **75**: 41 у `@go-like/core` и 34 у plugs и генератора. Сгенерированный экспорт `./package.json` в `dist/package.json` — метаданные, а не ещё одна точка входа.

У `@go-like/core` нет сторонней runtime-зависимости. Каждый другой пакет, кроме `@go-like/protoc-gen-like`, объявляет peer-зависимость на ту же версию core. Генератор от core не зависит. Поведение и пределы plug — в README каждого plug. Эта страница — инвентарь.

## 20 пакетов

| Пакет                      | Точки входа                              | Чем заполняет                                                       |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `@go-like/core`            | 41                                       | Socket, механизмы, эталонные реализации в памяти и привязки runtime |
| `@go-like/otel`            | `.`                                      | Tracer, meter, обработчик логов, propagator                         |
| `@go-like/pino`            | `./log`                                  | `LogHandler`                                                        |
| `@go-like/winston`         | `./log`                                  | `LogHandler`                                                        |
| `@go-like/prometheus`      | `./metric`                               | `MeterProvider` и scrape-`Handler`                                  |
| `@go-like/consul`          | `.`, `./registry`, `./config`, `./store` | Общий клиент, registry, config, store                               |
| `@go-like/etcd`            | `.`, `./registry`, `./config`, `./store` | Общий клиент, registry, config, store                               |
| `@go-like/vault`           | `.`, `./config`, `./store`               | Общий клиент, config, store                                         |
| `@go-like/kubernetes`      | `.`, `./registry`, `./config`            | Общий клиент, registry, config                                      |
| `@go-like/zookeeper`       | `./registry`, `./registry/node`          | Registry поверх фабрики клиента; фабрика Node                       |
| `@go-like/mdns`            | `./registry`, `./registry/node`          | Registry поверх `MDNSHost`; host Node                               |
| `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                                                     |
| `@go-like/nats`            | `./broker`, `./jetstream`                | Брокеры Core и JetStream                                            |
| `@go-like/rabbitmq`        | `./broker`                               | Broker                                                              |
| `@go-like/redis`           | `./cache`                                | Cache и `Server` яруса ресурсов                                     |
| `@go-like/bullmq`          | `./job`                                  | `JobQueue` и `Server` яруса ресурсов                                |
| `@go-like/croner`          | `./job`                                  | `Schedule`                                                          |
| `@go-like/file`            | `./store`, `./store/node`                | Store и `Server` яруса ресурсов; host Node                          |
| `@go-like/connectrpc`      | `.`, `./node`                            | Fetch Handler; сервер и клиент gRPC для Node                        |
| `@go-like/protoc-gen-like` | `.`                                      | Плагин Buf и `bin`. Socket нет                                      |

Счёт: 41 + 4 + 8 + 6 + 10 + 6 = 75. Точки входа plugs и генератора — это 34 после 41 у core.

## Точки входа core

| Точка входа                         | Роль          | Первые экспорты                                                                         |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `@go-like/core`                     | App           | `newApp`, `telemetry`, `resources`, `server`, `registrar`, `readyProbe`, hooks, бюджеты |
| `@go-like/core/node`                | Привязка Node | `signal`                                                                                |
| `@go-like/core/lifecycle`           | Socket        | `Server`, `Endpointer`, `newResourceServer`                                             |
| `@go-like/core/context`             | Socket        | `background`, `withCancel`, `withTimeout`, `waitForContext`                             |
| `@go-like/core/metadata`            | Механизм      | `newMetadata`, помощники Context клиента и сервера                                      |
| `@go-like/core/struct`              | Механизм      | `struct`, `StructError`, `encodeJson`, `decodeJson`, `jsonCodec`                        |
| `@go-like/core/health`              | Socket        | `newProbeRegistry`                                                                      |
| `@go-like/core/resilience`          | Socket        | `retry`, `newCircuitBreaker`, `newTokenBucketLimiter`                                   |
| `@go-like/core/telemetry`           | Socket        | `newTelemetry`, `withTelemetry`, константы семантических соглашений                     |
| `@go-like/core/telemetry/provider`  | SDK для plug  | `beginUnit`, `logCorrelation`, `resourceFromContext`                                    |
| `@go-like/core/log`                 | Socket        | `log`, `info`, `error`, `LogHandler`                                                    |
| `@go-like/core/trace`               | Socket        | `inSpan`, `newTraceContextPropagator`                                                   |
| `@go-like/core/metric`              | Socket        | `newCounter`, `newHistogram`, `newGauge`, `newUpDownCounter`                            |
| `@go-like/core/testing`             | Тесты         | `newTelemetryRecorder`, `<concept>Conformance`                                          |
| `@go-like/core/transport`           | Socket        | `defineService`, `serviceError`, `isServiceError`, `ServerStream`                       |
| `@go-like/core/transport/provider`  | SDK для plug  | Фабрики ошибок транспорта, `newServerContext`                                           |
| `@go-like/core/transport/memory`    | Эталон        | `newMemoryTransport`                                                                    |
| `@go-like/core/transport/http`      | Эталон        | `newHTTPTransport`                                                                      |
| `@go-like/core/transport/http/node` | Привязка Node | `newNodeHTTPTransport`                                                                  |
| `@go-like/core/server`              | Механизм      | `newServer`, `address`, `advertise`, `rateLimitMiddleware`                              |
| `@go-like/core/client`              | Механизм      | `newClient`, `withEndpoint`, `withDiscovery`, `withRetry`, `circuitBreakerMiddleware`   |
| `@go-like/core/web`                 | Socket        | `Handler`, `contextHandler`, `requestContext`, `createHealthHandler`                    |
| `@go-like/core/web/node`            | Привязка Node | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`                              |
| `@go-like/core/web/bun`             | Привязка Bun  | `newBunServer`, `hostname`, `port`, `bunShutdownTimeout`                                |
| `@go-like/core/registry`            | Socket        | selectors, filters, `newDiscoveryResolver`, `selectEndpoint`                            |
| `@go-like/core/registry/provider`   | SDK для plug  | `newSnapshotWatcher`, `startHeartbeat`                                                  |
| `@go-like/core/registry/memory`     | Эталон        | `newMemoryRegistry`                                                                     |
| `@go-like/core/config`              | Socket        | `newConfig`, `objectSource`, `envSource`, `fileSource`, `jsonDecoder`                   |
| `@go-like/core/config/provider`     | SDK для plug  | `newSourceWatcher`, `admitConfigObject`                                                 |
| `@go-like/core/config/node`         | Привязка Node | `newNodeFileCapability`                                                                 |
| `@go-like/core/fetch`               | Socket        | `Fetch`, `newFetchClient`                                                               |
| `@go-like/core/cache`               | Socket        | `Cache`, `expiresIn`                                                                    |
| `@go-like/core/cache/memory`        | Эталон        | `newMemoryCache`                                                                        |
| `@go-like/core/store`               | Socket        | `Store`, `ifAbsent`, `ifRevision`, `StoreConflictError`                                 |
| `@go-like/core/store/provider`      | SDK для plug  | Парсеры параметров, фабрика конфликта                                                   |
| `@go-like/core/store/memory`        | Эталон        | `newMemoryStore`                                                                        |
| `@go-like/core/broker`              | Socket        | `Broker`, `newBrokerServer`, `eventBroker`                                              |
| `@go-like/core/broker/provider`     | SDK для plug  | `deliver`, `publish`                                                                    |
| `@go-like/core/broker/memory`       | Эталон        | `newMemoryBroker`                                                                       |
| `@go-like/core/job`                 | Socket        | `newScheduleServer`, `newIntervalSchedule`, `JobQueue`                                  |
| `@go-like/core/job/provider`        | SDK для plug  | `runJob`, `enqueue`, `dispatchJob`                                                      |

И `@go-like/core/server`, и `@go-like/core/client` экспортируют `middleware` и `use`. Импортируйте один как пространство имён, когда файлу нужны оба. Параметры `context`, `endpoint`, `server` и `metadata` корневой точки входа — параметры App. Импортируйте корень как пространство имён, когда эти имена сталкиваются с OpenTelemetry или с `defineService`.

Код приложения не импортирует `/provider` и `/testing`, кроме тестов и реализаций plug.

## Subpath runtime

Импортируйте тот subpath, который имеете в виду. Экспорты не зависят от условия `bun` или `node`.

- Node: `@go-like/core/node`, `@go-like/core/transport/http/node`, `@go-like/core/web/node`, `@go-like/core/config/node`, `@go-like/mdns/registry/node`, `@go-like/zookeeper/registry/node`, `@go-like/file/store/node`, `@go-like/connectrpc/node`.
- Host Bun: `@go-like/core/web/bun`.
- NATS, RabbitMQ, Redis и BullMQ следуют своим нативным клиентам на Node и Bun.

## Что этот каталог оставляет в стороне

Эталонные реализации в памяти действуют в пределах процесса. README plug — предел для lease, подтверждений, TTL и транзакций. [Провайдеры](/ru-Cyrl/reference/providers) ссылаются на эти README. [Ошибки](/reference/errors) перечисляют публичные коды. [Миграция](/ru-Cyrl/guide/migration) сопоставляет исторические спецификаторы с этой таблицей.

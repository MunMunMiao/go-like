# Справочник пакетов и провайдеров

Эта страница организована вокруг вопроса, который пытается решить приложение, а не вокруг структуры каталога `packages/`. Импортируйте из наименьшего публичного пакета, которому принадлежит контракт. Поведение, зависящее от runtime, вынесено в явный subpath. Пакеты-провайдеры не являются взаимозаменяемыми реализациями с одной универсальной гарантией.

## Как читать эту страницу

- **Контракт** — переносимый интерфейс или интерфейс, не зависящий от конкретного провайдера.
- **Провайдер** — реализация на базе памяти, файла, сетевого сервиса или нативной библиотеки.
- **Адаптер жизненного цикла** — Server-wrapper вокруг нативного ресурса, созданного приложением.
- **Доказательство** — вид опоры в репозитории: исходник/export, объявленные тесты или зафиксированный результат локальной команды. Это не превращает версию пакета в утверждение о публикации в npm или готовности к production.

Текущий инвентарь исходников содержит 43 манифеста пакетов `@go-like/*`, не помеченных как `private`, и 23 публичных source subpath; все они имеют версию `0.0.1` в этой рабочей копии. 44 workspace `examples/*` — это приватные приложения, а не публичные пакеты.

## Выбор по задаче

| Задача                                      | Начните с                                | Добавьте при необходимости                                                | go-like не владеет                                              |
| ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Открыть Web API                             | `@go-like/web`, `@go-like/core`          | `@go-like/web/node` или нативный Fetch handler фреймворка                 | Роутером, middleware фреймворка, auth, политикой ответов        |
| Вызвать внутренний сервис                   | `@go-like/client`, `@go-like/transport`  | `@go-like/transport-memory`, `@go-like/transport-http`, `@go-like/struct` | Бизнес-идемпотентностью, сгенерированным IDL, full-duplex RPC   |
| Обнаружить экземпляры сервиса               | `@go-like/registry`                      | Один Registry provider, filters, Selector                                 | Согласованностью backend lease/revision или глобальным locator  |
| Загрузить конфигурацию                      | `@go-like/config`                        | env/file/YAML или один внешний Config provider                            | Неявной глобальной конфигурацией и транзакциями ресурсов        |
| Хранить авторитетные bytes                  | `@go-like/store`                         | Memory, File, Consul, etcd или Vault provider                             | Универсальной БД/ORM или едиными гарантиями провайдеров         |
| Кешировать временные значения               | `@go-like/cache`                         | Memory или Redis provider                                                 | Authority, persistence, CAS, долговечным бизнес-состоянием      |
| Публиковать или получать bytes              | `@go-like/broker`                        | Memory, RabbitMQ или NATS                                                 | Универсальными ack/nack/term, DLQ, durable offset, exactly-once |
| Добавить типизированные event payloads      | `@go-like/event`                         | Codec, принадлежащий приложению                                           | Schema registry, replay, settlement policy                      |
| Запустить существующий scheduler или worker | `@go-like/core`                          | `@go-like/croner`, `@go-like/bullmq`, `@go-like/nats`                     | Нативными queue, processor, job policy или broker connection    |
| Добавить операции                           | `@go-like/health`, `@go-like/resilience` | Pino, Winston, OTel, Prometheus                                           | Глобальной инструментацией, auth, политикой deployment          |

## Фундаментальные пакеты

| Пакет                 | Для чего использовать                                        | Основной публичный API                                                                                                                                                                                            | Примечание о runtime и владении                                                                     |
| --------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@go-like/context`    | Явные отмена, deadline, причины и значения                   | `background`, `todo`, `withCancel`, `withCancelCause`, `withDeadline`, `withDeadlineCause`, `withTimeout`, `withTimeoutCause`, `cause`, `withoutCancel`, `withValue`, `afterFunc`, `canceled`, `deadlineExceeded` | Переносимый исходный контракт. `Context` внутри использует `AbortSignal`; это не Go ABI и не DI bag |
| `@go-like/core`       | Компоновка жизненного цикла приложения и ресурсов            | `newApp`, `server`, `registrar`, `beforeStart`, `afterStart`, `beforeStop`, `afterStop`, `startTimeout`, `stopTimeout`, `context`, `id`, `name`, `version`, `metadata`, `endpoint`, `newContext`, `fromContext`   | Переносимые структурные `Server` и `App`. Соседние stop вызываются конкурентно                      |
| `@go-like/metadata`   | Неизменяемые многозначные metadata и явное распространение   | Типы metadata и функции propagation                                                                                                                                                                               | Домены metadata Client и Server разделены; metadata не является доверенной identity                 |
| `@go-like/struct`     | Runtime-валидация Struct для типизированных endpoints и JSON | `struct`, `Infer`, `Struct`, `StructError`, `setErrorMap`                                                                                                                                                         | Текущий публичный пакет. Это runtime-валидация, а не Protobuf, IDL или generated code               |
| `@go-like/health`     | Registry проверок liveness и readiness                       | `newProbeRegistry`, `ProbeRegistry`, `Probe`, `ProbeReport`                                                                                                                                                       | Пустой liveness проходит; пустой readiness закрывается по умолчанию; timeout probe — 1 000 ms       |
| `@go-like/resilience` | Явные retry, circuit breaker и неблокирующее rate limiting   | `retry`, `exponentialBackoff`, `newCircuitBreaker`, `newTokenBucketLimiter`, `circuitOpen`                                                                                                                        | Разрешение retry объявляет caller; автоматических idempotency и фоновой limiter-задачи нет          |

## Web и внутренние вызовы

| Пакет                          | Для чего использовать                                                      | Основной публичный API                                                                                                                                                                                       | За что не отвечает                                                                         |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `@go-like/web`                 | Стандартный Web Handler и мост request Context                             | `Handler`, `ContextHandler`, `contextHandler`                                                                                                                                                                | Routes, WebSockets, SSE policy, listener, authentication                                   |
| `@go-like/web/health`          | Маршруты health Handler                                                    | `createHealthHandler`                                                                                                                                                                                        | Регистрацию probes или mounting routes фреймворка                                          |
| `@go-like/web/node`            | Node listener вокруг Fetch Handler                                         | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`                                                                                                                                                   | TLS/HTTP2 внутреннего HTTP Transport; для этого используйте `@go-like/transport-http/node` |
| `@go-like/client`              | Внутренние unary calls, discovery, selection, middleware, retries, pooling | `newClient`, `withTransport`, `withAddress`, `withDiscovery`, `withSelector`, `withFilter`, `withBlock`, `withRetry`, `middleware`, `use`, `circuitBreakerMiddleware`, `closeTimeout`, `poolSize`, `poolTtl` | Маршруты фреймворка, безопасность business replay, лимиты физических сокетов               |
| `@go-like/server`              | Internal unary Message server и route dispatch                             | `newServer`, `transport`, `address`, `advertise`, `handler`, `middleware`, `use`, `listenOption`, `rateLimitMiddleware`                                                                                      | Внешние Fetch routes и protocol-specific business authorization                            |
| `@go-like/transport`           | Transport SPI и граница Message                                            | `Transport`, `Client`, `Listener`, `Socket`, `Message`, `TransportInfo`, `Endpoint`, `endpoint`, `chain`, `serviceError`                                                                                     | Конкретный wire без выбранного provider; internal full-duplex promise отсутствует          |
| `@go-like/transport-memory`    | Внутрипроцессный unary Transport                                           | `newMemoryTransport`                                                                                                                                                                                         | Межпроцессное поведение, persistence, network fallback, TLS                                |
| `@go-like/transport-http`      | Внутренний HTTP Transport на базе Fetch                                    | `newHTTPTransport`, `executor`, `maxMessageBytes`                                                                                                                                                            | Полный переносимый listener без внедрённого `HTTPHost`; native Node TLS controls           |
| `@go-like/transport-http/node` | Нативный Node internal HTTP Transport                                      | `newNodeHTTPTransport`, `allowHTTP1`, `clientAuth`                                                                                                                                                           | Deno listener или автоматическую security policy                                           |

## Пакеты Config

| Пакет или subpath            | Для чего использовать                     | Основная функция                                                                                                       | Граница                                                                      |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@go-like/config`            | Config manager и object sources           | `newConfig`, `source`, `objectSource`, `schema`, `resolver`, `placeholderResolver`, `onReloadError`, `onTerminalError` | Immutable snapshots и принятый lifecycle watcher; сам по себе не Core Server |
| `@go-like/config/env`        | Явный источник environment record         | `envSource`                                                                                                            | Получает внедрённый record; не читает ambient runtime globals                |
| `@go-like/config/file`       | File source и JSON decoder contract       | `fileSource`, `jsonFileDecoder`                                                                                        | Требует явной file capability                                                |
| `@go-like/config/node`       | Node file capability                      | `newNodeFileCapability`                                                                                                | Runtime-specific Node subpath                                                |
| `@go-like/config/yaml`       | Декодирование YAML в ConfigObject         | `decodeYaml`                                                                                                           | Декодирование — не source watching и не schema publication                   |
| `@go-like/config-consul`     | Consul HTTP configuration source          | `consulSource`, `jsonConsulDecoder`                                                                                    | Consul blocking-query и consistency behavior                                 |
| `@go-like/config-etcd`       | Gateway configuration source для etcd     | `etcdSource`, `jsonEtcdDecoder`                                                                                        | Revision, compaction и gateway protocol behavior                             |
| `@go-like/config-kubernetes` | Один ключ Kubernetes ConfigMap или Secret | `kubernetesSource`, `jsonKubernetesDecoder`                                                                            | Resource-version/relist semantics; cross-resource transaction отсутствует    |
| `@go-like/config-vault`      | Vault KV v2 source                        | `vaultSource`                                                                                                          | Vault authentication, TLS, token policy и KV semantics                       |

Внешние Config-провайдеры используют внедрённый стандартный Fetch. Credentials и redirects имеют security behavior, зависящее от провайдера; `http` против `https` остаётся решением приложения или deployment, если провайдер явно это не запрещает.

## Пакеты Registry

| Пакет                          | Для чего использовать                                | Основная функция                                                                                                                                   | Примечание о runtime/backend                                               |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `@go-like/registry`            | Контракт, snapshot, filters и selectors              | `filterVersion`, `filterLabel`, `newRandomSelector`, `newRoundRobinSelector`, `newWeightedRoundRobinSelector`, `newP2CSelector`, `newEWMASelector` | Полные snapshots-замены; feedback выбора передаётся явно                   |
| `@go-like/registry/provider`   | Helpers автора provider и диагностика регистрации    | `providerOptions`, `notifyRegistrationError`, helpers snapshot/provider                                                                            | Provider-facing subpath, не обычный application entrypoint                 |
| `@go-like/registry-consul`     | Регистрация и discovery Consul                       | `newConsulRegistry`                                                                                                                                | Health filtering, blocking-query, TTL/critical behavior нативны для Consul |
| `@go-like/registry-etcd`       | Регистрация и discovery etcd                         | `newEtcdRegistry`                                                                                                                                  | Leases, revisions, watch/relist, compaction behavior                       |
| `@go-like/registry-kubernetes` | EndpointSlice discovery и необязательная регистрация | `newKubernetesRegistry`                                                                                                                            | Kubernetes EndpointSlice, owner references, fabricated TTL отсутствует     |
| `@go-like/registry-mdns`       | Локальное multicast discovery                        | `newMDNSRegistry`                                                                                                                                  | Root provider переносим по замыслу; UDP host находится в `/node`           |
| `@go-like/registry-mdns/node`  | Node UDP multicast capability                        | `newNodeMDNSHost`                                                                                                                                  | Явный Node runtime subpath                                                 |
| `@go-like/registry-zookeeper`  | Эфемерная регистрация и discovery ZooKeeper          | `newZookeeperRegistry`                                                                                                                             | Документированы Node.js и Bun; Deno явно не поддерживается                 |

Registry описывает доступность, а не долговечные бизнес-данные. Провайдер может сохранять последний snapshot во время восстановления временного watcher, но авторитетный пустой snapshot должен закрываться по умолчанию.

## Пакеты Store и Cache

| Пакет                      | Для чего использовать                  | Основная функция                                                                                                   | Граница                                                                                       |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `@go-like/store`           | Контракт record и options              | `expiresIn`, `ifAbsent`, `ifRevision`, `prefix`, `limit`, `cursor`, `writeOptions`, `deleteOptions`, `listOptions` | Revisions, CAS, TTL, pagination; возможности зависят от провайдера                            |
| `@go-like/store/provider`  | Helpers provider для write/delete/list | `writeOptions`, `deleteOptions`, `listOptions`, helpers snapshot и conflict                                        | Provider-facing; сам по себе не durable backend                                               |
| `@go-like/store-memory`    | Локальные Store-тесты                  | `newMemoryStore`, `clock`                                                                                          | Нет durability после перезапуска и межпроцессного состояния                                   |
| `@go-like/store-file`      | Локальный File Store                   | `newFileStore`                                                                                                     | Local state с одним владельцем; для Node host используйте `/node`                             |
| `@go-like/store-file/node` | Node file capability                   | `newNodeFileStoreHost`                                                                                             | Явный Node subpath                                                                            |
| `@go-like/store-consul`    | Consul KV Store                        | `newConsulStore`                                                                                                   | Consul sessions, сочетания TTL/CAS и uncertain mutation behavior                              |
| `@go-like/store-etcd`      | etcd KV Store                          | `newEtcdStore`                                                                                                     | Gateway, lease, revision, compaction и uncertain mutation behavior                            |
| `@go-like/store-vault`     | Vault KV v2 Store                      | `newVaultStore`                                                                                                    | Не обещает единообразную Store semantics TTL/CAS                                              |
| `@go-like/cache`           | Контракт временных values/TTL          | `expiresIn`, `putOptions`                                                                                          | Нет CAS, revision, durability или authority                                                   |
| `@go-like/cache-memory`    | Локальный process cache                | `newMemoryCache`, `clock`                                                                                          | Нет persistence; lazy expiry; подходит для тестов и локального ускорения                      |
| `@go-like/cache-redis`     | Cache на базе Redis                    | `newRedisCache`                                                                                                    | Native Redis connection, обработка credentials в URL и runtime requirements остаются видимыми |

## Пакеты Broker, событий и рабочих процессов

| Пакет или subpath                | Для чего использовать                            | Основная функция                                                               | Граница                                                              |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `@go-like/broker`                | Byte/topic Broker contract                       | `newBrokerServer`                                                              | Нет переносимых ack/nack/term, DLQ, retry или durable offset         |
| `@go-like/broker/provider`       | Provider terminal registration                   | `registerSubscriberTerminal`, `subscriberTerminal`                             | Provider-facing lifecycle bookkeeping                                |
| `@go-like/broker-memory`         | In-process broker с exact-topic                  | `newMemoryBroker`                                                              | Instance-private, broadcast, без durable settlement                  |
| `@go-like/broker-rabbitmq`       | Borrowed, confirm или recovering RabbitMQ broker | `newRabbitMqBroker`, `newConfirmRabbitMqBroker`, `newRecoveringRabbitMqBroker` | `amqplib` channel/connection и нативная settlement semantics         |
| `@go-like/event`                 | Typed codec поверх Broker                        | `eventBroker`                                                                  | Native delivery остаётся видимой; нет replay или schema registry     |
| `@go-like/nats`                  | NATS lifecycle и native broker entrypoints       | `newNatsCoreServer`, `natsCoreDrainTimeout`                                    | Core connection и semantics subscription остаются нативными          |
| `@go-like/nats/broker`           | NATS Core Broker                                 | `newNatsCoreBroker`                                                            | Native `Msg`, queue group, drain и at-most-once semantics            |
| `@go-like/nats/jetstream`        | Lifecycle ConsumerMessages JetStream             | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout`                          | Native ConsumerMessages close/stop/closed behavior                   |
| `@go-like/nats/jetstream/broker` | Typed byte Broker поверх JetStream               | `newNatsJetStreamBroker`                                                       | `JsMsg`, `PubAck`, ack/nak/term, redelivery и DLQ остаются нативными |
| `@go-like/croner`                | Lifecycle для существующих Croner jobs           | `newCronerServer`                                                              | Croner schedule, callback, overlap и passive terminal semantics      |
| `@go-like/bullmq`                | Lifecycle для существующего BullMQ Worker        | `newBullMqWorkerServer`, `bullMqWorkerShutdownTimeout`                         | Queue, Redis, processor, retry/backoff, stalled jobs и job identity  |

## Пакеты логирования и наблюдаемости

| Пакет                 | Для чего использовать                              | Основная функция                                                                                                                                                                    | За что не отвечает                                                      |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `@go-like/pino`       | Pino wrappers для request/broker и lifecycle drain | `logClient`, `logUnaryMiddleware`, `logWebHandler`, `logBroker`, `newPinoServer`, `pinoDrainTimeout`                                                                                | Создание logger, destination policy, redaction, global setup            |
| `@go-like/winston`    | Winston wrappers и shutdown lifecycle              | Logging wrappers, `newWinstonServer`                                                                                                                                                | Logger/transports и их native finish/close semantics                    |
| `@go-like/otel`       | Явные OpenTelemetry trace/metric wrappers          | `newOtelServer`, `traceClient`, `traceUnaryMiddleware`, `traceWebHandler`, `traceBroker`, `measureClient`, `measureClientMiddleware`, `measureUnaryMiddleware`, `newRequestMetrics` | Global providers, exporters, context manager, automatic instrumentation |
| `@go-like/prometheus` | Prometheus request metrics и scrape Handler        | `newRequestMetrics`, `measureClient`, `measureUnaryMiddleware`, `measureWebHandler`, `measureBroker`, `createPrometheusHandler`                                                     | Global Registry, collectors вне переданного Registry, background tasks  |

## Полный инвентарь публичных source subpath

Ниже перечислены 23 явных source subpath, объявленных текущими package manifest. Сгенерированные пакеты могут добавить export `./package.json` только с metadata; это не дополнительный пакет и не source API.

|   # | Subpath                          | Основные exports                                           | Для кого предназначен            |
| --: | -------------------------------- | ---------------------------------------------------------- | -------------------------------- |
|   1 | `@go-like/broker/provider`       | `registerSubscriberTerminal`, `subscriberTerminal`         | Авторы провайдеров               |
|   2 | `@go-like/cache/provider`        | `putOptions`                                               | Авторы провайдеров               |
|   3 | `@go-like/config/env`            | `envSource`                                                | Авторы приложений                |
|   4 | `@go-like/config/file`           | `fileSource`, `jsonFileDecoder`                            | Авторы приложений                |
|   5 | `@go-like/config/node`           | `newNodeFileCapability`                                    | Авторы Node runtime              |
|   6 | `@go-like/config/yaml`           | `decodeYaml`                                               | Авторы приложений                |
|   7 | `@go-like/core/lifecycle`        | `waitForContext`                                           | Авторы lifecycle/provider        |
|   8 | `@go-like/core/node`             | `signal`                                                   | Интеграция процесса Node/Bun     |
|   9 | `@go-like/nats/broker`           | `newNatsCoreBroker`                                        | Приложения NATS Core             |
|  10 | `@go-like/nats/jetstream`        | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout`      | Приложения JetStream             |
|  11 | `@go-like/nats/jetstream/broker` | `newNatsJetStreamBroker`                                   | Приложения JetStream Broker      |
|  12 | `@go-like/registry/provider`     | provider options и snapshot helpers                        | Авторы провайдеров               |
|  13 | `@go-like/registry-mdns/node`    | `newNodeMDNSHost`                                          | Приложения mDNS Node             |
|  14 | `@go-like/store/provider`        | write/delete/list options и snapshots                      | Авторы провайдеров               |
|  15 | `@go-like/store-file/node`       | `newNodeFileStoreHost`                                     | Приложения File Store Node       |
|  16 | `@go-like/struct/codec`          | `encodeJson`, `decodeJson`                                 | Авторы типизированных контрактов |
|  17 | `@go-like/struct/runtime`        | introspection и parsing helpers                            | Авторы runtime/provider          |
|  18 | `@go-like/transport/headers`     | константы `Go-Like-*` headers                              | Авторы Transport-провайдеров     |
|  19 | `@go-like/transport/json`        | `encodeJsonBody`, `decodeJsonBody`, `jsonContentType`      | Авторы typed/raw Transport       |
|  20 | `@go-like/transport/provider`    | Message, metadata, ServiceError codecs и errors            | Авторы провайдеров               |
|  21 | `@go-like/transport-http/node`   | `newNodeHTTPTransport`, `allowHTTP1`, `clientAuth`         | Приложения HTTP Node             |
|  22 | `@go-like/web/health`            | `createHealthHandler`                                      | Web-приложения                   |
|  23 | `@go-like/web/node`              | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout` | Приложения Web host Node         |

В текущей TypeScript-конфигурации есть устаревшие path mappings для `@go-like/otel/testing` и `@go-like/web/node/testing`, но это не текущие exports package manifest. Не документируйте их как публичные entrypoint, пока репозиторий не согласует эти mappings.

## Матрица выбора runtime

| Entry или семейство провайдеров                               | Переносимый исходник                 | Нативный Bun/Node                               | Утверждение о Deno                                | Формулировка доказательства                                            |
| ------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| Context, Core root, Health, Metadata, Resilience, Struct      | Да                                   | Нативный import не требуется                    | Заявлены отдельные runtime lanes                  | Исходный контракт; перед release проверяйте текущую выполненную matrix |
| Web root и Web health                                         | Да                                   | Host нужен отдельно                             | Стандартная Handler boundary                      | Handler переносим; Handler сам по себе не listener                     |
| Memory Transport, Memory Store, Memory Cache, Memory Broker   | Process-local source                 | Внешний сервис не нужен                         | Та же process-local semantics                     | Не distributed, не durable, не cross-process                           |
| HTTP root и Fetch-based Config/Registry/Store providers       | Внедрённый Fetch                     | Fetch выбирает runtime                          | Подтверждено исходником там, где есть lane пакета | Переносимо по source или объявленной lane, но не universal parity      |
| `/node` subpaths                                              | Нет                                  | Специфичны Node, иногда исполняются на Bun      | Deno entrypoint отсутствует                       | Явный import меняет runtime graph                                      |
| Native SDK NATS, RabbitMQ, BullMQ, Redis, Pino, Winston, OTel | Зависит от provider                  | Fixtures Node/Bun или package-specific evidence | Не выводите поддержку Deno                        | Читайте README провайдера и область E2E                                |
| ZooKeeper                                                     | README provider не поддерживает Deno | Node/Bun                                        | Явно не поддерживается                            | Не обобщайте свойства корневого Registry                               |

## Правила выбора функций

- Используйте `contextHandler` на Web-границе, когда нужен Context, а не собственный request bag фреймворка.
- Используйте `newApp` и `server(...)`, когда один процесс принимает более одного ресурса или нужно явно обозначить владение signal и shutdown.
- Используйте типизированные `endpoint(...)` и `handler(contract, fn)`, когда обе стороны должны совместно использовать runtime Struct validation. Используйте raw `handler(service, endpoint, fn)`, когда приложение владеет другим byte contract.
- Сначала используйте `withAddress(...)`, а затем Discovery. Так проще тестировать, и identity назначения остаётся явной.
- Используйте `withDiscovery(...)`, `withSelector(...)`, `withFilter(...)` и `withBlock()` только тогда, когда сервису действительно нужно добавляемое ими поведение control plane.
- Используйте `withRetry(...)` только после того, как записаны authorization повтора, максимальное общее число попыток, predicate ошибки и бизнес-идемпотентность.
- Используйте `newMemoryStore` для детерминированных тестов, а не для заявления о durability.
- Используйте `newMemoryCache` для временного ускорения, а не как источник истины для записей о приёме или платежах.
- Используйте `newBrokerServer`, чтобы подключить одну подписку к Core, а не чтобы получить универсальный queue worker или settlement API.
- Используйте `newOtelServer`, `newPinoServer`, `newWinstonServer` или Prometheus Handler только после того, как приложение создало нативный provider или registry.

## Явные исключения

Ни один пакет из текущего публичного инвентаря не следует описывать как владеющий gRPC, Protobuf, генерацией кода IDL, сгенерированными RPC-клиентами, внутренними full-duplex streams, Event Store/history/replay, универсальной authentication/authorization, ORM-поведением, глобальным service locator или cluster orchestration. Провайдер или приложение могут использовать отдельную библиотеку для одной из этих задач, но это будет за пределами текущего контракта go-like.

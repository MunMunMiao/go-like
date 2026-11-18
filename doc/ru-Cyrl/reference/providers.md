# Провайдеры

У каждого plug экосистемы свой README: параметры, нативное владение и поля ошибок. Эта страница — указатель. Концептуальные точки входа живут в `@go-like/core` и перечислены в [Пакетах](/ru-Cyrl/reference/packages).

Приложение создаёт нативный клиент и передаёт его внутрь. Plugs с общим протоколом делят один корневой клиент. Каждый socket — отдельный subpath. Пути README ниже — файлы этого репозитория.

## Телеметрия

| Plug                  | README                          | Конструкторы                                                                              |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@go-like/otel`       | `packages/otel/README.md`       | `newOtelTracerProvider`, `newOtelMeterProvider`, `newOtelLogHandler`, `newOtelPropagator` |
| `@go-like/pino`       | `packages/pino/README.md`       | `newPinoHandler` из `@go-like/pino/log`                                                   |
| `@go-like/winston`    | `packages/winston/README.md`    | `newWinstonHandler` из `@go-like/winston/log`                                             |
| `@go-like/prometheus` | `packages/prometheus/README.md` | `newPrometheusMeterProvider`, `createPrometheusHandler` из `@go-like/prometheus/metric`   |

Установите набор через `telemetry(tel)`. Руководство — [Проверки и наблюдаемость](/ru-Cyrl/guide/health-observability). Winston нуждается в формате, который понимает `Error`, перед `format.json()`.

## Реестры, конфигурация и хранилища

| Plug                  | README                          | Точки входа                              |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `@go-like/consul`     | `packages/consul/README.md`     | `.`, `./registry`, `./config`, `./store` |
| `@go-like/etcd`       | `packages/etcd/README.md`       | `.`, `./registry`, `./config`, `./store` |
| `@go-like/vault`      | `packages/vault/README.md`      | `.`, `./config`, `./store`               |
| `@go-like/kubernetes` | `packages/kubernetes/README.md` | `.`, `./registry`, `./config`            |
| `@go-like/zookeeper`  | `packages/zookeeper/README.md`  | `./registry`, `./registry/node`          |
| `@go-like/mdns`       | `packages/mdns/README.md`       | `./registry`, `./registry/node`          |
| `@go-like/yaml`       | `packages/yaml/README.md`       | `./config` (`decodeYaml`)                |
| `@go-like/file`       | `packages/file/README.md`       | `./store`, `./store/node`                |

Общие ошибки HTTP, транспорта и протокола экспортируются из корня пакета. Исходы, свойственные только Store, остаются на точке входа store. См. [Обработку ошибок](/reference/errors).

## Брокеры, кеш и задания

| Plug                | README                        | Точка входа               |
| ------------------- | ----------------------------- | ------------------------- |
| `@go-like/nats`     | `packages/nats/README.md`     | `./broker`, `./jetstream` |
| `@go-like/rabbitmq` | `packages/rabbitmq/README.md` | `./broker`                |
| `@go-like/redis`    | `packages/redis/README.md`    | `./cache`                 |
| `@go-like/bullmq`   | `packages/bullmq/README.md`   | `./job`                   |
| `@go-like/croner`   | `packages/croner/README.md`   | `./job`                   |

Руководство — [Брокер, события и задания](/ru-Cyrl/guide/broker-events).

## RPC

| Пакет                      | README                               | Точка входа                                  |
| -------------------------- | ------------------------------------ | -------------------------------------------- |
| `@go-like/connectrpc`      | `packages/connectrpc/README.md`      | `.` Fetch Handler, `./node` стандартный gRPC |
| `@go-like/protoc-gen-like` | `packages/protoc-gen-like/README.md` | Бинарный файл генератора. Runtime-socket нет |

Руководство — [Потоки](/ru-Cyrl/guide/streaming).

## Core

Транспорты, кеши, хранилища и брокеры в памяти, а также сам App — точки входа `@go-like/core`, а не plugs. README пакета индексирует эти 41 точку входа: `packages/core/README.md`.

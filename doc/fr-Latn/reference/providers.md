# Fournisseurs

Chaque plug d'écosystème a son propre README pour les options, la propriété native et les champs d'erreur. Cette page est l'index. Les entrées de concept vivent sur `@go-like/core` et sont listées dans [Paquets](/fr-Latn/reference/packages).

L'application construit le client natif et le passe. Les plugs qui partagent un protocole partagent un client racine. Chaque socket est un sous-chemin séparé. Les chemins de README ci-dessous sont des fichiers de ce dépôt.

## Télémétrie

| Plug                  | README                          | Constructeurs                                                                             |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@go-like/otel`       | `packages/otel/README.md`       | `newOtelTracerProvider`, `newOtelMeterProvider`, `newOtelLogHandler`, `newOtelPropagator` |
| `@go-like/pino`       | `packages/pino/README.md`       | `newPinoHandler` de `@go-like/pino/log`                                                   |
| `@go-like/winston`    | `packages/winston/README.md`    | `newWinstonHandler` de `@go-like/winston/log`                                             |
| `@go-like/prometheus` | `packages/prometheus/README.md` | `newPrometheusMeterProvider`, `createPrometheusHandler` de `@go-like/prometheus/metric`   |

Installez le bundle avec `telemetry(tel)`. Le guide est [Santé et observabilité](/fr-Latn/guide/health-observability). Winston a besoin d'un format conscient des `Error` devant `format.json()`.

## Registres, config et stores

| Plug                  | README                          | Entrées                                  |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `@go-like/consul`     | `packages/consul/README.md`     | `.`, `./registry`, `./config`, `./store` |
| `@go-like/etcd`       | `packages/etcd/README.md`       | `.`, `./registry`, `./config`, `./store` |
| `@go-like/vault`      | `packages/vault/README.md`      | `.`, `./config`, `./store`               |
| `@go-like/kubernetes` | `packages/kubernetes/README.md` | `.`, `./registry`, `./config`            |
| `@go-like/zookeeper`  | `packages/zookeeper/README.md`  | `./registry`, `./registry/node`          |
| `@go-like/mdns`       | `packages/mdns/README.md`       | `./registry`, `./registry/node`          |
| `@go-like/yaml`       | `packages/yaml/README.md`       | `./config` (`decodeYaml`)                |
| `@go-like/file`       | `packages/file/README.md`       | `./store`, `./store/node`                |

Les erreurs HTTP, de transport et de protocole partagées sont exportées depuis la racine du paquet. Les résultats propres au store restent sur l'entrée store. Voir [Gestion des erreurs](/reference/errors).

## Brokers, cache et jobs

| Plug                | README                        | Entrée                    |
| ------------------- | ----------------------------- | ------------------------- |
| `@go-like/nats`     | `packages/nats/README.md`     | `./broker`, `./jetstream` |
| `@go-like/rabbitmq` | `packages/rabbitmq/README.md` | `./broker`                |
| `@go-like/redis`    | `packages/redis/README.md`    | `./cache`                 |
| `@go-like/bullmq`   | `packages/bullmq/README.md`   | `./job`                   |
| `@go-like/croner`   | `packages/croner/README.md`   | `./job`                   |

Le guide est [Broker, événements et jobs](/fr-Latn/guide/broker-events).

## RPC

| Paquet                     | README                               | Entrée                                           |
| -------------------------- | ------------------------------------ | ------------------------------------------------ |
| `@go-like/connectrpc`      | `packages/connectrpc/README.md`      | `.` handler Fetch, `./node` gRPC standard        |
| `@go-like/protoc-gen-like` | `packages/protoc-gen-like/README.md` | Binaire du générateur. Pas de socket d'exécution |

Le guide est [Streaming](/fr-Latn/guide/streaming).

## Core

Les transports, caches, stores et brokers mémoire, ainsi que l'App elle-même, sont des entrées de `@go-like/core`, pas des plugs. Le README du paquet indexe ces 41 entrées : `packages/core/README.md`.

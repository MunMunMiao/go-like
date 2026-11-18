# Providers

Cada plug del ecosistema tiene su propio README para opciones, propiedad nativa y campos de error. Esta página es el índice. Las entradas de concepto viven en `@go-like/core` y están listadas en [Paquetes](/es-Latn/reference/packages).

La aplicación construye el cliente nativo y lo pasa. Los plugs que comparten un protocolo comparten un cliente raíz. Cada socket es un subpath aparte. Las rutas de README de abajo son archivos de este repositorio.

## Telemetría

| Plug                  | README                          | Constructores                                                                             |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@go-like/otel`       | `packages/otel/README.md`       | `newOtelTracerProvider`, `newOtelMeterProvider`, `newOtelLogHandler`, `newOtelPropagator` |
| `@go-like/pino`       | `packages/pino/README.md`       | `newPinoHandler` de `@go-like/pino/log`                                                   |
| `@go-like/winston`    | `packages/winston/README.md`    | `newWinstonHandler` de `@go-like/winston/log`                                             |
| `@go-like/prometheus` | `packages/prometheus/README.md` | `newPrometheusMeterProvider`, `createPrometheusHandler` de `@go-like/prometheus/metric`   |

El bundle se instala con `telemetry(tel)`. La guía es [Salud y observabilidad](/es-Latn/guide/health-observability). Winston necesita un formato que entienda `Error` delante de `format.json()`.

## Registros, configuración y stores

| Plug                  | README                          | Entradas                                 |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `@go-like/consul`     | `packages/consul/README.md`     | `.`, `./registry`, `./config`, `./store` |
| `@go-like/etcd`       | `packages/etcd/README.md`       | `.`, `./registry`, `./config`, `./store` |
| `@go-like/vault`      | `packages/vault/README.md`      | `.`, `./config`, `./store`               |
| `@go-like/kubernetes` | `packages/kubernetes/README.md` | `.`, `./registry`, `./config`            |
| `@go-like/zookeeper`  | `packages/zookeeper/README.md`  | `./registry`, `./registry/node`          |
| `@go-like/mdns`       | `packages/mdns/README.md`       | `./registry`, `./registry/node`          |
| `@go-like/yaml`       | `packages/yaml/README.md`       | `./config` (`decodeYaml`)                |
| `@go-like/file`       | `packages/file/README.md`       | `./store`, `./store/node`                |

Los errores compartidos de HTTP, transporte y protocolo se exportan desde la raíz del paquete. Los resultados que solo son del store se quedan en la entrada del store. Véase [Manejo de errores](/reference/errors).

## Brokers, caché y jobs

| Plug                | README                        | Entrada                   |
| ------------------- | ----------------------------- | ------------------------- |
| `@go-like/nats`     | `packages/nats/README.md`     | `./broker`, `./jetstream` |
| `@go-like/rabbitmq` | `packages/rabbitmq/README.md` | `./broker`                |
| `@go-like/redis`    | `packages/redis/README.md`    | `./cache`                 |
| `@go-like/bullmq`   | `packages/bullmq/README.md`   | `./job`                   |
| `@go-like/croner`   | `packages/croner/README.md`   | `./job`                   |

La guía es [Broker, eventos y jobs](/es-Latn/guide/broker-events).

## RPC

| Paquete                    | README                               | Entrada                                      |
| -------------------------- | ------------------------------------ | -------------------------------------------- |
| `@go-like/connectrpc`      | `packages/connectrpc/README.md`      | `.` handler Fetch, `./node` gRPC estándar    |
| `@go-like/protoc-gen-like` | `packages/protoc-gen-like/README.md` | Binario del generador. Sin socket de runtime |

La guía es [Streaming](/es-Latn/guide/streaming).

## Core

Los transportes, las cachés, los stores y los brokers en memoria, y la propia App, son entradas de `@go-like/core`, no plugs. El README del paquete indexa esas 41 entradas: `packages/core/README.md`.

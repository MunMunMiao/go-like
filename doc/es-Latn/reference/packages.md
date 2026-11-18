# Paquetes

El workspace contiene **20** paquetes públicos `@go-like/*`, cada uno en la versión `0.0.1` en este checkout. El workspace raíz es privado. La versión no establece disponibilidad en npm. Los 44 directorios `examples/*` son aplicaciones privadas.

Hay **75** entradas públicas: 41 en `@go-like/core` y 34 en los plugs y el generador. Un export generado `./package.json` de `dist/package.json` es metadata, no otra entrada.

`@go-like/core` no tiene dependencias de runtime de terceros. Todos los demás paquetes, salvo `@go-like/protoc-gen-like`, declaran una dependencia peer de la misma versión de core. El generador no depende de core. El comportamiento y los límites de cada plug están en su README. Esta página es el inventario.

## Los 20 paquetes

| Paquete                    | Entradas                                 | Rellena                                                          |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `@go-like/core`            | 41                                       | Sockets, mecanismos, referencias en memoria y enlaces de runtime |
| `@go-like/otel`            | `.`                                      | Tracer, meter, handler de log, propagator                        |
| `@go-like/pino`            | `./log`                                  | `LogHandler`                                                     |
| `@go-like/winston`         | `./log`                                  | `LogHandler`                                                     |
| `@go-like/prometheus`      | `./metric`                               | `MeterProvider` y un `Handler` de scrape                         |
| `@go-like/consul`          | `.`, `./registry`, `./config`, `./store` | Cliente compartido, registry, config, store                      |
| `@go-like/etcd`            | `.`, `./registry`, `./config`, `./store` | Cliente compartido, registry, config, store                      |
| `@go-like/vault`           | `.`, `./config`, `./store`               | Cliente compartido, config, store                                |
| `@go-like/kubernetes`      | `.`, `./registry`, `./config`            | Cliente compartido, registry, config                             |
| `@go-like/zookeeper`       | `./registry`, `./registry/node`          | Registry sobre una factory de cliente; factory de Node           |
| `@go-like/mdns`            | `./registry`, `./registry/node`          | Registry sobre un `MDNSHost`; host de Node                       |
| `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                                                  |
| `@go-like/nats`            | `./broker`, `./jetstream`                | Brokers de Core y de JetStream                                   |
| `@go-like/rabbitmq`        | `./broker`                               | Broker                                                           |
| `@go-like/redis`           | `./cache`                                | Caché y un `Server` del nivel de recursos                        |
| `@go-like/bullmq`          | `./job`                                  | `JobQueue` y un `Server` del nivel de recursos                   |
| `@go-like/croner`          | `./job`                                  | `Schedule`                                                       |
| `@go-like/file`            | `./store`, `./store/node`                | Store y un `Server` del nivel de recursos; host de Node          |
| `@go-like/connectrpc`      | `.`, `./node`                            | Handler Fetch; servidor y cliente gRPC de Node                   |
| `@go-like/protoc-gen-like` | `.`                                      | Plugin de Buf y `bin`. Sin socket                                |

Recuento: 41 + 4 + 8 + 6 + 10 + 6 = 75. Las entradas de plugs y del generador son las 34 que siguen a las 41 de core.

## Entradas de core

| Entrada                             | Papel          | Primeros exports                                                                             |
| ----------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `@go-like/core`                     | App            | `newApp`, `telemetry`, `resources`, `server`, `registrar`, `readyProbe`, hooks, presupuestos |
| `@go-like/core/node`                | Enlace de Node | `signal`                                                                                     |
| `@go-like/core/lifecycle`           | Socket         | `Server`, `Endpointer`, `newResourceServer`                                                  |
| `@go-like/core/context`             | Socket         | `background`, `withCancel`, `withTimeout`, `waitForContext`                                  |
| `@go-like/core/metadata`            | Mecanismo      | `newMetadata`, helpers de Context de cliente y de servidor                                   |
| `@go-like/core/struct`              | Mecanismo      | `struct`, `StructError`, `encodeJson`, `decodeJson`, `jsonCodec`                             |
| `@go-like/core/health`              | Socket         | `newProbeRegistry`                                                                           |
| `@go-like/core/resilience`          | Socket         | `retry`, `newCircuitBreaker`, `newTokenBucketLimiter`                                        |
| `@go-like/core/telemetry`           | Socket         | `newTelemetry`, `withTelemetry`, constantes de convención semántica                          |
| `@go-like/core/telemetry/provider`  | SDK de plugs   | `beginUnit`, `logCorrelation`, `resourceFromContext`                                         |
| `@go-like/core/log`                 | Socket         | `log`, `info`, `error`, `LogHandler`                                                         |
| `@go-like/core/trace`               | Socket         | `inSpan`, `newTraceContextPropagator`                                                        |
| `@go-like/core/metric`              | Socket         | `newCounter`, `newHistogram`, `newGauge`, `newUpDownCounter`                                 |
| `@go-like/core/testing`             | Pruebas        | `newTelemetryRecorder`, `<concept>Conformance`                                               |
| `@go-like/core/transport`           | Socket         | `defineService`, `serviceError`, `isServiceError`, `ServerStream`                            |
| `@go-like/core/transport/provider`  | SDK de plugs   | Factories de error de transporte, `newServerContext`                                         |
| `@go-like/core/transport/memory`    | Referencia     | `newMemoryTransport`                                                                         |
| `@go-like/core/transport/http`      | Referencia     | `newHTTPTransport`                                                                           |
| `@go-like/core/transport/http/node` | Enlace de Node | `newNodeHTTPTransport`                                                                       |
| `@go-like/core/server`              | Mecanismo      | `newServer`, `address`, `advertise`, `rateLimitMiddleware`                                   |
| `@go-like/core/client`              | Mecanismo      | `newClient`, `withEndpoint`, `withDiscovery`, `withRetry`, `circuitBreakerMiddleware`        |
| `@go-like/core/web`                 | Socket         | `Handler`, `contextHandler`, `requestContext`, `createHealthHandler`                         |
| `@go-like/core/web/node`            | Enlace de Node | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`                                   |
| `@go-like/core/web/bun`             | Enlace de Bun  | `newBunServer`, `hostname`, `port`, `bunShutdownTimeout`                                     |
| `@go-like/core/registry`            | Socket         | selectores, filtros, `newDiscoveryResolver`, `selectEndpoint`                                |
| `@go-like/core/registry/provider`   | SDK de plugs   | `newSnapshotWatcher`, `startHeartbeat`                                                       |
| `@go-like/core/registry/memory`     | Referencia     | `newMemoryRegistry`                                                                          |
| `@go-like/core/config`              | Socket         | `newConfig`, `objectSource`, `envSource`, `fileSource`, `jsonDecoder`                        |
| `@go-like/core/config/provider`     | SDK de plugs   | `newSourceWatcher`, `admitConfigObject`                                                      |
| `@go-like/core/config/node`         | Enlace de Node | `newNodeFileCapability`                                                                      |
| `@go-like/core/fetch`               | Socket         | `Fetch`, `newFetchClient`                                                                    |
| `@go-like/core/cache`               | Socket         | `Cache`, `expiresIn`                                                                         |
| `@go-like/core/cache/memory`        | Referencia     | `newMemoryCache`                                                                             |
| `@go-like/core/store`               | Socket         | `Store`, `ifAbsent`, `ifRevision`, `StoreConflictError`                                      |
| `@go-like/core/store/provider`      | SDK de plugs   | Parsers de opciones, factory de conflicto                                                    |
| `@go-like/core/store/memory`        | Referencia     | `newMemoryStore`                                                                             |
| `@go-like/core/broker`              | Socket         | `Broker`, `newBrokerServer`, `eventBroker`                                                   |
| `@go-like/core/broker/provider`     | SDK de plugs   | `deliver`, `publish`                                                                         |
| `@go-like/core/broker/memory`       | Referencia     | `newMemoryBroker`                                                                            |
| `@go-like/core/job`                 | Socket         | `newScheduleServer`, `newIntervalSchedule`, `JobQueue`                                       |
| `@go-like/core/job/provider`        | SDK de plugs   | `runJob`, `enqueue`, `dispatchJob`                                                           |

`@go-like/core/server` y `@go-like/core/client` exportan ambos `middleware` y `use`. Hay que importar uno como namespace cuando un archivo necesita los dos. Las opciones `context`, `endpoint`, `server` y `metadata` de la entrada raíz son opciones de la App. Hay que importar la raíz como namespace cuando esos nombres chocan con OpenTelemetry o con `defineService`.

El código de aplicación no importa `/provider` ni `/testing`, salvo las pruebas y las implementaciones de plugs.

## Subpaths de runtime

Hay que importar el subpath que se pretende. Los exports no son condicionales a `bun` ni a `node`.

- Node: `@go-like/core/node`, `@go-like/core/transport/http/node`, `@go-like/core/web/node`, `@go-like/core/config/node`, `@go-like/mdns/registry/node`, `@go-like/zookeeper/registry/node`, `@go-like/file/store/node`, `@go-like/connectrpc/node`.
- Host de Bun: `@go-like/core/web/bun`.
- NATS, RabbitMQ, Redis y BullMQ siguen a sus clientes nativos en Node y Bun.

## Lo que este catálogo deja fuera

Las referencias en memoria son locales al proceso. El README de un plug es el límite para leases, acuse de recibo, TTL y transacciones. [Providers](/es-Latn/reference/providers) enlaza esos README. [Errores](/reference/errors) lista los códigos públicos. [Migración](/es-Latn/guide/migration) hace corresponder los specifiers históricos con esta tabla.

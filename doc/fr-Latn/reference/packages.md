# Paquets

Le workspace contient **20** paquets `@go-like/*` publics, chacun en version `0.0.1` dans ce checkout. Le workspace racine est privé. La version n'établit pas la disponibilité sur npm. Les 44 répertoires `examples/*` sont des applications privées.

Il y a **75** entrées publiques : 41 sur `@go-like/core` et 34 sur les plugs et le générateur. Un export `./package.json` de `dist/package.json` généré est une métadonnée, pas une entrée de plus.

`@go-like/core` n'a pas de dépendance d'exécution tierce. Chaque autre paquet, sauf `@go-like/protoc-gen-like`, dépend en peer de la même version de core. Le générateur ne dépend pas de core. Le comportement et les limites des plugs sont dans le README de chaque plug. Cette page est l'inventaire.

## Les 20 paquets

| Paquet                     | Entrées                                  | Remplit                                                        |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `@go-like/core`            | 41                                       | Sockets, mécanismes, références mémoire et liaisons de runtime |
| `@go-like/otel`            | `.`                                      | Tracer, meter, handler de log, propagateur                     |
| `@go-like/pino`            | `./log`                                  | `LogHandler`                                                   |
| `@go-like/winston`         | `./log`                                  | `LogHandler`                                                   |
| `@go-like/prometheus`      | `./metric`                               | `MeterProvider` et un `Handler` de scrape                      |
| `@go-like/consul`          | `.`, `./registry`, `./config`, `./store` | Client partagé, registry, config, store                        |
| `@go-like/etcd`            | `.`, `./registry`, `./config`, `./store` | Client partagé, registry, config, store                        |
| `@go-like/vault`           | `.`, `./config`, `./store`               | Client partagé, config, store                                  |
| `@go-like/kubernetes`      | `.`, `./registry`, `./config`            | Client partagé, registry, config                               |
| `@go-like/zookeeper`       | `./registry`, `./registry/node`          | Registry au-dessus d'une factory de client ; factory Node      |
| `@go-like/mdns`            | `./registry`, `./registry/node`          | Registry au-dessus d'un `MDNSHost` ; host Node                 |
| `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                                                |
| `@go-like/nats`            | `./broker`, `./jetstream`                | Brokers core et JetStream                                      |
| `@go-like/rabbitmq`        | `./broker`                               | Broker                                                         |
| `@go-like/redis`           | `./cache`                                | Cache et un `Server` du palier ressources                      |
| `@go-like/bullmq`          | `./job`                                  | `JobQueue` et un `Server` du palier ressources                 |
| `@go-like/croner`          | `./job`                                  | `Schedule`                                                     |
| `@go-like/file`            | `./store`, `./store/node`                | Store et un `Server` du palier ressources ; host Node          |
| `@go-like/connectrpc`      | `.`, `./node`                            | Handler Fetch ; serveur et client gRPC Node                    |
| `@go-like/protoc-gen-like` | `.`                                      | Plugin Buf et `bin`. Pas de socket                             |

Décompte : 41 + 4 + 8 + 6 + 10 + 6 = 75. Les entrées des plugs et du générateur sont les 34 après les 41 de core.

## Entrées de core

| Entrée                              | Rôle         | Premiers exports                                                                        |
| ----------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `@go-like/core`                     | App          | `newApp`, `telemetry`, `resources`, `server`, `registrar`, `readyProbe`, hooks, budgets |
| `@go-like/core/node`                | liaison Node | `signal`                                                                                |
| `@go-like/core/lifecycle`           | socket       | `Server`, `Endpointer`, `newResourceServer`                                             |
| `@go-like/core/context`             | socket       | `background`, `withCancel`, `withTimeout`, `waitForContext`                             |
| `@go-like/core/metadata`            | mécanisme    | `newMetadata`, aides de Context client et serveur                                       |
| `@go-like/core/struct`              | mécanisme    | `struct`, `StructError`, `encodeJson`, `decodeJson`, `jsonCodec`                        |
| `@go-like/core/health`              | socket       | `newProbeRegistry`                                                                      |
| `@go-like/core/resilience`          | socket       | `retry`, `newCircuitBreaker`, `newTokenBucketLimiter`                                   |
| `@go-like/core/telemetry`           | socket       | `newTelemetry`, `withTelemetry`, constantes de convention sémantique                    |
| `@go-like/core/telemetry/provider`  | SDK de plug  | `beginUnit`, `logCorrelation`, `resourceFromContext`                                    |
| `@go-like/core/log`                 | socket       | `log`, `info`, `error`, `LogHandler`                                                    |
| `@go-like/core/trace`               | socket       | `inSpan`, `newTraceContextPropagator`                                                   |
| `@go-like/core/metric`              | socket       | `newCounter`, `newHistogram`, `newGauge`, `newUpDownCounter`                            |
| `@go-like/core/testing`             | tests        | `newTelemetryRecorder`, `<concept>Conformance`                                          |
| `@go-like/core/transport`           | socket       | `defineService`, `serviceError`, `isServiceError`, `ServerStream`                       |
| `@go-like/core/transport/provider`  | SDK de plug  | factories d'erreur de transport, `newServerContext`                                     |
| `@go-like/core/transport/memory`    | référence    | `newMemoryTransport`                                                                    |
| `@go-like/core/transport/http`      | référence    | `newHTTPTransport`                                                                      |
| `@go-like/core/transport/http/node` | liaison Node | `newNodeHTTPTransport`                                                                  |
| `@go-like/core/server`              | mécanisme    | `newServer`, `address`, `advertise`, `rateLimitMiddleware`                              |
| `@go-like/core/client`              | mécanisme    | `newClient`, `withEndpoint`, `withDiscovery`, `withRetry`, `circuitBreakerMiddleware`   |
| `@go-like/core/web`                 | socket       | `Handler`, `contextHandler`, `requestContext`, `createHealthHandler`                    |
| `@go-like/core/web/node`            | liaison Node | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`                              |
| `@go-like/core/web/bun`             | liaison Bun  | `newBunServer`, `hostname`, `port`, `bunShutdownTimeout`                                |
| `@go-like/core/registry`            | socket       | sélecteurs, filtres, `newDiscoveryResolver`, `selectEndpoint`                           |
| `@go-like/core/registry/provider`   | SDK de plug  | `newSnapshotWatcher`, `startHeartbeat`                                                  |
| `@go-like/core/registry/memory`     | référence    | `newMemoryRegistry`                                                                     |
| `@go-like/core/config`              | socket       | `newConfig`, `objectSource`, `envSource`, `fileSource`, `jsonDecoder`                   |
| `@go-like/core/config/provider`     | SDK de plug  | `newSourceWatcher`, `admitConfigObject`                                                 |
| `@go-like/core/config/node`         | liaison Node | `newNodeFileCapability`                                                                 |
| `@go-like/core/fetch`               | socket       | `Fetch`, `newFetchClient`                                                               |
| `@go-like/core/cache`               | socket       | `Cache`, `expiresIn`                                                                    |
| `@go-like/core/cache/memory`        | référence    | `newMemoryCache`                                                                        |
| `@go-like/core/store`               | socket       | `Store`, `ifAbsent`, `ifRevision`, `StoreConflictError`                                 |
| `@go-like/core/store/provider`      | SDK de plug  | parseurs d'options, factory de conflit                                                  |
| `@go-like/core/store/memory`        | référence    | `newMemoryStore`                                                                        |
| `@go-like/core/broker`              | socket       | `Broker`, `newBrokerServer`, `eventBroker`                                              |
| `@go-like/core/broker/provider`     | SDK de plug  | `deliver`, `publish`                                                                    |
| `@go-like/core/broker/memory`       | référence    | `newMemoryBroker`                                                                       |
| `@go-like/core/job`                 | socket       | `newScheduleServer`, `newIntervalSchedule`, `JobQueue`                                  |
| `@go-like/core/job/provider`        | SDK de plug  | `runJob`, `enqueue`, `dispatchJob`                                                      |

`@go-like/core/server` et `@go-like/core/client` exportent tous deux `middleware` et `use`. Importez-en un comme espace de noms lorsqu'un fichier a besoin des deux. Les options `context`, `endpoint`, `server` et `metadata` de l'entrée racine sont des options d'App. Importez la racine comme espace de noms lorsque ces noms entrent en collision avec OpenTelemetry ou avec `defineService`.

Le code applicatif n'importe pas `/provider` ni `/testing`, sauf les tests et les implémentations de plugs.

## Sous-chemins de runtime

Importez le sous-chemin que vous visez. Les exports ne sont pas conditionnels à `bun` ou `node`.

- Node : `@go-like/core/node`, `@go-like/core/transport/http/node`, `@go-like/core/web/node`, `@go-like/core/config/node`, `@go-like/mdns/registry/node`, `@go-like/zookeeper/registry/node`, `@go-like/file/store/node`, `@go-like/connectrpc/node`.
- Host Bun : `@go-like/core/web/bun`.
- NATS, RabbitMQ, Redis et BullMQ suivent leurs clients natifs sur Node et Bun.

## Ce que ce catalogue laisse de côté

Les références mémoire sont locales au processus. Le README d'un plug est la limite pour les leases, l'acknowledgement, le TTL et les transactions. [Fournisseurs](/fr-Latn/reference/providers) lie ces README. [Erreurs](/reference/errors) liste les codes publics. [Migration](/fr-Latn/guide/migration) projette les spécificateurs historiques sur ce tableau.

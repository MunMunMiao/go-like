# Конфигурация, реестр, хранилище и кеш

Эти четыре контракта отвечают на разные вопросы. Общий клиент экосистемы не сливает контракты.

| Область  | Вопрос                                              | Socket                              | Время жизни                        |
| -------- | --------------------------------------------------- | ----------------------------------- | ---------------------------------- |
| Config   | Какой снимок должен использовать этот процесс?      | `ConfigSource`, `ConfigDecoder`     | Процесс или развёртывание          |
| Registry | Какие экземпляры достижимы сейчас?                  | `Registrar`, `Discovery`, `Watcher` | Эфемерная плоскость управления     |
| Store    | Какая запись существует по этому ключу и ревизии?   | `Store`                             | Бизнес- или операционное состояние |
| Cache    | Можно ли заново вычислить это одноразовое значение? | `Cache`                             | Одноразовое                        |

Сопоставляйте коды провайдера с [Обработкой ошибок](/reference/errors), прежде чем повторять неудачную мутацию.

## Config

`@go-like/core/config` сливает источники в неизменяемую публикацию. `schema(...)` проверяет эту публикацию. `config.scan(ctx, schema)` — отдельный вызов: он и проверяет, и типизирует результат. Передайте схему в оба места.

```ts
import { background } from "@go-like/core/context"
import {
  envSource,
  fileSource,
  jsonDecoder,
  newConfig,
  objectSource,
  schema,
  source
} from "@go-like/core/config"
import { struct } from "@go-like/core/struct"

const settings = struct.object({
  service: struct.object({
    name: struct.string(),
    port: struct.number()
  })
})

const config = newConfig(
  source(objectSource("defaults", { service: { name: "appointments", port: 3000 } })),
  schema(settings)
)

await config.load(background())
const loaded = await config.scan(background(), settings)
await config.close(background())
void fileSource
void jsonDecoder
void envSource
void loaded
```

`envSource` читает запись, которую вы передаёте. Сам по себе он не читает `process.env`. `fileSource` вместе с `jsonDecoder` читает JSON через `FileCapability`. `newNodeFileCapability` из `@go-like/core/config/node` — привязка Node. `decodeYaml` из `@go-like/yaml/config` — YAML-`ConfigDecoder`. Это отдельный пакет, потому что он зависит от `js-yaml`.

`resolver` и `placeholderResolver` преобразуют слитый объект до публикации. `onReloadError` наблюдает фоновую перезагрузку, которая сохранила последний принятый снимок. `onTerminalError` наблюдает первый невосстановимый сбой наблюдателя. `value(key)` и `watch` читают публикацию. Config — это не `Server`. Закройте его из `afterStop` либо загрузите в последовательности запуска, описанной в [Проверках и наблюдаемости](/ru-Cyrl/guide/health-observability), до `newApp`.

Сбой перезагрузки может сохранить последний принятый снимок. Конечный сбой наблюдателя — другое событие. Имена источников — логические идентичности.

### Источники экосистем

Каждый из этих plugs экспортирует один клиент из корня пакета и источник из точки входа socket. Передавайте один и тот же клиент в каждый socket, который используете.

| Корневой клиент                                | Точка входа Config           | Источник                            |
| ---------------------------------------------- | ---------------------------- | ----------------------------------- |
| `newConsulClient` из `@go-like/consul`         | `@go-like/consul/config`     | `consulSource(client, options)`     |
| `newEtcdClient` из `@go-like/etcd`             | `@go-like/etcd/config`       | `etcdSource(client, options)`       |
| `newVaultClient` из `@go-like/vault`           | `@go-like/vault/config`      | `vaultSource(client, options)`      |
| `newKubernetesClient` из `@go-like/kubernetes` | `@go-like/kubernetes/config` | `kubernetesSource(client, options)` |

Клиент принимает явный `fetch`. Это отличается от `@go-like/core/transport/http`, который по умолчанию берёт `globalThis.fetch`. Сбои HTTP, транспорта и протокола делят одно семейство ошибок в корне пакета. Поле `operation` говорит, какой socket выдал вызов. Восстановление наблюдения смотрите в README plug: блокирующие запросы Consul, compaction etcd, повторный list Kubernetes и Vault KV v2 — не один и тот же механизм.

`@go-like/core/fetch` поставляет `Fetch`, `newFetchClient` и помощник статуса, которым пользуются авторы plug. Код приложения, который только загружает конфигурацию, может остаться на конструкторе источника.

## Registry и discovery

`@go-like/core/registry` — это socket и механизм внутри процесса: `filterVersion`, `filterLabel`, пять selectors, `snapshotServiceInstance`, `selectEndpoint` и `newDiscoveryResolver`. `@go-like/core/registry/memory` — это `newMemoryRegistry`. `@go-like/core/registry/provider` — набор для автора plug (`newSnapshotWatcher`, `newIdentityLocks`, `startHeartbeat`).

| Точка входа plug                   | Конструктор                              | Примечания                                              |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `@go-like/consul/registry`         | `newConsulRegistry(client, options)`     | Тот же `ConsulClient`, что у config и store.            |
| `@go-like/etcd/registry`           | `newEtcdRegistry(client, options)`       | Lease и транзакция остаются на etcd.                    |
| `@go-like/kubernetes/registry`     | `newKubernetesRegistry(client, options)` | Идентичность EndpointSlice и RBAC остаются на кластере. |
| `@go-like/zookeeper/registry`      | `newZookeeperRegistry(options)`          | Переносимо поверх `ZookeeperClientFactory`.             |
| `@go-like/zookeeper/registry/node` | `newNodeZookeeperClientFactory()`        | Импортирует `node-zookeeper-client`.                    |
| `@go-like/mdns/registry`           | `newMDNSRegistry(options)`               | Переносимо поверх внедрённого `MDNSHost`.               |
| `@go-like/mdns/registry/node`      | `newNodeMDNSHost`                        | Использует `node:dgram`.                                |

Наблюдатель выдаёт полные замещающие снимки. `GO_LIKE_WATCHER_OVERFLOW` означает, что события были отброшены; соберите состояние заново из полного снимка. `GO_LIKE_NO_AVAILABLE_ENDPOINT` означает, что у текущего снимка после filters некуда отправить вызов.

`registrar(registry)` на `newApp` регистрирует endpoint яруса серверов после их подготовки и снимает регистрацию при stop. Ресурсы не регистрируются. `registrarTimeout` по умолчанию равен 10 секундам.

## Store

`@go-like/core/store` — socket байтовых записей: `get`, `put`, `delete` и `list`, с `ifAbsent`, `ifRevision`, `prefix`, `limit`, `cursor` и `expiresIn`. Невыполненное условие — это `GO_LIKE_STORE_CONFLICT`. Прочитайте текущую запись и решите снова. Ревизии непрозрачны. `@go-like/core/store/memory` — это `newMemoryStore`, только в пределах процесса.

| Plug                       | Точка входа                        | Роль                                                                                               |
| -------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@go-like/consul/store`    | `newConsulStore(client, options?)` | KV под изолированным корнем. Неясное обратное чтение и сочетание TTL с CAS имеют собственные коды. |
| `@go-like/etcd/store`      | `newEtcdStore(client)`             | Ревизии, compaction, lease. `GO_LIKE_ETCD_STORE_CLEANUP` означает, что мутация зафиксирована.      |
| `@go-like/vault/store`     | `newVaultStore(client, options)`   | KV v2. Курсор list действует в пределах процесса.                                                  |
| `@go-like/file/store`      | `newFileStore(host, directory)`    | Переносимо поверх `FileStoreHost`. Также `Server` яруса ресурсов.                                  |
| `@go-like/file/store/node` | `newNodeFileStoreHost`             | Node-host каталога. Store также является `Server` яруса ресурсов.                                  |

Хранилища Consul, etcd и Vault используют общие корневые ошибки для сбоев HTTP, транспорта и протокола. Исходы только Store (мутация с неясным исходом, compaction, потеря lease, очистка, неподдерживаемое сочетание флагов, курсор снимка) остаются на точке входа store.

Ошибки порчи, блокировки и состояния файлового хранилища остаются на `@go-like/file/store`. Устаревшая блокировка не даёт права её удалить. Сбой контрольной суммы не даёт права перезаписать снимок.

## Cache

`@go-like/core/cache` — это `get`, `put` и `delete` байтов, плюс `expiresIn`. Отсутствующий или истёкший ключ — `null`. `@go-like/core/cache/memory` — это `newMemoryCache`. Это не `Server`, и процесс он не переживает.

`@go-like/redis/cache` экспортирует `newRedisCache`. Возвращённый объект — `Cache` и `Server` яруса ресурсов: `start` завершается, когда клиент пригоден к использованию, а `stop` закрывает его. Поместите его в `resources(...)`. `GO_LIKE_CACHE_REDIS_OPERATION` и `GO_LIKE_CACHE_REDIS_PROTOCOL` — публичные коды. Сбой кеша — повод обратиться к авторитетному хранилищу, а не повод повторить бизнес-запись.

## Выбор plug

- Одна экосистема, несколько socket: один корневой клиент, один subpath на socket.
- Тесты и примеры в одном процессе: точки входа `memory` в core.
- Файлы на диске: `@go-like/file`, а не subpath core.
- YAML: `@go-like/yaml/config`.
- Всё, что должно быть готово до того, как серверы примут работу, и что реализует `Server`: `resources(...)`.

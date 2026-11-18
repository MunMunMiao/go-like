# Configuración, registro, almacenamiento y caché

Estos cuatro contratos responden preguntas distintas. Un cliente de ecosistema compartido no fusiona los contratos.

| Dominio  | Pregunta                                           | Socket                              | Tiempo de vida                |
| -------- | -------------------------------------------------- | ----------------------------------- | ----------------------------- |
| Config   | ¿Qué instantánea debe usar este proceso?           | `ConfigSource`, `ConfigDecoder`     | Proceso o despliegue          |
| Registry | ¿Qué instancias son alcanzables ahora?             | `Registrar`, `Discovery`, `Watcher` | Plano de control efímero      |
| Store    | ¿Qué registro existe en esta clave y revisión?     | `Store`                             | Estado de negocio u operativo |
| Cache    | ¿Se puede volver a calcular este valor desechable? | `Cache`                             | Desechable                    |

Hay que casar los códigos del proveedor con [Manejo de errores](/reference/errors) antes de repetir una mutación fallida.

## Config

`@go-like/core/config` fusiona fuentes en una publicación inmutable. `schema(...)` valida esa publicación. `config.scan(ctx, schema)` es una llamada aparte: comprueba y además tipa el resultado. Hay que pasar el schema a las dos.

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

`envSource` lee el registro que se le pasa. No lee `process.env` por sí solo. `fileSource` más `jsonDecoder` lee JSON a través de una `FileCapability`. `newNodeFileCapability` de `@go-like/core/config/node` es el enlace de Node. `decodeYaml` de `@go-like/yaml/config` es el `ConfigDecoder` de YAML. Es un paquete aparte porque depende de `js-yaml`.

`resolver` y `placeholderResolver` transforman el objeto fusionado antes de la publicación. `onReloadError` observa una recarga en segundo plano que conservó la última instantánea aceptada. `onTerminalError` observa el primer fallo irrecuperable del watcher. `value(key)` y `watch` leen la publicación. Config no es un `Server`. Hay que cerrarlo desde `afterStop`, o cargarlo en la secuencia de arranque que describe [Salud y observabilidad](/es-Latn/guide/health-observability) antes de `newApp`.

Un fallo de recarga puede conservar la última instantánea aceptada. Un fallo terminal del watcher es un evento distinto. Los nombres de fuente son identidades lógicas.

### Fuentes del ecosistema

Cada uno de estos plugs exporta un cliente desde la raíz del paquete y una fuente desde la entrada del socket. Hay que pasar el mismo cliente a cada socket que se use.

| Cliente raíz                                   | Entrada de Config            | Fuente                              |
| ---------------------------------------------- | ---------------------------- | ----------------------------------- |
| `newConsulClient` de `@go-like/consul`         | `@go-like/consul/config`     | `consulSource(client, options)`     |
| `newEtcdClient` de `@go-like/etcd`             | `@go-like/etcd/config`       | `etcdSource(client, options)`       |
| `newVaultClient` de `@go-like/vault`           | `@go-like/vault/config`      | `vaultSource(client, options)`      |
| `newKubernetesClient` de `@go-like/kubernetes` | `@go-like/kubernetes/config` | `kubernetesSource(client, options)` |

El cliente recibe un `fetch` explícito. Eso difiere de `@go-like/core/transport/http`, que usa por defecto `globalThis.fetch`. Los fallos de HTTP, de transporte y de protocolo comparten una familia de errores en la raíz del paquete. El campo `operation` dice qué socket emitió la llamada. El README del plug describe la recuperación del watch: las blocking queries de Consul, la compactación de etcd, el relist de Kubernetes y KV v2 de Vault no son el mismo mecanismo.

`@go-like/core/fetch` aporta `Fetch`, `newFetchClient` y el helper de estado que usan los autores de plugs. El código de aplicación que solo carga configuración puede quedarse en el constructor de la fuente.

## Registro y descubrimiento

`@go-like/core/registry` es el socket y la maquinaria en proceso: `filterVersion`, `filterLabel`, los cinco selectores, `snapshotServiceInstance`, `selectEndpoint` y `newDiscoveryResolver`. `@go-like/core/registry/memory` es `newMemoryRegistry`. `@go-like/core/registry/provider` es el kit para autores de plugs (`newSnapshotWatcher`, `newIdentityLocks`, `startHeartbeat`).

| Entrada del plug                   | Constructor                              | Notas                                                            |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `@go-like/consul/registry`         | `newConsulRegistry(client, options)`     | El mismo `ConsulClient` que config y store.                      |
| `@go-like/etcd/registry`           | `newEtcdRegistry(client, options)`       | El lease y la transacción se quedan en etcd.                     |
| `@go-like/kubernetes/registry`     | `newKubernetesRegistry(client, options)` | La identidad de EndpointSlice y el RBAC se quedan en el clúster. |
| `@go-like/zookeeper/registry`      | `newZookeeperRegistry(options)`          | Portable sobre `ZookeeperClientFactory`.                         |
| `@go-like/zookeeper/registry/node` | `newNodeZookeeperClientFactory()`        | Importa `node-zookeeper-client`.                                 |
| `@go-like/mdns/registry`           | `newMDNSRegistry(options)`               | Portable sobre un `MDNSHost` inyectado.                          |
| `@go-like/mdns/registry/node`      | `newNodeMDNSHost`                        | Usa `node:dgram`.                                                |

Un watcher produce instantáneas de reemplazo completo. `GO_LIKE_WATCHER_OVERFLOW` significa que se descartaron eventos; hay que reconstruir desde una instantánea completa. `GO_LIKE_NO_AVAILABLE_ENDPOINT` significa que la instantánea actual, después de los filtros, no tiene adónde enviar la llamada.

`registrar(registry)` en `newApp` registra los endpoints del nivel de servidores después de prepararlos y los da de baja en la parada. Los recursos no se registran. `registrarTimeout` vale 10 segundos por defecto.

## Store

`@go-like/core/store` es el socket de registros de bytes: `get`, `put`, `delete` y `list`, con `ifAbsent`, `ifRevision`, `prefix`, `limit`, `cursor` y `expiresIn`. Una condición que no se cumple es `GO_LIKE_STORE_CONFLICT`. Hay que leer el registro actual y decidir de nuevo. Las revisiones son opacas. `@go-like/core/store/memory` es `newMemoryStore`, solo local al proceso.

| Plug                       | Entrada                            | Papel                                                                                                 |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@go-like/consul/store`    | `newConsulStore(client, options?)` | KV bajo una raíz aislada. La relectura incierta y la combinación TTL más CAS tienen códigos propios.  |
| `@go-like/etcd/store`      | `newEtcdStore(client)`             | Revisiones, compactación, leases. `GO_LIKE_ETCD_STORE_CLEANUP` significa que la mutación se confirmó. |
| `@go-like/vault/store`     | `newVaultStore(client, options)`   | KV v2. El cursor de listado es local al proceso.                                                      |
| `@go-like/file/store`      | `newFileStore(host, directory)`    | Portable sobre `FileStoreHost`. También es un `Server` del nivel de recursos.                         |
| `@go-like/file/store/node` | `newNodeFileStoreHost`             | Host de directorio de Node. El store también es un `Server` del nivel de recursos.                    |

Los stores de Consul, etcd y Vault usan los errores compartidos de la raíz para fallos de HTTP, transporte y protocolo. Los resultados que solo son del store (mutación incierta, compactación, pérdida de lease, limpieza, combinación de flags no admitida, cursor de instantánea) se quedan en la entrada del store.

Los errores de corrupción, de lock y de estado del store de archivos se quedan en `@go-like/file/store`. Un lock obsoleto no es autoridad para borrarlo. Un fallo de checksum no es autoridad para sobrescribir la instantánea.

## Caché

`@go-like/core/cache` es `get`, `put` y `delete` de bytes, más `expiresIn`. Una clave ausente o expirada es `null`. `@go-like/core/cache/memory` es `newMemoryCache`. No es un `Server` y no sobrevive al proceso.

`@go-like/redis/cache` exporta `newRedisCache`. El objeto devuelto es un `Cache` y un `Server` del nivel de recursos: `start` se resuelve cuando el cliente se puede usar, y `stop` lo cierra. Hay que ponerlo en `resources(...)`. `GO_LIKE_CACHE_REDIS_OPERATION` y `GO_LIKE_CACHE_REDIS_PROTOCOL` son los códigos públicos. Un fallo de caché es un motivo para usar el store autoritativo, no un motivo para reintentar una escritura de negocio.

## Elegir un plug

- Un ecosistema, varios sockets: un cliente raíz, un subpath por socket.
- Pruebas y ejemplos de un solo proceso: las entradas `memory` de core.
- Archivos en disco: `@go-like/file`, no un subpath de core.
- YAML: `@go-like/yaml/config`.
- Cualquier cosa que deba estar en pie antes de que los servidores acepten trabajo, y que implemente `Server`: `resources(...)`.

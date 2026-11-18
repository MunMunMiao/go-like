# Configuration, registre, Store et cache

Ces quatre contrats répondent à des questions différentes. Un client d'écosystème partagé ne fusionne pas les contrats.

| Domaine  | Question                                                   | Socket                              | Durée de vie                |
| -------- | ---------------------------------------------------------- | ----------------------------------- | --------------------------- |
| Config   | Quel instantané ce processus doit-il utiliser ?            | `ConfigSource`, `ConfigDecoder`     | Processus ou déploiement    |
| Registry | Quelles instances sont joignables maintenant ?             | `Registrar`, `Discovery`, `Watcher` | Plan de contrôle éphémère   |
| Store    | Quel enregistrement existe à cette clé et cette révision ? | `Store`                             | État métier ou opérationnel |
| Cache    | Cette valeur jetable peut-elle être recalculée ?           | `Cache`                             | Jetable                     |

Appariez les codes de fournisseur avec [Gestion des erreurs](/reference/errors) avant de rejouer une mutation échouée.

## Config

`@go-like/core/config` fusionne les sources en une publication immuable. `schema(...)` valide cette publication. `config.scan(ctx, schema)` est un appel séparé : il contrôle et type le résultat. Passez le schéma aux deux.

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

`envSource` lit l'enregistrement que vous passez. Il ne lit pas `process.env` de lui-même. `fileSource` plus `jsonDecoder` lit du JSON à travers une `FileCapability`. `newNodeFileCapability` de `@go-like/core/config/node` est la liaison Node. `decodeYaml` de `@go-like/yaml/config` est le `ConfigDecoder` YAML. C'est un paquet séparé parce qu'il dépend de `js-yaml`.

`resolver` et `placeholderResolver` transforment l'objet fusionné avant la publication. `onReloadError` observe un rechargement d'arrière-plan qui a conservé le dernier instantané accepté. `onTerminalError` observe le premier échec de watcher irrécupérable. `value(key)` et `watch` lisent la publication. Config n'est pas un `Server`. Fermez-le depuis `afterStop`, ou chargez-le dans la séquence de bootstrap décrite dans [Santé et observabilité](/fr-Latn/guide/health-observability) avant `newApp`.

Un échec de rechargement peut conserver le dernier instantané accepté. Un échec terminal de watcher est un événement différent. Les noms de source sont des identités logiques.

### Sources d'écosystème

Chacun de ces plugs exporte un client depuis la racine du paquet et une source depuis l'entrée du socket. Passez le même client à chaque socket que vous utilisez.

| Client racine                                  | Entrée Config                | Source                              |
| ---------------------------------------------- | ---------------------------- | ----------------------------------- |
| `newConsulClient` de `@go-like/consul`         | `@go-like/consul/config`     | `consulSource(client, options)`     |
| `newEtcdClient` de `@go-like/etcd`             | `@go-like/etcd/config`       | `etcdSource(client, options)`       |
| `newVaultClient` de `@go-like/vault`           | `@go-like/vault/config`      | `vaultSource(client, options)`      |
| `newKubernetesClient` de `@go-like/kubernetes` | `@go-like/kubernetes/config` | `kubernetesSource(client, options)` |

Le client prend un `fetch` explicite. Cela diffère de `@go-like/core/transport/http`, qui utilise `globalThis.fetch` par défaut. Les échecs HTTP, de transport et de protocole partagent une famille d'erreurs sur la racine du paquet. Le champ `operation` indique quel socket a émis l'appel. Voir le README du plug pour la reprise du watch : les requêtes bloquantes Consul, la compaction etcd, le relist Kubernetes et Vault KV v2 ne sont pas le même mécanisme.

`@go-like/core/fetch` fournit `Fetch`, `newFetchClient` et l'aide de statut utilisés par les auteurs de plugs. Le code applicatif qui ne fait que charger la configuration peut rester sur le constructeur de source.

## Registry et découverte

`@go-like/core/registry` est le socket et la machinerie dans le processus : `filterVersion`, `filterLabel`, les cinq sélecteurs, `snapshotServiceInstance`, `selectEndpoint` et `newDiscoveryResolver`. `@go-like/core/registry/memory` est `newMemoryRegistry`. `@go-like/core/registry/provider` est le kit pour auteurs de plugs (`newSnapshotWatcher`, `newIdentityLocks`, `startHeartbeat`).

| Entrée du plug                     | Constructeur                             | Notes                                                       |
| ---------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `@go-like/consul/registry`         | `newConsulRegistry(client, options)`     | Même `ConsulClient` que config et store.                    |
| `@go-like/etcd/registry`           | `newEtcdRegistry(client, options)`       | Le lease et la transaction restent sur etcd.                |
| `@go-like/kubernetes/registry`     | `newKubernetesRegistry(client, options)` | L'identité EndpointSlice et le RBAC restent sur le cluster. |
| `@go-like/zookeeper/registry`      | `newZookeeperRegistry(options)`          | Portable au-dessus de `ZookeeperClientFactory`.             |
| `@go-like/zookeeper/registry/node` | `newNodeZookeeperClientFactory()`        | Importe `node-zookeeper-client`.                            |
| `@go-like/mdns/registry`           | `newMDNSRegistry(options)`               | Portable au-dessus d'un `MDNSHost` injecté.                 |
| `@go-like/mdns/registry/node`      | `newNodeMDNSHost`                        | Utilise `node:dgram`.                                       |

Un watcher produit des instantanés de remplacement complet. `GO_LIKE_WATCHER_OVERFLOW` signifie que des événements ont été abandonnés ; reconstruisez à partir d'un instantané complet. `GO_LIKE_NO_AVAILABLE_ENDPOINT` signifie que l'instantané courant, après filtres, n'a nulle part où envoyer l'appel.

`registrar(registry)` sur `newApp` enregistre les endpoints du palier serveurs après leur préparation et les désenregistre à l'arrêt. Les ressources ne sont pas enregistrées. `registrarTimeout` vaut 10 secondes par défaut.

## Store

`@go-like/core/store` est le socket d'enregistrements d'octets : `get`, `put`, `delete` et `list`, avec `ifAbsent`, `ifRevision`, `prefix`, `limit`, `cursor` et `expiresIn`. Une condition manquée est `GO_LIKE_STORE_CONFLICT`. Relisez l'enregistrement courant et décidez à nouveau. Les révisions sont opaques. `@go-like/core/store/memory` est `newMemoryStore`, local au processus seulement.

| Plug                       | Entrée                             | Rôle                                                                                                       |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@go-like/consul/store`    | `newConsulStore(client, options?)` | KV sous une racine isolée. La relecture incertaine et la combinaison TTL plus CAS ont leurs propres codes. |
| `@go-like/etcd/store`      | `newEtcdStore(client)`             | Révisions, compaction, leases. `GO_LIKE_ETCD_STORE_CLEANUP` signifie que la mutation a été commise.        |
| `@go-like/vault/store`     | `newVaultStore(client, options)`   | KV v2. Le curseur de liste est local au processus.                                                         |
| `@go-like/file/store`      | `newFileStore(host, directory)`    | Portable au-dessus de `FileStoreHost`. Aussi un `Server` du palier ressources.                             |
| `@go-like/file/store/node` | `newNodeFileStoreHost`             | Host de répertoire Node. Le store est aussi un `Server` du palier ressources.                              |

Les stores Consul, etcd et Vault utilisent les erreurs racine partagées pour les échecs HTTP, de transport et de protocole. Les résultats propres au store (mutation incertaine, compaction, perte de lease, nettoyage, combinaison de drapeaux non prise en charge, curseur d'instantané) restent sur l'entrée store.

La corruption, le verrou et les erreurs d'état du store fichier restent sur `@go-like/file/store`. Un verrou périmé n'est pas une autorité pour le supprimer. Un échec de somme de contrôle n'est pas une autorité pour écraser l'instantané.

## Cache

`@go-like/core/cache` est `get`, `put`, `delete` d'octets, plus `expiresIn`. Une clé absente ou expirée est `null`. `@go-like/core/cache/memory` est `newMemoryCache`. Ce n'est pas un `Server` et il ne survit pas au processus.

`@go-like/redis/cache` exporte `newRedisCache`. L'objet renvoyé est un `Cache` et un `Server` du palier ressources : `start` se résout lorsque le client est utilisable, et `stop` le ferme. Placez-le dans `resources(...)`. `GO_LIKE_CACHE_REDIS_OPERATION` et `GO_LIKE_CACHE_REDIS_PROTOCOL` sont les codes publics. Un échec de cache est une raison d'utiliser le store faisant autorité, pas une raison de réessayer une écriture métier.

## Choisir un plug

- Un écosystème, plusieurs sockets : un client racine, un sous-chemin par socket.
- Tests et exemples à processus unique : les entrées `memory` de core.
- Fichiers sur disque : `@go-like/file`, pas un sous-chemin de core.
- YAML : `@go-like/yaml/config`.
- Tout ce qui doit être prêt avant que les serveurs acceptent du travail, et qui implémente `Server` : `resources(...)`.

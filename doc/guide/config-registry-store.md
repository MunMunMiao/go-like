# Configuration, registry, store, and cache

These four contracts answer different questions. A shared ecosystem client does not merge the contracts.

| Domain   | Question                                      | Socket                              | Lifetime                      |
| -------- | --------------------------------------------- | ----------------------------------- | ----------------------------- |
| Config   | Which snapshot should this process use?       | `ConfigSource`, `ConfigDecoder`     | Process or deployment         |
| Registry | Which instances are reachable now?            | `Registrar`, `Discovery`, `Watcher` | Ephemeral control plane       |
| Store    | Which record exists at this key and revision? | `Store`                             | Business or operational state |
| Cache    | Can this disposable value be recomputed?      | `Cache`                             | Disposable                    |

Match provider codes with [Error handling](/reference/errors) before replaying a failed mutation.

## Config

`@go-like/core/config` merges sources into an immutable publication. `schema(...)` validates that publication. `config.scan(ctx, schema)` is a separate call: it both checks and types the result. Pass the schema to both.

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

`envSource` reads the record you pass. It does not read `process.env` by itself. `fileSource` plus `jsonDecoder` reads JSON through a `FileCapability`. `newNodeFileCapability` from `@go-like/core/config/node` is the Node binding. `decodeYaml` from `@go-like/yaml/config` is the YAML `ConfigDecoder`. It is a separate package because it depends on `js-yaml`.

`resolver` and `placeholderResolver` transform the merged object before publication. `onReloadError` observes a background reload that kept the last accepted snapshot. `onTerminalError` observes the first unrecoverable watcher failure. `value(key)` and `watch` read the publication. Config is not a `Server`. Close it from `afterStop`, or load it in the bootstrap sequence described in [Health and observability](/guide/health-observability) before `newApp`.

A reload failure can keep the last accepted snapshot. A terminal watcher failure is a different event. Source names are logical identities.

### Ecosystem sources

Each of these plugs exports one client from the package root and a source from the socket entry. Pass the same client to every socket you use.

| Root client                                      | Config entry                 | Source                              |
| ------------------------------------------------ | ---------------------------- | ----------------------------------- |
| `newConsulClient` from `@go-like/consul`         | `@go-like/consul/config`     | `consulSource(client, options)`     |
| `newEtcdClient` from `@go-like/etcd`             | `@go-like/etcd/config`       | `etcdSource(client, options)`       |
| `newVaultClient` from `@go-like/vault`           | `@go-like/vault/config`      | `vaultSource(client, options)`      |
| `newKubernetesClient` from `@go-like/kubernetes` | `@go-like/kubernetes/config` | `kubernetesSource(client, options)` |

The client takes an explicit `fetch`. That differs from `@go-like/core/transport/http`, which defaults to `globalThis.fetch`. HTTP, transport, and protocol failures share one error family on the package root. The `operation` field says which socket issued the call. See the plug README for watch recovery: Consul blocking queries, etcd compaction, Kubernetes relist, and Vault KV v2 are not the same mechanism.

`@go-like/core/fetch` supplies `Fetch`, `newFetchClient`, and the status helper plug authors use. Application code that only loads config can stay on the source constructor.

## Registry and discovery

`@go-like/core/registry` is the socket and the in-process machinery: `filterVersion`, `filterLabel`, the five selectors, `snapshotServiceInstance`, `selectEndpoint`, and `newDiscoveryResolver`. `@go-like/core/registry/memory` is `newMemoryRegistry`. `@go-like/core/registry/provider` is the plug-author kit (`newSnapshotWatcher`, `newIdentityLocks`, `startHeartbeat`).

| Plug entry                         | Constructor                              | Notes                                                |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `@go-like/consul/registry`         | `newConsulRegistry(client, options)`     | Same `ConsulClient` as config and store.             |
| `@go-like/etcd/registry`           | `newEtcdRegistry(client, options)`       | Lease and transaction stay on etcd.                  |
| `@go-like/kubernetes/registry`     | `newKubernetesRegistry(client, options)` | EndpointSlice identity and RBAC stay on the cluster. |
| `@go-like/zookeeper/registry`      | `newZookeeperRegistry(options)`          | Portable over `ZookeeperClientFactory`.              |
| `@go-like/zookeeper/registry/node` | `newNodeZookeeperClientFactory()`        | Imports `node-zookeeper-client`.                     |
| `@go-like/mdns/registry`           | `newMDNSRegistry(options)`               | Portable over an injected `MDNSHost`.                |
| `@go-like/mdns/registry/node`      | `newNodeMDNSHost`                        | Uses `node:dgram`.                                   |

A watcher yields complete replacement snapshots. `GO_LIKE_WATCHER_OVERFLOW` means events were dropped; rebuild from a full snapshot. `GO_LIKE_NO_AVAILABLE_ENDPOINT` means the current snapshot, after filters, has nowhere to send the call.

`registrar(registry)` on `newApp` registers the server-tier endpoints after they are prepared and deregisters them on stop. Resources are not registered. `registrarTimeout` defaults to 10 seconds.

## Store

`@go-like/core/store` is the byte-record socket: `get`, `put`, `delete`, and `list`, with `ifAbsent`, `ifRevision`, `prefix`, `limit`, `cursor`, and `expiresIn`. A missed condition is `GO_LIKE_STORE_CONFLICT`. Read the current record and decide again. Revisions are opaque. `@go-like/core/store/memory` is `newMemoryStore`, process-local only.

| Plug                       | Entry                              | Role                                                                                                 |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@go-like/consul/store`    | `newConsulStore(client, options?)` | KV under an isolated root. Uncertain readback and the TTL-plus-CAS combination have their own codes. |
| `@go-like/etcd/store`      | `newEtcdStore(client)`             | Revisions, compaction, leases. `GO_LIKE_ETCD_STORE_CLEANUP` means the mutation committed.            |
| `@go-like/vault/store`     | `newVaultStore(client, options)`   | KV v2. The list cursor is process-local.                                                             |
| `@go-like/file/store`      | `newFileStore(host, directory)`    | Portable over `FileStoreHost`. Also a resource-tier `Server`.                                        |
| `@go-like/file/store/node` | `newNodeFileStoreHost`             | Node directory host. The store is also a resource-tier `Server`.                                     |

Consul, etcd, and Vault stores use the shared root errors for HTTP, transport, and protocol failures. Store-only outcomes (uncertain mutation, compaction, lease loss, cleanup, unsupported flag combination, snapshot cursor) stay on the store entry.

File-store corruption, lock, and state errors stay on `@go-like/file/store`. A stale lock is not authority to delete it. A checksum failure is not authority to overwrite the snapshot.

## Cache

`@go-like/core/cache` is `get`, `put`, `delete` of bytes, plus `expiresIn`. A missing or expired key is `null`. `@go-like/core/cache/memory` is `newMemoryCache`. It is not a `Server` and it does not survive the process.

`@go-like/redis/cache` exports `newRedisCache`. The returned object is a `Cache` and a resource-tier `Server`: `start` resolves when the client is usable, and `stop` closes it. Put it in `resources(...)`. `GO_LIKE_CACHE_REDIS_OPERATION` and `GO_LIKE_CACHE_REDIS_PROTOCOL` are the public codes. A cache failure is a reason to use the authoritative store, not a reason to retry a business write.

## Choosing a plug

- One ecosystem, several sockets: one root client, one subpath per socket.
- Tests and single-process examples: the `memory` entries in core.
- Files on disk: `@go-like/file`, not a core subpath.
- YAML: `@go-like/yaml/config`.
- Anything that must be up before servers accept work, and that implements `Server`: `resources(...)`.

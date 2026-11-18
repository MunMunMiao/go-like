# 設定、註冊中心、儲存同快取

呢四個契約答唔同嘅問題。一個共用生態 client 唔會將契約合併。

| 領域     | 問題                              | 插座                                | 壽命           |
| -------- | --------------------------------- | ----------------------------------- | -------------- |
| 設定     | 呢個程序應該用邊一份快照？        | `ConfigSource`、`ConfigDecoder`     | 程序或部署     |
| 註冊中心 | 而家邊啲實例可達？                | `Registrar`、`Discovery`、`Watcher` | 短暫控制面     |
| 儲存     | 呢個 key 同 revision 有邊筆記錄？ | `Store`                             | 業務或營運狀態 |
| 快取     | 呢個可丟棄值可唔可以重算？        | `Cache`                             | 可丟棄         |

重播一次失敗嘅變更之前，先用[錯誤處理](/reference/errors)對 provider 代碼。

## 設定

`@go-like/core/config` 將來源合併成一份不可變發布。`schema(...)` 驗證該發布。`config.scan(ctx, schema)` 係另一次呼叫：佢同時檢查並為結果定型。兩邊都傳 schema。

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

`envSource` 讀你傳入嘅 record。佢本身唔讀 `process.env`。`fileSource` 加 `jsonDecoder` 經 `FileCapability` 讀 JSON。`@go-like/core/config/node` 嘅 `newNodeFileCapability` 係 Node 綁定。`@go-like/yaml/config` 嘅 `decodeYaml` 係 YAML `ConfigDecoder`。佢係獨立套件，因為佢依賴 `js-yaml`。

`resolver` 同 `placeholderResolver` 喺發布之前轉換合併後嘅物件。`onReloadError` 觀察一次保留上次接納快照嘅背景重新載入。`onTerminalError` 觀察第一個不可恢復嘅 watcher 失敗。`value(key)` 同 `watch` 讀發布。設定唔係 `Server`。由 `afterStop` 關閉佢，或者按[健康檢查與可觀測性](/zh-Hant-HK/guide/health-observability)描述嘅 bootstrap 次序，喺 `newApp` 之前載入。

重新載入失敗可以保留上次接納嘅快照。Watcher 終態失敗係另一件事。來源名稱係邏輯身份。

### 生態來源

下面每隻插頭由套件根匯出一個 client，由插座入口匯出一個來源。你用到嘅每個插座都傳同一個 client。

| 根 client                                      | 設定入口                     | 來源                                |
| ---------------------------------------------- | ---------------------------- | ----------------------------------- |
| `@go-like/consul` 嘅 `newConsulClient`         | `@go-like/consul/config`     | `consulSource(client, options)`     |
| `@go-like/etcd` 嘅 `newEtcdClient`             | `@go-like/etcd/config`       | `etcdSource(client, options)`       |
| `@go-like/vault` 嘅 `newVaultClient`           | `@go-like/vault/config`      | `vaultSource(client, options)`      |
| `@go-like/kubernetes` 嘅 `newKubernetesClient` | `@go-like/kubernetes/config` | `kubernetesSource(client, options)` |

Client 接收明確嘅 `fetch`。呢點同 `@go-like/core/transport/http` 唔同，後者預設 `globalThis.fetch`。HTTP、transport 同協議失敗喺套件根共用一個錯誤家族。`operation` 欄講邊個插座發出呼叫。監看恢復見插頭 README：Consul blocking query、etcd compaction、Kubernetes relist 同 Vault KV v2 唔係同一個機制。

`@go-like/core/fetch` 提供 `Fetch`、`newFetchClient`，同插頭作者用嘅 status helper。只載入設定嘅應用程式碼可以留喺來源建構函式。

## 註冊中心同服務探索

`@go-like/core/registry` 係插座同程序內機制：`filterVersion`、`filterLabel`、五種 selector、`snapshotServiceInstance`、`selectEndpoint` 同 `newDiscoveryResolver`。`@go-like/core/registry/memory` 係 `newMemoryRegistry`。`@go-like/core/registry/provider` 係插頭作者工具（`newSnapshotWatcher`、`newIdentityLocks`、`startHeartbeat`）。

| 插頭入口                           | 建構函式                                 | 備註                                   |
| ---------------------------------- | ---------------------------------------- | -------------------------------------- |
| `@go-like/consul/registry`         | `newConsulRegistry(client, options)`     | 同設定同儲存用同一個 `ConsulClient`。  |
| `@go-like/etcd/registry`           | `newEtcdRegistry(client, options)`       | Lease 同交易留喺 etcd。                |
| `@go-like/kubernetes/registry`     | `newKubernetesRegistry(client, options)` | EndpointSlice 身份同 RBAC 留喺叢集。   |
| `@go-like/zookeeper/registry`      | `newZookeeperRegistry(options)`          | 喺 `ZookeeperClientFactory` 之上可攜。 |
| `@go-like/zookeeper/registry/node` | `newNodeZookeeperClientFactory()`        | Import `node-zookeeper-client`。       |
| `@go-like/mdns/registry`           | `newMDNSRegistry(options)`               | 喺注入嘅 `MDNSHost` 之上可攜。         |
| `@go-like/mdns/registry/node`      | `newNodeMDNSHost`                        | 用 `node:dgram`。                      |

Watcher 產生完整替換快照。`GO_LIKE_WATCHER_OVERFLOW` 代表事件被丟棄；由完整快照重建。`GO_LIKE_NO_AVAILABLE_ENDPOINT` 代表而家嘅快照經過 filter 之後冇地方送呼叫。

`newApp` 上嘅 `registrar(registry)` 喺 Server 層 endpoint 準備好之後註冊佢哋，並喺停止時撤銷。資源唔會被註冊。`registrarTimeout` 預設 10 秒。

## 儲存

`@go-like/core/store` 係 byte 記錄插座：`get`、`put`、`delete` 同 `list`，帶 `ifAbsent`、`ifRevision`、`prefix`、`limit`、`cursor` 同 `expiresIn`。條件唔中係 `GO_LIKE_STORE_CONFLICT`。讀而家嘅記錄再決定一次。Revision 係不透明嘅。`@go-like/core/store/memory` 係 `newMemoryStore`，只係程序內。

| 插頭                       | 入口                               | 角色                                                                         |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `@go-like/consul/store`    | `newConsulStore(client, options?)` | 隔離根下面嘅 KV。不確定回讀同 TTL 加 CAS 組合有自己嘅代碼。                  |
| `@go-like/etcd/store`      | `newEtcdStore(client)`             | Revision、compaction、lease。`GO_LIKE_ETCD_STORE_CLEANUP` 代表變更已經提交。 |
| `@go-like/vault/store`     | `newVaultStore(client, options)`   | KV v2。List cursor 係程序內嘅。                                              |
| `@go-like/file/store`      | `newFileStore(host, directory)`    | 喺 `FileStoreHost` 之上可攜。亦係資源層 `Server`。                           |
| `@go-like/file/store/node` | `newNodeFileStoreHost`             | Node 目錄 host。儲存亦係資源層 `Server`。                                    |

Consul、etcd 同 Vault 儲存用共用根錯誤表示 HTTP、transport 同協議失敗。只屬於儲存嘅結果（不確定變更、compaction、lease 遺失、清理、唔支援嘅旗標組合、快照 cursor）留喺儲存入口。

檔案儲存嘅損壞、鎖同狀態錯誤留喺 `@go-like/file/store`。過期鎖唔係刪除佢嘅授權。Checksum 失敗唔係覆蓋快照嘅授權。

## 快取

`@go-like/core/cache` 係 bytes 嘅 `get`、`put`、`delete`，加 `expiresIn`。缺少或過期嘅 key 係 `null`。`@go-like/core/cache/memory` 係 `newMemoryCache`。佢唔係 `Server`，亦唔會活過程序。

`@go-like/redis/cache` 匯出 `newRedisCache`。返回嘅物件係 `Cache`，亦係資源層 `Server`：`start` 喺 client 可用時 resolve，`stop` 關閉佢。放喺 `resources(...)`。`GO_LIKE_CACHE_REDIS_OPERATION` 同 `GO_LIKE_CACHE_REDIS_PROTOCOL` 係公開代碼。快取失敗係改用權威儲存嘅理由，唔係重試業務寫入嘅理由。

## 點揀插頭

- 一個生態、幾個插座：一個根 client，每個插座一條 subpath。
- 測試同單程序例子：core 入面嘅 `memory` 入口。
- 磁碟上嘅檔案：`@go-like/file`，唔係 core subpath。
- YAML：`@go-like/yaml/config`。
- 任何必須喺 server 接受工作之前就緒、而且實作 `Server` 嘅物件：`resources(...)`。

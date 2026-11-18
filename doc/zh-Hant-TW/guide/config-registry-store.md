# 設定、服務註冊、儲存與快取

這四個契約回答的是不同的問題。共用一個生態系用戶端，不會把契約合併成一個。

| 領域     | 問題                                 | 插座                                | 生命週期       |
| -------- | ------------------------------------ | ----------------------------------- | -------------- |
| 設定     | 這個程序該用哪一份快照？             | `ConfigSource`、`ConfigDecoder`     | 程序或部署     |
| 服務註冊 | 現在哪些實例可達？                   | `Registrar`、`Discovery`、`Watcher` | 短暫的控制平面 |
| 儲存     | 這個鍵與 revision 上存在哪一筆記錄？ | `Store`                             | 業務或營運狀態 |
| 快取     | 這個可丟棄的值能不能重算？           | `Cache`                             | 可丟棄         |

重送一次失敗的變更之前，先用[錯誤處理](/reference/errors)對上 provider 的 code。

## 設定

`@go-like/core/config` 把來源合併成一份不可變的發布。`schema(...)` 驗證那份發布。`config.scan(ctx, schema)` 是另一次呼叫：它同時檢查，並標出結果的型別。Schema 兩邊都要傳。

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

`envSource` 讀的是你傳入的那份記錄。它不會自己讀 `process.env`。`fileSource` 加上 `jsonDecoder` 透過 `FileCapability` 讀 JSON。`@go-like/core/config/node` 的 `newNodeFileCapability` 是 Node 綁定。`@go-like/yaml/config` 的 `decodeYaml` 是 YAML 的 `ConfigDecoder`。它是獨立套件，因為它依賴 `js-yaml`。

`resolver` 與 `placeholderResolver` 在發布之前轉換合併後的物件。`onReloadError` 觀察一次仍保留最後接受快照的背景重新載入。`onTerminalError` 觀察第一次無法恢復的 watcher 失敗。`value(key)` 與 `watch` 讀取這份發布。Config 不是 `Server`。從 `afterStop` 關閉它，或在 `newApp` 之前、依[健康檢查與可觀測性](/zh-Hant-TW/guide/health-observability)描述的啟動序列載入它。

重新載入失敗可以保留最後一次接受的快照。Watcher 的終態失敗是另一個事件。來源名稱是邏輯身分。

### 生態系來源

下面每個插頭都從套件根入口匯出一個用戶端，並從插座入口匯出一個來源。同一個用戶端傳給你使用的每一個插座。

| 根用戶端                                       | 設定入口                     | 來源                                |
| ---------------------------------------------- | ---------------------------- | ----------------------------------- |
| `@go-like/consul` 的 `newConsulClient`         | `@go-like/consul/config`     | `consulSource(client, options)`     |
| `@go-like/etcd` 的 `newEtcdClient`             | `@go-like/etcd/config`       | `etcdSource(client, options)`       |
| `@go-like/vault` 的 `newVaultClient`           | `@go-like/vault/config`      | `vaultSource(client, options)`      |
| `@go-like/kubernetes` 的 `newKubernetesClient` | `@go-like/kubernetes/config` | `kubernetesSource(client, options)` |

用戶端接受一個明確的 `fetch`。這和 `@go-like/core/transport/http` 不同，後者預設使用 `globalThis.fetch`。HTTP、傳輸與協定失敗在套件根入口共用一個錯誤家族。`operation` 欄位指出是哪個插座發出呼叫。監看如何恢復見插頭 README：Consul blocking query、etcd compaction、Kubernetes relist 與 Vault KV v2 不是同一種機制。

`@go-like/core/fetch` 提供 `Fetch`、`newFetchClient`，以及插頭作者使用的狀態輔助。只載入設定的應用程式可以留在來源建構函式上。

## 服務註冊與探索

`@go-like/core/registry` 是插座，也是程序內的機制：`filterVersion`、`filterLabel`、五個 selector、`snapshotServiceInstance`、`selectEndpoint` 與 `newDiscoveryResolver`。`@go-like/core/registry/memory` 是 `newMemoryRegistry`。`@go-like/core/registry/provider` 是插頭作者工具（`newSnapshotWatcher`、`newIdentityLocks`、`startHeartbeat`）。

| 插頭入口                           | 建構函式                                 | 備註                                     |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `@go-like/consul/registry`         | `newConsulRegistry(client, options)`     | 與設定、儲存使用同一個 `ConsulClient`。  |
| `@go-like/etcd/registry`           | `newEtcdRegistry(client, options)`       | Lease 與交易留在 etcd。                  |
| `@go-like/kubernetes/registry`     | `newKubernetesRegistry(client, options)` | EndpointSlice 身分與 RBAC 留在叢集。     |
| `@go-like/zookeeper/registry`      | `newZookeeperRegistry(options)`          | 可攜，建在 `ZookeeperClientFactory` 上。 |
| `@go-like/zookeeper/registry/node` | `newNodeZookeeperClientFactory()`        | Import `node-zookeeper-client`。         |
| `@go-like/mdns/registry`           | `newMDNSRegistry(options)`               | 可攜，建在注入的 `MDNSHost` 上。         |
| `@go-like/mdns/registry/node`      | `newNodeMDNSHost`                        | 使用 `node:dgram`。                      |

Watcher 產出完整替換快照。`GO_LIKE_WATCHER_OVERFLOW` 表示事件被丟棄；從一份完整快照重建。`GO_LIKE_NO_AVAILABLE_ENDPOINT` 表示目前的快照在篩選之後，沒有地方可以送出呼叫。

`newApp` 上的 `registrar(registry)` 在 server 層級的端點準備好之後註冊它們，並在停止時註銷。資源不會被註冊。`registrarTimeout` 預設 10 秒。

## 儲存

`@go-like/core/store` 是位元組記錄插座：`get`、`put`、`delete` 與 `list`，以及 `ifAbsent`、`ifRevision`、`prefix`、`limit`、`cursor` 與 `expiresIn`。條件未命中是 `GO_LIKE_STORE_CONFLICT`。讀取目前的記錄，再做一次決定。Revision 是不透明的。`@go-like/core/store/memory` 是 `newMemoryStore`，只在這個程序裡。

| 插頭                       | 入口                               | 角色                                                                       |
| -------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `@go-like/consul/store`    | `newConsulStore(client, options?)` | 隔離根目錄下的 KV。不確定的回讀，以及 TTL 加 CAS 的組合，各有自己的 code。 |
| `@go-like/etcd/store`      | `newEtcdStore(client)`             | Revision、compaction、lease。`GO_LIKE_ETCD_STORE_CLEANUP` 表示變更已提交。 |
| `@go-like/vault/store`     | `newVaultStore(client, options)`   | KV v2。List cursor 只在這個程序裡。                                        |
| `@go-like/file/store`      | `newFileStore(host, directory)`    | 可攜，建在 `FileStoreHost` 上。同時也是 resource 層級的 `Server`。         |
| `@go-like/file/store/node` | `newNodeFileStoreHost`             | Node 目錄 host。這個 store 同時也是 resource 層級的 `Server`。             |

Consul、etcd 與 Vault 的儲存，對 HTTP、傳輸與協定失敗使用共用的根錯誤。只屬於儲存的結果（不確定的變更、compaction、lease 遺失、清理、不支援的旗標組合、快照 cursor）留在 store 入口。

檔案儲存的毀損、鎖與狀態錯誤留在 `@go-like/file/store`。過期的鎖不是刪除它的授權。Checksum 失敗不是覆寫快照的授權。

## 快取

`@go-like/core/cache` 是位元組的 `get`、`put`、`delete`，加上 `expiresIn`。缺少或過期的鍵是 `null`。`@go-like/core/cache/memory` 是 `newMemoryCache`。它不是 `Server`，也不會活過這個程序。

`@go-like/redis/cache` 匯出 `newRedisCache`。回傳的物件是 `Cache`，也是 resource 層級的 `Server`：`start` 在用戶端可用時 resolve，`stop` 關閉它。把它放進 `resources(...)`。公開的 code 是 `GO_LIKE_CACHE_REDIS_OPERATION` 與 `GO_LIKE_CACHE_REDIS_PROTOCOL`。快取失敗是改走權威儲存的理由，不是重試一次業務寫入的理由。

## 怎麼選插頭

- 一個生態系、多個插座：一個根用戶端，每個插座一條子路徑。
- 測試與單一程序範例：core 裡的 `memory` 入口。
- 磁碟上的檔案：`@go-like/file`，不是 core 的子路徑。
- YAML：`@go-like/yaml/config`。
- 必須在 server 開始接受工作之前就可用、而且實作了 `Server` 的東西：`resources(...)`。

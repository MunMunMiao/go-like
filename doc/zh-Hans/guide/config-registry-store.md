# 配置、注册中心、存储与缓存

这四份契约回答不同的问题。共用一个生态客户端并不会把契约合并。

| 领域     | 问题                         | 插座                                | 生命周期       |
| -------- | ---------------------------- | ----------------------------------- | -------------- |
| Config   | 这个进程应该使用哪一份快照？ | `ConfigSource`、`ConfigDecoder`     | 进程或部署     |
| Registry | 现在哪些实例可达？           | `Registrar`、`Discovery`、`Watcher` | 短暂的控制面   |
| Store    | 这个键和修订上存在哪条记录？ | `Store`                             | 业务或运维状态 |
| Cache    | 这个可丢弃的值能否重新计算？ | `Cache`                             | 可丢弃         |

重放失败的变更之前，先用[错误处理](/reference/errors)对照 provider 代码。

## 配置

`@go-like/core/config` 把多个 source 合并成一份不可变发布。`schema(...)` 校验该发布。`config.scan(ctx, schema)` 是另一次调用：它既检查，也给结果加上类型。把 schema 传给两边。

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

`envSource` 读取你传入的 record。它自己不读 `process.env`。`fileSource` 加上 `jsonDecoder` 通过 `FileCapability` 读取 JSON。`@go-like/core/config/node` 的 `newNodeFileCapability` 是 Node 绑定。`@go-like/yaml/config` 的 `decodeYaml` 是 YAML `ConfigDecoder`。它单独成包，因为它依赖 `js-yaml`。

`resolver` 和 `placeholderResolver` 在发布之前变换合并后的对象。`onReloadError` 观察一次保留了最后已接纳快照的后台重载。`onTerminalError` 观察第一次不可恢复的 watcher 失败。`value(key)` 和 `watch` 读取这份发布。Config 不是 `Server`。从 `afterStop` 关闭它，或按[健康与可观测性](/zh-Hans/guide/health-observability)里描述的启动序列，在 `newApp` 之前加载它。

重载失败可以保留最后一份已接纳的快照。Watcher 的终态失败是另一件事。Source 名称是逻辑身份。

### 生态 source

下面每个插头都从包根导出一个客户端，并从插座入口导出一个 source。把同一个客户端传给每一个要用的插座。

| 根客户端                                       | Config 入口                  | Source                              |
| ---------------------------------------------- | ---------------------------- | ----------------------------------- |
| `@go-like/consul` 的 `newConsulClient`         | `@go-like/consul/config`     | `consulSource(client, options)`     |
| `@go-like/etcd` 的 `newEtcdClient`             | `@go-like/etcd/config`       | `etcdSource(client, options)`       |
| `@go-like/vault` 的 `newVaultClient`           | `@go-like/vault/config`      | `vaultSource(client, options)`      |
| `@go-like/kubernetes` 的 `newKubernetesClient` | `@go-like/kubernetes/config` | `kubernetesSource(client, options)` |

客户端接收显式的 `fetch`。这与 `@go-like/core/transport/http` 不同，后者默认使用 `globalThis.fetch`。HTTP、传输和协议失败在包根共享同一个错误族。`operation` 字段说明是哪个插座发出的调用。监视恢复见插头 README：Consul blocking query、etcd compaction、Kubernetes relist 和 Vault KV v2 不是同一种机制。

`@go-like/core/fetch` 提供插头作者使用的 `Fetch`、`newFetchClient` 和状态辅助。只加载配置的应用代码可以留在 source 构造函数上。

## 注册与发现

`@go-like/core/registry` 是插座和进程内机制：`filterVersion`、`filterLabel`、五种 Selector、`snapshotServiceInstance`、`selectEndpoint` 和 `newDiscoveryResolver`。`@go-like/core/registry/memory` 是 `newMemoryRegistry`。`@go-like/core/registry/provider` 是插头作者工具包（`newSnapshotWatcher`、`newIdentityLocks`、`startHeartbeat`）。

| 插头入口                           | 构造函数                                 | 说明                                         |
| ---------------------------------- | ---------------------------------------- | -------------------------------------------- |
| `@go-like/consul/registry`         | `newConsulRegistry(client, options)`     | 与 config、store 使用同一个 `ConsulClient`。 |
| `@go-like/etcd/registry`           | `newEtcdRegistry(client, options)`       | 租约和事务留在 etcd 上。                     |
| `@go-like/kubernetes/registry`     | `newKubernetesRegistry(client, options)` | EndpointSlice 身份和 RBAC 留在集群上。       |
| `@go-like/zookeeper/registry`      | `newZookeeperRegistry(options)`          | 在 `ZookeeperClientFactory` 之上可移植。     |
| `@go-like/zookeeper/registry/node` | `newNodeZookeeperClientFactory()`        | 导入 `node-zookeeper-client`。               |
| `@go-like/mdns/registry`           | `newMDNSRegistry(options)`               | 在注入的 `MDNSHost` 之上可移植。             |
| `@go-like/mdns/registry/node`      | `newNodeMDNSHost`                        | 使用 `node:dgram`。                          |

Watcher 产出完整替换快照。`GO_LIKE_WATCHER_OVERFLOW` 表示事件被丢弃；从完整快照重建。`GO_LIKE_NO_AVAILABLE_ENDPOINT` 表示当前快照在过滤之后没有地方发送这次调用。

`newApp` 上的 `registrar(registry)` 在 server 层 endpoint 准备好之后注册它们，并在停止时注销。资源不会被注册。`registrarTimeout` 默认 10 秒。

## 存储

`@go-like/core/store` 是字节记录插座：`get`、`put`、`delete` 和 `list`，带 `ifAbsent`、`ifRevision`、`prefix`、`limit`、`cursor` 和 `expiresIn`。条件未命中是 `GO_LIKE_STORE_CONFLICT`。读出当前记录，再做一次决定。修订是不透明的。`@go-like/core/store/memory` 是 `newMemoryStore`，仅限进程内。

| 插头                       | 入口                               | 角色                                                                    |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `@go-like/consul/store`    | `newConsulStore(client, options?)` | 隔离根下的 KV。不确定的回读，以及 TTL 加 CAS 的组合，各有自己的代码。   |
| `@go-like/etcd/store`      | `newEtcdStore(client)`             | 修订、compaction、租约。`GO_LIKE_ETCD_STORE_CLEANUP` 表示变更已经提交。 |
| `@go-like/vault/store`     | `newVaultStore(client, options)`   | KV v2。列表游标是进程内的。                                             |
| `@go-like/file/store`      | `newFileStore(host, directory)`    | 在 `FileStoreHost` 之上可移植。同时也是资源层 `Server`。                |
| `@go-like/file/store/node` | `newNodeFileStoreHost`             | Node 目录宿主。该 store 同时也是资源层 `Server`。                       |

Consul、etcd 和 Vault 的 store 对 HTTP、传输和协议失败使用共享的根错误。仅属于 store 的结果（不确定的变更、compaction、租约丢失、清理、不支持的标志组合、快照游标）留在 store 入口上。

文件存储的损坏、锁和状态错误留在 `@go-like/file/store`。过期的锁不是删除它的授权。校验和失败不是覆盖快照的授权。

## 缓存

`@go-like/core/cache` 是字节的 `get`、`put`、`delete`，加上 `expiresIn`。缺失或过期的键是 `null`。`@go-like/core/cache/memory` 是 `newMemoryCache`。它不是 `Server`，也不跨过进程存活。

`@go-like/redis/cache` 导出 `newRedisCache`。返回的对象既是 `Cache`，也是资源层 `Server`：`start` 在客户端可用时 resolve，`stop` 关闭它。把它放进 `resources(...)`。`GO_LIKE_CACHE_REDIS_OPERATION` 和 `GO_LIKE_CACHE_REDIS_PROTOCOL` 是公共代码。缓存失败是改用权威存储的理由，不是重试一次业务写入的理由。

## 选择插头

- 一个生态、多个插座：一个根客户端，每个插座一个子路径。
- 测试和单进程示例：core 里的 `memory` 入口。
- 磁盘上的文件：`@go-like/file`，不是 core 的子路径。
- YAML：`@go-like/yaml/config`。
- 必须在 server 开始接受工作之前就绪、并且实现了 `Server` 的东西：`resources(...)`。

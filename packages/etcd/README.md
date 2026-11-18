# @go-like/etcd

共享的 etcd v3 JSON gateway 客户端，以及填在它上面的 Registry、Config 与 Store 插座。根入口不是插座。`token` 原样写入 `Authorization`，不加 `Bearer` 前缀。

## 入口

| 入口                     | 填充的插座                            | 关键导出                      |
| ------------------------ | ------------------------------------- | ----------------------------- |
| `@go-like/etcd`          | 无。共享客户端                        | `newEtcdClient`、`EtcdClient` |
| `@go-like/etcd/registry` | `Registry`                            | `newEtcdRegistry`             |
| `@go-like/etcd/config`   | `ConfigSource`、`ConfigSourceWatcher` | `etcdSource`                  |
| `@go-like/etcd/store`    | `Store`                               | `newEtcdStore`                |

通道均可移植。

## 依赖

没有第三方运行时依赖，也没有可选 peer。`@go-like/core` 的 peer 是锁步精确版本 `0.0.1`，dev 依赖是 `workspace:*`。

## 示例

```ts
import { newEtcdClient } from "@go-like/etcd"
import { etcdSource } from "@go-like/etcd/config"
import { newEtcdRegistry } from "@go-like/etcd/registry"
import { newEtcdStore } from "@go-like/etcd/store"

const etcd = newEtcdClient({ fetch, address: "http://127.0.0.1:2379" })
const source = etcdSource(etcd, { key: "/services/orders/config" })
const registry = newEtcdRegistry(etcd)
const store = newEtcdStore(etcd)
```

## 错误码

根入口：

| 代码                     | 类型                 |
| ------------------------ | -------------------- |
| `GO_LIKE_ETCD_HTTP`      | `EtcdHttpError`      |
| `GO_LIKE_ETCD_TRANSPORT` | `EtcdTransportError` |
| `GO_LIKE_ETCD_PROTOCOL`  | `EtcdProtocolError`  |

`./store` 另有：

| 代码                            | 类型                      |
| ------------------------------- | ------------------------- |
| `GO_LIKE_ETCD_STORE_COMPACTED`  | `EtcdStoreCompactedError` |
| `GO_LIKE_ETCD_STORE_LEASE_LOST` | `EtcdStoreLeaseLostError` |
| `GO_LIKE_ETCD_STORE_UNCERTAIN`  | `EtcdStoreUncertainError` |
| `GO_LIKE_ETCD_STORE_CLEANUP`    | `EtcdStoreCleanupError`   |

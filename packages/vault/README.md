# @go-like/vault

共享的 Vault HTTP 客户端，以及填在它上面的 Config 与 Store 插座。没有 Registry 入口。根入口不是插座。

## 入口

| 入口                    | 填充的插座                            | 关键导出                        |
| ----------------------- | ------------------------------------- | ------------------------------- |
| `@go-like/vault`        | 无。共享客户端                        | `newVaultClient`、`VaultClient` |
| `@go-like/vault/config` | `ConfigSource`、`ConfigSourceWatcher` | `vaultSource`                   |
| `@go-like/vault/store`  | `Store`                               | `newVaultStore`                 |

通道均可移植。

## 依赖

没有第三方运行时依赖，也没有可选 peer。`@go-like/core` 的 peer 是锁步精确版本 `0.0.1`，dev 依赖是 `workspace:*`。

## 示例

```ts
import { newVaultClient } from "@go-like/vault"
import { vaultSource } from "@go-like/vault/config"
import { newVaultStore } from "@go-like/vault/store"

const vault = newVaultClient({
  fetch,
  address: "https://127.0.0.1:8200",
  token: process.env["VAULT_TOKEN"]
})
const source = vaultSource(vault, { mount: "secret", path: "orders" })
const store = newVaultStore(vault, { mount: "secret" })
```

## 错误码

根入口：

| 代码                      | 类型                  |
| ------------------------- | --------------------- |
| `GO_LIKE_VAULT_HTTP`      | `VaultHttpError`      |
| `GO_LIKE_VAULT_TRANSPORT` | `VaultTransportError` |
| `GO_LIKE_VAULT_PROTOCOL`  | `VaultProtocolError`  |

`./store` 另有：

| 代码                            | 类型                       |
| ------------------------------- | -------------------------- |
| `GO_LIKE_VAULT_STORE_UNCERTAIN` | `VaultStoreUncertainError` |
| `GO_LIKE_VAULT_STORE_SNAPSHOT`  | `VaultStoreSnapshotError`  |

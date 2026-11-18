# @go-like/consul

共享的 Consul HTTP 客户端，以及填在它上面的 Registry、Config 与 Store 插座。根入口不是插座。协议调用使用应用传入的 `Fetch`。

## 入口

| 入口                       | 填充的插座                            | 关键导出                          |
| -------------------------- | ------------------------------------- | --------------------------------- |
| `@go-like/consul`          | 无。共享客户端                        | `newConsulClient`、`ConsulClient` |
| `@go-like/consul/registry` | `Registry`                            | `newConsulRegistry`               |
| `@go-like/consul/config`   | `ConfigSource`、`ConfigSourceWatcher` | `consulSource`                    |
| `@go-like/consul/store`    | `Store`                               | `newConsulStore`                  |

通道均可移植。

## 依赖

没有第三方运行时依赖，也没有可选 peer。`@go-like/core` 的 peer 是锁步精确版本 `0.0.1`，dev 依赖是 `workspace:*`。

## 示例

```ts
import { newConsulClient } from "@go-like/consul"
import { consulSource } from "@go-like/consul/config"
import { newConsulRegistry } from "@go-like/consul/registry"
import { newConsulStore } from "@go-like/consul/store"

const consul = newConsulClient({ fetch, address: "http://127.0.0.1:8500" })
const source = consulSource(consul, { key: "services/orders/config" })
const registry = newConsulRegistry(consul)
const store = newConsulStore(consul)
```

## 错误码

根入口：

| 代码                       | 类型                   |
| -------------------------- | ---------------------- |
| `GO_LIKE_CONSUL_HTTP`      | `ConsulHttpError`      |
| `GO_LIKE_CONSUL_TRANSPORT` | `ConsulTransportError` |
| `GO_LIKE_CONSUL_PROTOCOL`  | `ConsulProtocolError`  |

`./store` 另有：

| 代码                                           | 类型                                     |
| ---------------------------------------------- | ---------------------------------------- |
| `GO_LIKE_CONSUL_STORE_UNCERTAIN`               | `ConsulStoreUncertainError`              |
| `GO_LIKE_CONSUL_STORE_UNSUPPORTED_COMBINATION` | `ConsulStoreUnsupportedCombinationError` |

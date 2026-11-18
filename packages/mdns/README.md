# @go-like/mdns

mDNS `Registry`。可移植入口接受插头自己的 `MDNSHost`。`./registry/node` 用 `node:dgram` 提供宿主。没有根入口，也没有第三方运行时依赖。

## 入口

| 入口                          | 填充的插座        | 通道   | 关键导出          |
| ----------------------------- | ----------------- | ------ | ----------------- |
| `@go-like/mdns/registry`      | `Registry`        | 可移植 | `newMDNSRegistry` |
| `@go-like/mdns/registry/node` | `node:dgram` 宿主 | Node   | `newNodeMDNSHost` |

`@go-like/core` 的 peer 是锁步精确版本 `0.0.1`，dev 依赖是 `workspace:*`。没有可选 peer，也没有常规依赖。

## 示例

```ts
import { newMDNSRegistry } from "@go-like/mdns/registry"
import { newNodeMDNSHost } from "@go-like/mdns/registry/node"

const registry = newMDNSRegistry(newNodeMDNSHost())
```

## 错误码

本包不定义 `GO_LIKE_` 错误码。缺少 `networkInterfaces` 或 `bindDatagram` 的宿主在构造时抛出 `TypeError`。

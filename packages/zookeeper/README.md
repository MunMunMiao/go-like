# @go-like/zookeeper

ZooKeeper `Registry`。可移植入口只依赖插头自己的 `ZookeeperClientFactory`。`./registry/node` 用 `node-zookeeper-client` 提供这个工厂。没有根入口。

## 入口

| 入口                               | 填充的插座      | 通道   | 关键导出                        |
| ---------------------------------- | --------------- | ------ | ------------------------------- |
| `@go-like/zookeeper/registry`      | `Registry`      | 可移植 | `newZookeeperRegistry`          |
| `@go-like/zookeeper/registry/node` | Node 客户端工厂 | Node   | `newNodeZookeeperClientFactory` |

## 依赖

| 种类 | 包                      | 范围    | 说明                        |
| ---- | ----------------------- | ------- | --------------------------- |
| peer | `@go-like/core`         | `0.0.1` | dev 依赖为 `workspace:*`    |
| 常规 | `node-zookeeper-client` | `1.2.1` | 只被 `./registry/node` 导入 |

没有可选 peer。

## 示例

```ts
import { newZookeeperRegistry } from "@go-like/zookeeper/registry"
import { newNodeZookeeperClientFactory } from "@go-like/zookeeper/registry/node"

const registry = newZookeeperRegistry({
  address: "127.0.0.1:2181",
  client: newNodeZookeeperClientFactory()
})
```

## 错误码

| 代码                               | 类型                           |
| ---------------------------------- | ------------------------------ |
| `GO_LIKE_ZOOKEEPER_OPERATION`      | `ZookeeperOperationError`      |
| `GO_LIKE_ZOOKEEPER_AUTHENTICATION` | `ZookeeperAuthenticationError` |

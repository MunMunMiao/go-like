# @go-like/file

文件 `Store`，同时是资源层 `Server`。可移植入口接受插头自己的 `FileStoreHost`。`./store/node` 提供 Node 文件系统宿主。没有第三方运行时依赖。

## 入口

| 入口                       | 填充的插座               | 通道   | 关键导出                                   |
| -------------------------- | ------------------------ | ------ | ------------------------------------------ |
| `@go-like/file/store`      | `Store`；资源层 `Server` | 可移植 | `newFileStore`、`FileStore` 与三个错误类型 |
| `@go-like/file/store/node` | Node 宿主                | Node   | `newNodeFileStoreHost`                     |

`@go-like/core` 的 peer 是锁步精确版本 `0.0.1`，dev 依赖是 `workspace:*`。没有可选 peer，也没有常规依赖。

## 示例

```ts
import { newApp, resources } from "@go-like/core"
import { newFileStore } from "@go-like/file/store"
import { newNodeFileStoreHost } from "@go-like/file/store/node"

const store = newFileStore(newNodeFileStoreHost(), ".data/orders")
const app = newApp(resources(store))
void app
```

目录锁只在 `start` 与 `stop` 之间持有。读写放在资源层，不要在准入前调用。

## 错误码

| 代码                            | 类型                       |
| ------------------------------- | -------------------------- |
| `GO_LIKE_FILE_STORE_STATE`      | `FileStoreStateError`      |
| `GO_LIKE_FILE_STORE_CORRUPTION` | `FileStoreCorruptionError` |
| `GO_LIKE_FILE_STORE_LOCKED`     | `FileStoreLockedError`     |

这三个错误类型从 `@go-like/file/store` 导出。构造函数留在包内，不是公开入口。

损坏原因是 `encoding`、`json`、`schema`、`checksum` 或 `record`。键冲突仍是 core 的 `GO_LIKE_STORE_CONFLICT`。

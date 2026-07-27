# @likego/store-file

LikeGo 的单目录、单 owner 文件 Store。根入口只依赖注入的结构式 filesystem host；Node.js 文件系统能力由
`@likego/store-file/node` 显式提供。

每次 mutation 通过完整 checksum 快照、临时文件和原子 rename 提交。该 provider 适合小型本地状态，不支持
跨进程 shared writers，也不伪装成数据库。

```ts
import { newApp, server } from "@likego/core"
import { newFileStore } from "@likego/store-file"
import { newNodeFileStoreHost } from "@likego/store-file/node"

const store = newFileStore(newNodeFileStoreHost(), "./data/service-state")
const app = newApp(server(store))

await app.run()
```

`start(ctx)` 持有目录锁并驻留运行，直到 `stop(ctx)` 完成；不存在额外的 lifecycle handle。

目录内只使用三个 provider 私有文件：`.likego-store.snapshot`、`.likego-store.tmp` 和
`.likego-store.lock`。业务 key 只存在于快照内容中，不参与路径拼接。启动时只读取 checksum 与 schema 均完整的
snapshot；残留 temp 不会覆盖最后一次成功提交，并会在正常停止时清理。

Node host 使用排他创建的 lock 文件保护单 owner。进程异常终止后若留下 lock，provider 会 fail closed；确认没有
存活 owner 后才可由运维删除该文件，避免通过 PID 猜测或自动抢占制造双写。

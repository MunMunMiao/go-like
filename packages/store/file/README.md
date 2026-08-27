# @go-like/store-file

go-like 的单目录、单 owner 文件 Store。根入口只依赖注入的结构式 filesystem host；Node.js 文件系统能力由
`@go-like/store-file/node` 显式提供。

每次 mutation 通过完整 checksum 快照、临时文件和原子 rename 提交。该 provider 适合小型本地状态，不支持
跨进程 shared writers，也不伪装成数据库。

`ifAbsent()` 和 `ifRevision(...)` 在单 owner 的 mutation queue 内与候选快照提交一起串行裁决，不会退化为
业务层 read-then-write；条件失败不会写 temp 或替换 snapshot。

```ts
import { newApp, server } from "@go-like/core"
import { newFileStore } from "@go-like/store-file"
import { newNodeFileStoreHost } from "@go-like/store-file/node"

const store = newFileStore(newNodeFileStoreHost(), "./data/service-state")
const app = newApp(server(store))

await app.run()
```

`start(ctx)` 持有目录锁并驻留运行，直到 `stop(ctx)` 完成；不存在额外的 lifecycle handle。

目录内只使用三个 provider 私有文件：`.go-like-store.snapshot`、`.go-like-store.tmp` 和
`.go-like-store.lock`。业务 key 只存在于快照内容中，不参与路径拼接。启动取得目录锁后会先清理上一 owner 残留的
temp，并且候选文件只以排他创建打开；owner 运行期间若在 candidate create 前出现同名目录项，mutation 会 fail
closed，不会跟随符号链接。启动时只读取 checksum 与 schema 均完整的 snapshot；残留 temp 不会覆盖最后一次
成功提交。

Node host 使用排他创建的 lock 文件保护单 owner。进程异常终止后若留下 lock，provider 会 fail closed；确认没有
存活 owner 后才可由运维删除该文件，避免通过 PID 猜测或自动抢占制造双写。运行进程必须独占控制 Store 目录及其
父路径的写权限；provider 不把不可信主体可写的 shared directory 当作 filesystem sandbox。

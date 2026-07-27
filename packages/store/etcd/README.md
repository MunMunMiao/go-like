# @likego/store-etcd

`@likego/store-etcd` 是基于标准 Web API `Fetch` 和 etcd v3 JSON gRPC gateway 的
`@likego/store` provider。它不依赖 Node API、gRPC client 或 Protobuf runtime，可由 Bun、Node.js、
Deno 以及其他提供标准 Web API 的后端 runtime 承载。

```ts
import { background } from "@likego/context"
import { newEtcdStore } from "@likego/store-etcd"

const store = newEtcdStore({
  fetch,
  address: "http://127.0.0.1:2379"
})

const record = await store.read(background(), "orders/1001")
```

## 协议语义

- key 与包含 value、metadata、精确 `expiresAt` 的稳定 payload 使用 canonical base64 进入 JSON gateway。
- `mod_revision` 是单条记录的 CAS token；分页 cursor 固定首屏 `header.revision`，后续页使用历史
  revision，避免翻页期间的新写入改变结果集。
- write/delete 都使用 etcd transaction compare，失败分支返回当前 KV。响应可能丢失时执行 exact
  readback；无法证明结果时返回 `LIKEGO_ETCD_STORE_UNCERTAIN`，不会猜测成功。
- TTL 使用每条记录独立 lease。客户端生命周期不撤销业务 TTL；显式 delete 或覆盖会主动撤销已废弃
  lease。lease 在提交前丢失返回 `LIKEGO_ETCD_STORE_LEASE_LOST`。
- 历史分页 revision 被 compact 后返回 `LIKEGO_ETCD_STORE_COMPACTED`。HTTP 错误只保留 status 与数字
  gRPC code，Fetch rejection、响应 body 和 bearer token 不进入公开错误。

## 所有权

| 资源         | owner       | 生命周期边界                                             |
| ------------ | ----------- | -------------------------------------------------------- |
| `etcd-fetch` | 应用        | 仅借用；本包不调用 `close`、`destroy` 或同类能力         |
| 持久 KV      | 对应 record | 只有显式 delete 才删除                                   |
| TTL KV/Lease | 对应 record | 到期由 etcd 清理；显式 delete 或覆盖提前撤销 exact lease |

构造过程不做 I/O，也不启动后台任务；Store 构造后即可 CRUD/list，每次操作由自己的 `Context` 裁决。
本包不提供隐式 namespace、全局默认 Store、watch、ORM、cache 或 transaction DSL。

## 能力边界

| 能力           | v1 边界                                                   |
| -------------- | --------------------------------------------------------- |
| key            | 非空、well-formed UTF-16，最多 1,024 UTF-8 bytes          |
| value          | 最多 524,288 bytes                                        |
| TTL            | 1,000 至 2,147,483,647 ms                                 |
| CAS            | write 与 delete 均支持                                    |
| shared writers | 支持，依赖 etcd linearizable range 与 transaction compare |
| pagination     | 每页最多 1,000 条；cursor 绑定 prefix 与 MVCC revision    |

## 真实服务门禁

Docker 集成测试固定使用：

`gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2`

[etcd 3.7.1 真实 Docker 验证报告](https://github.com/MunMunMiao/likego/blob/main/packages/store/etcd/test/integration/etcd-3.7.1-report.md)

```sh
bun run --filter @likego/store-etcd test:docker
```

门禁覆盖 CRUD、prefix pagination、txn CAS、lease 到期、delete 主动 revoke、新客户端持久数据、同一
容器 restart 后恢复，以及 key、lease、container 零残留。

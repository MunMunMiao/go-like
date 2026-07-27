# `@likego/store-consul`

`@likego/store-consul` 是 `@likego/store` 的 Consul KV provider。它只使用调用方注入的标准 Web Fetch，
不依赖 Node Consul SDK、运行时全局 `fetch`、gRPC 或 Proto。

## 使用

```ts
import { background } from "@likego/context"
import { newConsulStore } from "@likego/store-consul"

const store = newConsulStore({
  fetch,
  address: "http://127.0.0.1:8500",
  root: "services/orders"
})

const record = await store.read(background(), "orders/1001")
```

构造不会执行 I/O，也不启动后台任务；Store 构造后即可 CRUD/list。每次操作由自己的 `Context` 裁决，
本包不会关闭借用的 Fetch，也不会删除持久化 KV 或提前销毁尚未到期的 TTL session。

## KV 根隔离

`root` 默认是 `likego/store`。构造时会移除首尾 `/`，拒绝空路径、空 segment、`.`、`..`、
不完整 UTF-16 以及超过 1,024 UTF-8 bytes 的 root。逻辑 key `orders/1001` 在默认配置下只映射到
物理 key `likego/store/orders/1001`。

同一 `root` 的 Store 共享 revision、CAS 和 TTL 状态；不同 `root` 完全隔离，分页 cursor 也绑定 root。
read/list 只请求当前
root，因此 root 外的 Consul KV 不会进入结果。当前 root 内被查询到的非 LikeGo envelope、损坏 base64、
错误 revision 或越界 key 会统一返回 `ConsulStoreProtocolError`，不会被静默跳过。

## Consul 映射

| Store 语义         | Consul 2.0.2 映射                                                           |
| ------------------ | --------------------------------------------------------------------------- |
| root               | `<root>/<logical-key>`；默认 `likego/store`，root 外 KV 永不混入            |
| value              | LikeGo versioned JSON envelope；二进制 value 使用标准 base64                |
| revision           | KV `ModifyIndex` 的十进制字符串，不解释其业务含义                           |
| write CAS          | `PUT /v1/kv/:key?cas=<ModifyIndex>`                                         |
| delete             | 先 exact read，再以 `DELETE ...?cas=<ModifyIndex>` 删除                     |
| prefix/list        | 强一致 `GET ...?recurse=true`；cursor 绑定 `X-Consul-Index`，变更后拒绝续页 |
| TTL                | `Behavior:"delete"` 的 Session 加 KV `acquire=<session>`                    |
| uncertain response | 通过 exact KV、Session name 或 Session ID readback 证明结果                 |

provider 固定 TTL 范围 `10_000..86_400_000ms`、key 上限 1,024 UTF-8 bytes、原始 value 上限
393,126 bytes、编码后 envelope 上限 524,288 bytes、单页上限 1,000 条。value 上限为最大的安全
`expiresAt`、UUID operation marker 与 JSON envelope 预留了完整空间。Consul 的 session reap 不是精确计时器；
record 自己的 `expiresAt` 到期后，read/list 会立即隐藏它，Consul 随后按 Session TTL 清理远端 KV。
分页期间 Consul index 变化时，旧 cursor 会返回 `Consul Store cursor is stale`，调用方应从第一页重试；
provider 不会把不同 KV 快照拼成一页结果。

## CAS 与 TTL 的明确边界

Consul 2.0.2 的 KV API 不允许同一请求同时使用 `cas` 与 `acquire`。本项目已用真实
`hashicorp/consul:2.0.2` 验证该请求返回 HTTP 400：

```text
Conflicting flags: acquire=<session>&cas=<ModifyIndex>
```

因此 v1 不伪造原子性，也不偷偷改用 transaction API：

- `expiresIn(...)` 与 `ifRevision(...)` 同时使用会在 I/O 前返回
  `ConsulStoreUnsupportedCombinationError`，combination 为 `ttl-cas`；
- 对当前由 TTL Session 持有的 record 做普通 CAS write 同样 fail closed，combination 为
  `cas-existing-ttl`，避免 CAS 更新后仍被旧 Session 延迟删除；
- 普通 persistent CAS、TTL 非 CAS write 和 CAS delete 均完整支持。

## 所有权与凭据边界

| 资源             | owner       | 生命周期边界                                                           |
| ---------------- | ----------- | ---------------------------------------------------------------------- |
| `consul-fetch`   | 应用        | 仅借用；本包不调用 `close`、`destroy` 或同类能力                       |
| `consul-process` | 应用/运维   | 本包不启动、停止或配置 Consul 进程                                     |
| persistent KV    | 业务数据    | 只有显式 delete 删除                                                   |
| TTL KV/Session   | 对应 record | 到期由 Consul behavior-delete 清理；显式 delete 提前销毁 exact Session |

ACL token 只在最终 Request 边界写入 `X-Consul-Token`，不进入 URL、wire payload、错误 message 或
diagnostic。配置 token 时，注入 Fetch 的 rejection graph 会整体替换，避免其中携带 Request/header 泄密；
非成功响应只保留 operation 与 HTTP status，不读取或反射 body。

TLS trust、client certificate、proxy、连接池和 Fetch 生命周期均由应用 owner 管理。

## 验证

```sh
bun run --filter @likego/store-consul typecheck
bun run --filter @likego/store-consul test:unit:coverage
bun run --filter @likego/store-consul build
bun run test:e2e:suites -- --suite store-consul-docker
```

真实协议测试固定使用：

```text
hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2
```

覆盖外部 KV 隔离、不同 root、root 内损坏数据 fail-closed、CRUD、prefix、CAS、Session TTL、ACL、
restart 与 KV/Session/container 零残留。

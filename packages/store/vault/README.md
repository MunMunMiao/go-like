# `@go-like/store-vault`

`@go-like/store-vault` 是 `@go-like/store` 的 HashiCorp Vault KV v2 provider。它只使用调用方注入的
标准 Web Fetch，不依赖 Vault SDK、Node API、gRPC 或 Proto。

```ts
import { background } from "@go-like/context"
import { newVaultStore } from "@go-like/store-vault"

const store = newVaultStore({
  fetch,
  address: "http://127.0.0.1:8200",
  mount: "secret",
  root: "go-like/store",
  token: credentials.vaultToken
})

const record = await store.read(background(), "orders/1001")
```

构造不会执行 I/O，也不启动后台任务；Store 构造后即可 CRUD/list。每次操作由自己的 `Context` 裁决，
本包不会关闭借用的 Fetch，也不会删除持久化 KV。

## KV v2 映射

本包仅支持 Vault KV v2。`mount` 是已经启用 KV v2 的挂载路径；默认 `root` 为 `go-like/store`。
每个逻辑 key 先按 UTF-8 编码，再转换为无 padding 的 base64url 单层物理 key，因此所有数据都被限制在
`/v1/{mount}/{data|metadata|delete}/{root}/` 下，不会与 Vault 中其他业务 keyspace 混用。

| Store 语义     | Vault KV v2 映射                                                                    |
| -------------- | ----------------------------------------------------------------------------------- |
| value/metadata | `data` 下的 go-like version 1 JSON envelope；二进制 value 使用标准 base64            |
| revision       | KV v2 metadata 的正整数 `version`，对外使用十进制字符串                             |
| write          | `POST /v1/{mount}/data/{root}/{physical-key}`，不伪造 CAS                           |
| read           | `GET /v1/{mount}/data/{root}/{physical-key}`                                        |
| delete         | 先读取 current version，再 `POST .../delete/...` 的 `versions:[version]`            |
| list           | 一次 `GET metadata/{root}?list=true` 后逐项 GET，在进程内按 Unicode code point 排序 |

Vault 的普通 `DELETE data/{path}` 会删除请求到达时的最新版本；并发写入可能因此被误删。本包不使用该
端点，而只 soft-delete 调用开始时真实读取到的 exact version。若读取后出现新版本，新版本不会被删除。

## 能力边界

- Vault 不支持 TTL；`expiresIn(...)` 在 I/O 前以 `TypeError` fail closed。
- 本 provider 不支持条件 write/delete；`ifAbsent()` 与 `ifRevision(...)` 都在 I/O 前以 `TypeError`
  fail closed，不会退化为 read-then-write。
- 不同 Store 实例可共享 Vault；普通 write 是 Vault 的 last-write-wins。
- key 上限为 1,024 UTF-8 bytes，value 上限为 1 MiB，单页 limit 上限为 1,000。
- LIST 不是 Vault 服务端快照。首个分页调用会完成一次 LIST+GET 全量采集，再把不可变结果放入本进程；
  后续 cursor 不再访问 Vault。cursor 一次性使用，默认 60 秒过期，最多同时保留 64 个快照；完成或过期后
  清理。cursor 不能跨进程、跨重启或跨 Store 实例使用。
- 本包只读取自己 version 1 envelope；root 下的外部格式会作为协议错误 fail closed。

## 所有权与凭据

| 资源              | owner    | 生命周期边界                                     |
| ----------------- | -------- | ------------------------------------------------ |
| `vault-fetch`     | 应用     | 仅借用；本包不调用 `close`、`destroy` 或同类能力 |
| `page-snapshot`   | 本包     | 页面完成或 cursor 过期后清理                     |
| Vault KV versions | 业务数据 | 只有显式 delete 创建 deletion marker             |

token 只在最终 Request 边界写入 `X-Vault-Token`，namespace 只写入 `X-Vault-Namespace`；两者都不进入
URL、wire envelope、公共错误 message 或 diagnostics。设置 token 时，Fetch rejection graph 会被替换，
防止 Request/header 经由 `cause` 泄漏。重定向始终拒绝。TLS、代理、连接池与 Fetch 生命周期由应用持有。

Vault 连接、token 和挂载可用性会在首次 CRUD/list 时由真实请求验证，不额外发起探测请求。

## 验证

```sh
bun run --filter @go-like/store-vault typecheck
bun run --filter @go-like/store-vault test:unit:coverage
bun run --filter @go-like/store-vault build
bun run test:e2e:suites -- --suite store-vault-docker
```

Docker 脚本固定面向
`hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54`，
它已真实验证错误 token、root 隔离、CRUD、稳定分页、TTL/CAS fail-closed、精确版本删除与并发写、凭据边界、
远端 root 清理和容器零残留。

官方协议参考：

- https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2
- https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2
- https://releases.hashicorp.com/vault/（2026-07-22 核验最新版本：2.0.3）

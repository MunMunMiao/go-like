# ADR 0006：Store 契约与 Provider 边界

日期：2026-07-21

状态：已接受

## 背景

go-micro 提供通用 Store 与多个后端实现。go-like 也需要承载配置快照、幂等记录和小型服务状态，但不能把
Store 扩张成 ORM、Cache、配置中心或分布式事务门面。不同后端对 TTL、CAS、分页和多写者的保证并不相同，
provider 必须按真实语义实现或在外部副作用前拒绝，不能静默降级。

Store SPI 本身不等于常驻资源。网络 provider 可按调用使用远端资源；只有确实持有目录锁、watcher、session、
lease 或连接的实现才增加结构式 Server 生命周期，且 Context 只能限制一次调用或等待，不能偷偷取消已经接纳的
owner cleanup。

## 决策

### 公共契约

`@go-like/store` 定义：

- `Store` 只定义 CRUD 与诊断名称，不伪造统一 `start/stop`。需要常驻所有权的具体 provider 可额外实现结构式
  `Server`。
- `read`、`write`、`delete`、`list` 的 Context 都是独立首参。
- `StoreRecord` 固定包含 key、detached bytes、不可变 metadata、provider-opaque revision 与可选
  `expiresAt`。
- `WriteOption`、`DeleteOption`、`ListOption` 使用 Go-style functional options；CAS 只比较 opaque
  revision，不解释版本格式。
- list 使用 Unicode code-point 排序和 opaque cursor；provider 必须基于稳定快照继续分页，或在相关数据改变后
  明确拒绝 stale cursor，不能静默重复或遗漏记录。

公共层只提供稳定的 lifecycle 和 conflict error。它不定义 capability negotiation、watch、transaction DSL、query、
index、schema migration、cache stampede 策略或全局默认 Store。

### 不可变性与错误语义

调用方输入的 bytes 和 metadata 在 provider boundary 复制；返回的 bytes 每次属于调用方，不能暴露 provider
内部可变 buffer。key、metadata 和 cursor 在访问外部资源前完成验证。

CAS 失败返回稳定 `StoreConflictError`，同时保留 expected revision 和可观察到的 actual revision。provider
不支持某项 option 时在 I/O 前以标准 `TypeError` 拒绝；数值超出 provider 固定边界时以 `RangeError`
拒绝，不得静默降级成无条件写入。各 provider README 直接记录这些固定边界。凭据、原始请求和响应 body
不进入公共错误或 diagnostics。

### Provider

- `@go-like/store-memory` 为每个实例持有独立进程内 Map，构造后立即可用。它支持 TTL 惰性清理、CAS 和
  code-point 排序；cursor 绑定当前 revision、prefix 与 offset，任一 mutation/expiry 后旧 cursor fail closed。
  provider 不创建 timer、全局 backend 或结构式 Server。
- `@go-like/store-file` 使用应用指定的 filesystem 根目录，实现单进程文件持久化、TTL、CAS 和稳定分页。
  Node filesystem host 位于 runtime-specific provider 内，portable 公共契约不静态引用 `node:`。
  进程崩溃留下的 lock 会 fail closed；provider 不按 PID 猜测并自动抢占。运维确认 owner 已终止并显式移除
  lock 后，启动只读取最后一份完整 checksum snapshot，忽略并在正常停止时清理 crash temp。
- `@go-like/store-consul` 使用注入的标准 Fetch 调用 Consul KV/session HTTP API。CAS 使用 ModifyIndex；TTL
  使用独立 session；不确定写响应必须通过 exact readback 判断。所有 Store 数据和 admission key 都位于
  独占物理 root（默认 `go-like/store`）下；root 外的 Registry、Config 或应用 KV 不参与解码与分页。
- `@go-like/store-etcd` 使用注入的标准 Fetch 调用 etcd v3 JSON gateway。revision 保持 provider-opaque；
  CAS 使用 transaction；TTL 使用 lease，并在 stop 时撤销本 owner 的 lease。
- `@go-like/store-vault` 使用注入的标准 Fetch 调用 Vault KV v2。逻辑 key 编码到独占 root 下的单层物理
  keyspace；TTL 与统一 write/delete CAS 均 fail closed。delete 只 soft-delete 已读取的精确 version；分页首页
  完整物化一次 LIST+GET 快照，后续一次性 cursor 只读取有上限、可过期、stop 时清理的进程内快照。

每个 provider 单独发布、单独声明 runtime 与所有权；公共 Store 不依赖任何供应商 SDK。

### 生命周期所有权

- 应用拥有配置值、注入的 Fetch、TLS/代理、文件根目录选择和外部服务进程。
- Store 只拥有自身已经接纳的 session、lease、timer 和临时资源。
- 只有声明常驻生命周期的 provider 才要求 `start(ctx)` 后执行 CRUD，并由 `stop(ctx)` 启动唯一 cleanup；
  构造即用的 memory、Consul、etcd 与 Vault provider 不制造空生命周期。
- 对有 owner cleanup 的 provider，caller Context 取消只结束当前等待，owner cleanup 仍由 `start()` 返回的
  Promise 表示。

## 验证要求

所有 provider 必须复用仓库内部的 provider-neutral conformance，并补充实现特有的协议测试；conformance
不是用户 API，也不进入 `@go-like/store` 的发布导出。
外部服务测试必须使用固定 digest 的真实容器，覆盖 CRUD、排序、分页、CAS、TTL、停止、重启、故障恢复、
凭据边界和零残留。File provider 必须在 Node 上使用真实临时目录，并证明关闭后 watcher、timer 与文件句柄归零。
纯内存 provider 不启动无意义容器；它使用确定性 clock、完整 conformance 和发布态 Bun/Node/Deno 验证。

## 后果

go-like 获得了与 go-micro Store 同角色的基础能力，同时不会把不同后端伪装成完全相同。应用按 README
记录的固定语义选择 provider，并能在不改变业务调用形态的前提下替换实现。Cache、ORM、配置 watch 和分布式事务仍是独立
能力，不能借 Store 名义偷偷并入。

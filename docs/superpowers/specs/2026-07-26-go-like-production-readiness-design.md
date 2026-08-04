# go-like 生产就绪加固设计

日期：2026-07-26

状态：已批准执行

范围：当前 `main` 工作区；不创建 worktree，不提交，不推送，不发布。

## 1. 目标

本轮在不扩大 go-like v1 产品边界的前提下，修复已经由源码、独立复现或真实服务证明的生产风险：

1. Core 生命周期可能被不合作 Promise 永久阻塞；
2. Config 与 Registry 的后台终态故障缺少及时、可编排的通知通道；
3. Client 的 idle transport owner 没有全局容量和真实时间上限；
4. RabbitMQ 发布完成不代表 broker confirm；
5. Redis 只承接单 URL client，无法使用 node-redis 已有的 TLS、Sentinel 和 Cluster 能力；
6. completion 日志和 span 可能复制原始 Error 内容；
7. 当前 release、真实故障测试和长时间运行证据不足以支持生产级声明。

既定产品边界保持不变：标准 Web API、Go 风格小接口与 functional options、结构式 Server、外部 Web 与内部
Transport 分离、Registry provider 集合冻结、无 gRPC/Proto、无 Event Store/replay。

## 2. 设计原则

go-like 的约束是“对外像 Go，对内尊重 TypeScript，底层交给原生库，交付依靠真实证据”。

- 对齐 go-micro、go-kratos 的角色、命名和组合方式，不机械翻译 goroutine 实现；
- Context 和 AbortSignal 只提供协作式取消，不能虚构任意 Promise 已经终止；
- 每个 resident resource 只有一个 owner drain，caller Context 只限制自己的等待；
- 原生 SDK 已经解决的协议与拓扑直接承接，不复制供应商配置面；
- 默认保护数据和敏感信息，性能逃生口必须显式；
- 只实现有复现或上游证据支撑的能力，不为推测性需求增加抽象。

## 3. 调研与实验证据

### 3.1 上游基线

| 项目 | 版本或提交 | 结论用途 |
| --- | --- | --- |
| go-kratos | `v3.0.0` / `668db92c2c001e9552594ba5a8aede8456af6d7e` | App、Registrar、HTTP/gRPC graceful-to-force |
| go-micro | `v6.8.0` / `db4401d306039be2614e0e3657c6a5c6473feb3b` | Service lifecycle、Client pool、Registry refresh、Rabbit confirm |
| Node.js | LTS `v24.18.0`、Current `v26.5.0` | AbortSignal、HTTP connection force close、signal semantics |
| Fastify | `v5.10.0` | closing admission 与 native shutdown 顺序 |
| chokidar | `v5.0.0` | one-owner close 与 terminal notification |
| Kubernetes | `v1.36.3` | startup/readiness/liveness、30 秒默认 termination grace |
| Undici | `v8.9.0` | per-origin pool、`maxOrigins`、connection/TTL 边界 |
| amqplib | `2.0.1` | ConfirmChannel、recovery generation、pending confirm cleanup |
| node-redis | `6.1.0` | URL、TLS、Sentinel、Cluster、command AbortSignal |
| Grafana k6 | `v2.1.0` | 固定负载和长时间 HTTP 运行证据 |

### 3.2 当前代码与真实运行

- Core/Config 定向基线为 `55 pass / 0 fail`，但未覆盖不合作 Promise。
- `stopTimeout(5)` 下，永不 settle 的 `Server.stop()` 会令 `stop()` 与 `run()` 永久 pending。
- `registrarTimeout(5)` 下，忽略 Context 的 Registrar 会令生命周期永久 pending。
- `Server.stop()` 已完成但 `Server.start()` 永不 terminal 时，`stop()` 完成而 `run()` 永久 pending。
- RabbitMQ `4.3.4` Docker 基线通过发布订阅、手动 ack、consumer recovery 与 owner cleanup，但没有 publisher confirm 证据。
- Redis `8.8.1` Docker 基线通过 5 项 Cache conformance、二进制值、协议错误和 owner cleanup，但没有 TLS、Sentinel、Cluster 证据。
- 两项 Docker 基线完成后，指定 owner label 下残留容器为零。
- 当前 `main` HEAD 为 `078e24c3b6ebc9228968acf3489cddc7e552b0c4`；`origin` 存在但未配置 upstream；
  `.github`、`packages`、`examples`、`e2e` 与 `scripts/published` 在 HEAD 中的 tracked file 总数为零。

## 4. 决策

### 4.1 Core lifecycle

新增 `startTimeout(milliseconds)` AppOption，默认 `0`。它只限制 startup admission：`beforeStart`、endpoint
准备、register 和 `afterStart`；`Server.start()` 仍可代表长期运行直到 terminal，不能作为 readiness Promise 等待。

强化现有 `stopTimeout(milliseconds)`：第一次 `App.stop()` 认领时创建一个绝对 deadline，覆盖 startup join、
`beforeStop`、deregister、所有 `Server.stop()`、所有 `Server.start()` terminal join 和 `afterStop`。每个阶段只使用
剩余预算，不能重新获得一份完整 timeout。

deadline 到达时：

- 尚未调用的必要 cleanup 仍精确调用一次，并接收已经 terminal 的 Context；
- App 不再等待不合作 Promise，以现有 `deadlineExceeded` 结算；
- 所有迟到 resolve/reject 继续被观察，不产生 `unhandledRejection`；
- 返回 timeout 只表示无法在预算内证明 terminal，不表示资源已经关闭；
- 原生 Server 如 Node HTTP 继续在 adapter 内执行 graceful-to-force；Core 不调用 `process.exit()`。

`registrarTimeout` 使用现有 `waitForContext` 限制 caller wait。若 register 在 timeout 或 stop 之后迟到成功，Core
对同一 ServiceInstance 启动一次 best-effort 补偿 deregister；迟到失败只被观察，不能改变已结算结果。

Node signal adapter 第一次收到信号时设置退出码、同步移除自身 listeners 并请求 `App.stop()`；第二次相同或其他
已选择信号恢复 Node 默认终止行为，避免卡死 shutdown 吞掉人工强退。

### 4.2 Config terminal

新增：

```ts
export type ConfigTerminalErrorHandler = (error: Error) => void | PromiseLike<void>
export function onTerminalError(handler: ConfigTerminalErrorHandler): ConfigOption
```

成功 load 后第一次不可恢复后台错误，在 owner drain 之前同步调用一次 handler。传入值与以后 `close()` 返回的主
错误保持相同 Error identity。handler 抛出或 rejected thenable 被观察并隔离，不替换 Config 主错误。

`onReloadError` 继续只表示可恢复 reload 失败；last-good 配置继续可读。`close(ctx)` 继续 join 真实 owner drain；
短 caller 超时不取消 drain。Config 不变成 Server，不增加必选 `done()`，也不反向依赖 Health。

### 4.3 Registry renewal terminal

保持 Registrar、Discovery、Registry 和 Watcher SPI 不变。共享 provider options 增加：

```ts
export type RegistrationErrorHandler = (
  error: Error,
  service: ServiceInstance
) => void | PromiseLike<void>
```

Consul、etcd、ZooKeeper 与 mDNS 每个 registration generation 在永久 heartbeat/session/socket failure 后：先将该
generation 标记 inactive，再调用 `onRegistrationError` 一次。retryable failure 继续执行现有 backoff 和安全日志；
callback 失败不能改变 provider 状态。Kubernetes Registrar 没有 resident renewal，接受公共 option 但不虚构回调。

不增加新的 Registry provider，不让 Core 持有 TTL/refresh loop，不重新引入 registration handle。

### 4.4 Client idle pool

新增 lower-camel ClientOption：

```ts
export function poolSize(maxIdle: number): ClientOption
export function poolTtl(milliseconds: number): ClientOption
```

默认分别为 `100` 和 `60_000`，参考 go-micro 的心智模型，但 `poolSize` 明确定义为整个 Client 的全局 idle owner
上限，而不是每个历史 address 的上限。`poolSize(0)` 禁用 idle reuse；`poolTtl(0)` 禁用时间过期但仍受 size 限制。

每个进入 idle 的 owner 使用标准 timer 主动到期；acquire、close 或 eviction 必须清理 timer。Map 插入顺序作为
最小 LRU，超过上限关闭最老 idle owner。active owner 不被强制回收，release 时再应用容量和 TTL。

不增加通用并发 semaphore、请求队列或 Transport multiplexing 接口；当前证据只证明 persistent idle owner 无界。

### 4.5 RabbitMQ publisher confirm

`newRabbitMqBroker(Channel)` 保持 borrowed plain Channel 语义：返回值只表示 amqplib flow control。新增显式
`newConfirmRabbitMqBroker(ConfirmChannel)`；它保留 boolean 结果，但 Promise 仅在该 publish 的 confirm callback
ack 后 resolve，nack 或 channel close 时 reject。

`newRecoveringRabbitMqBroker` 是 go-like-owned canonical 路径，每个 recovery generation 默认创建 ConfirmChannel，
因此其 `await publish()` 表示 broker confirm。Context 可以放弃等待，但迟到 confirm 必须继续被观察。

Publisher confirm 不承诺 exactly-once；关键业务仍使用应用层幂等或 outbox。

### 4.6 Redis native client

`newRedisCache` 保留 `{ url }` 快捷模式，并增加与之互斥的 dormant native client factory 模式。factory 返回
node-redis 官方 Client、Cluster 或 Sentinel 的公共命令能力；go-like 在 `start()` 时 connect，在 `stop()` 时
close，失败时 destroy，并继续通过 command options 传递 Context AbortSignal 和 command timeout。

go-like 不复制 node-redis 的 TLS、credentials、reconnect、Sentinel 或 Cluster option surface，也不新增
`newRedisClusterCache` 等门面。真实 Docker gate 覆盖：单节点 TLS/auth、Sentinel failover、Cluster slot routing
和 primary failover。

### 4.7 Observability redaction

Pino、Winston 与 OTel completion instrumentation 默认仅发布：

- 有界且格式合法的 `errorType`；
- 可选的低基数 `errorCode`；
- 现有 component、operation、outcome、duration 和 HTTP status。

原始 message、stack、cause、请求体、响应体和 header 均不得进入 completion record。OTel 不再对业务 Error 调用
`recordException(value)`；只设置 error status 与安全 attributes。v1 不增加 raw-error opt-in，应用可在自己的 native
logger/tracer 边界显式记录。

### 4.8 Release 与长时间证据

首先要求真实实现进入 Git、`main` upstream 指向 `origin/main`，并从 clean checkout 运行 CI。该外部状态修改需要
单独授权，本轮只实现仓库内门禁。

新增手动 release workflow：GitHub-hosted runner、environment approval、`id-token: write`、固定 Action SHA、
精确 Bun/Node/npm、frozen install、完整 verify、build、Changesets publish 和 npm provenance；不使用长期 npm token。

新增非 PR 的 scheduled/manual soak：固定摘要 k6 运行标准 Web HTTP，内部 Client probe 记录 dial/session reuse；保存
延迟、错误、RSS、heap、FD/handle 和 cleanup JSON。release candidate 至少完成 60 分钟 steady-state、shutdown under
load、endpoint churn、Rabbit confirm interruption 与 Redis failover。硬门禁是不出现意外错误、未处理 rejection、
资源残留或无界单调增长；不设置脱离硬件的统一 RPS 数字。

## 5. 明确排除

- 不创建 worktree、feature branch 或本轮提交；
- 不发布 npm、不修改 npm organization 或 GitHub branch protection；
- 不增加 Registry provider、gRPC、Proto、Event Store、历史查询或 replay；
- 不增加全局 Service、AppHandle、AppStatusSource、第二套 runner 或 logger facade；
- 不承诺 RabbitMQ exactly-once；
- 不复制 Redis topology 配置；
- 不把 nightly soak 塞进每个 PR 的同步 verify。

## 6. 完成标准

1. 每项 production behavior 都有先红后绿的定向测试；
2. RabbitMQ 与 Redis 新能力使用固定版本、固定摘要真实 Docker 验证；
3. Bun、Node、Deno published runtime/type matrix 保持通过；
4. `bun run verify` 从 clean checkout 退出 0；
5. Docker container、network、volume 与 go-like 子进程全部回读为零残留；
6. release workflow 不含长期 npm token，并生成 provenance；
7. 60 分钟 soak 证据保存精确版本、命令、环境与结果；
8. 未完成 Git baseline、hosted CI 与一次真实 pilot 前，只能称为 production-ready candidate，不能称为
   production-proven。

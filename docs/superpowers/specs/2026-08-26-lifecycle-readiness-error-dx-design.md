# go-like 生命周期、就绪与错误 DX 优化设计

日期：2026-08-26

状态：已实施；最终交付以全库门禁和整分支独立审查为准

范围：实现记录覆盖当前集成分支；提交与推送已由主人另行明确授权，不包含发布或部署。

## 1. 背景与结论

40 个实践项目暴露的主要问题不是 go-like 缺少另一套生命周期 API，而是相邻概念的说明不够严格：

- `Endpointer.endpoint()`、`Server.start()`、`afterStart`、readiness 和任务完成状态容易被读成同一种“ready”；
- `/livez`、`/readyz` 是可选的 HTTP 投影，但文档容易让非 HTTP worker 和 cron 用户误以为必须启动 HTTP；
- Kubernetes readiness 只影响 Service 流量，不会自动暂停 BullMQ、NATS 或其他 broker consumer；
- 公开错误的稳定判别方式、重试原则、`AggregateError` 和 `cause` 策略散落在类型与 package README 中；
- File Store 与 HTTP 的四个归一化边界会为非 `Error` rejection 生成安全固定消息，但丢失原始诊断原因。

因此本轮采用最小方案：**不新增公共生命周期能力，先修正心智模型和错误参考，再统一四个已确认的错误归一化边界。** 生命周期/readiness 澄清与主人明确要求的“错误整理”是两个独立交付阶段，分别验证、分别提交；执行其中一个不隐含授权另一个。

## 2. 已确认的当前契约

### 2.1 生命周期与健康

- Core 只有结构式 `Server.start(ctx)` / `Server.stop(ctx)` 与 `App.run()` / `App.stop()`；它不是依赖容器或第二套 runner。
- `Server.start()` 可以在接纳后返回，也可以覆盖完整运行期；Core 不把它当作 readiness Promise。
- `afterStart` 只表示 Core 已经调用 Servers、完成已配置的 endpoint/registration 阶段并进入该 hook；没有 registrar 时不暗示存在地址注册。只有 hook 自己等待了明确的接纳证据时，它才可发布对应证据。
- `Endpointer` 只用于可发现、可注册、可寻址的服务地址。worker、cron、Store 和普通 broker subscriber 不应伪造 endpoint。
- `@go-like/health` 的 `ProbeRegistry` 是协议无关的检查注册表；`@go-like/web/health` 才把结果投影为 `/livez` 和 `/readyz`。
- 空 liveness 通过，空 readiness fail closed；应用必须显式安装 route 或管理 listener。

### 2.2 平台语义

Kubernetes readiness 失败会让 Pod 从 Service 后端移除，但不会暂停 broker consumer。BullMQ 的本地 pause 才会阻止该 Worker 领取新任务；已运行任务如何排空由 BullMQ 的原生契约决定。Kubernetes CronJob 负责按计划创建 Job，Job/Pod 的成功或失败应由退出状态和 Job condition 表达，而不是长期 readiness。

systemd 的 `READY=1` 和 watchdog 是 supervisor 协议，不是 go-like 应复制的通用探针 API。只有出现经过验证的 systemd adapter 需求时，才应在 runtime/provider package 中增加窄适配器。

权威参考：

- [Kubernetes liveness, readiness and startup probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
- [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [BullMQ pausing queues and workers](https://docs.bullmq.io/guide/workers/pausing-queues)
- [systemd `sd_notify`](https://cgit.freedesktop.org/systemd/systemd/tree/man/sd_notify.xml?id=565a9388f261c6e459e1726e358284ff687ec941)

## 3. 信号模型

文档必须把以下五类事实分开：

| 信号                       | 回答的问题                          | go-like 表达                                                     | 不代表什么                       |
| -------------------------- | ----------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| Address discovery          | 其他服务到哪里调用它？              | 显式 `endpoint(...)` 或网络 Server 的 `Endpointer.endpoint(ctx)` | 进程健康、依赖健康、任务成功     |
| Process liveness           | supervisor 是否应认为进程仍有进展？ | `ProbeRegistry.check(ctx, "live")`，可选 HTTP 投影               | 业务流量或队列任务可接纳         |
| Work admission / readiness | 当前实例是否愿意接收下一份工作？    | 应用定义的 ready probes；协议管理能力负责实际摘流                | 已运行任务成功、远端依赖永久健康 |
| Work outcome               | 某次请求、消息或 job 是否完成？     | handler/processor 结果、ack/nack、退出码、Job condition          | 进程长期健康或下一份工作可接纳   |
| Progress / telemetry       | 常驻进程最近是否有活动或异常？      | metrics、logs、traces、应用 heartbeat；平台 watchdog 可选        | 可发现地址或业务完成承诺         |

`/livez` 和 `/readyz` 只是 process liveness 与 work admission 的 HTTP 表达，不是新的业务数据面。同一 listener 若先启动 health route，业务 route 仍必须在 readiness 通过前 fail closed，不能把 early bind 当作接纳。

## 4. 工作负载决策表

| 工作负载                       | 接纳证据                                                   | 健康表达                                                 | 停止接收新工作                                                                                              | 完成表达                                         |
| ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| HTTP/内部 unary 服务           | listener 已 bind，注册地址可实际取得，必要依赖满足应用策略 | 可安装 `/livez`、`/readyz`；Service 可用 readiness 摘流  | listener/registrar 的 stop 与 deregister                                                                    | 请求结果                                         |
| 常驻 BullMQ/NATS/Broker worker | native Worker ready+run 或 subscription 已接纳             | 可直接调用 `ProbeRegistry.check`；管理 HTTP 是应用可选项 | 应用请求 App/Server stop，adapter 再调用其拥有的 native pause/unsubscribe/drain/close；readiness 本身不摘流 | processor/handler 结果与 native settlement       |
| 常驻 Croner scheduler          | paused jobs 校验后已 resume，仍有未来调度                  | ready 至多表示 scheduler 和必要配置已接纳                | 应用请求 App/Server stop，adapter 阻止未来调度；不虚构 callback drain                                       | 每次 callback 自己的结果、日志和指标             |
| Kubernetes Job/CronJob         | 新进程开始一次明确工作                                     | 通常不需要长期 readiness；必要时只做有限执行期诊断       | controller、deadline、signal 和进程退出                                                                     | 退出码、Job `Complete`/`Failed`、重试与 deadline |

## 5. 文档信息架构

English `doc/` 继续作为唯一 canonical 文档，本轮不复制八套 locale：

1. `doc/guide/health-observability.md` 持有信号模型、工作负载决策表和 management/data plane 说明；
2. `doc/guide/architecture.md` 精确定义 `Endpointer` 和 `afterStart`；
3. `doc/guide/getting-started.md` 保留 Web 黄金路径，但明确示例 marker 只证明该 Web endpoint；
4. `doc/guide/broker-events.md` 只保留 worker/cron 的短摘要并链接 canonical health 章节；
5. package README 只写与本包直接相关的一段，不复制整张矩阵；
6. 新增 `doc/reference/errors.md`，只加入 English canonical reference navigation。

## 6. 错误模型

### 6.1 稳定判别方式

| 类别                       | 稳定判别                                                                            | 调用方原则                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Context cancellation       | 与导出的 `canceled` / `deadlineExceeded` sentinel identity 比较，或读取 `ctx.err()` | 自定义 cause 通过 `cause(ctx)` 读取；不要匹配 message                                   |
| Service failure            | `isServiceError(value)`，再读取业务 `code`、`status`、`metadata`                    | wire 边界只传播 branded ServiceError；未知服务端错误保持固定内部错误                    |
| Framework structural error | 读取公开类型承诺的 `code: "GO_LIKE_*"`                                              | 按具体 code 分支，不按 class 或 message 分支                                            |
| Programmer error           | `TypeError` / `RangeError`                                                          | 修复调用、选项或契约，不自动重试                                                        |
| Multiple failures          | `AggregateError`，遍历全部 `errors`                                                 | 只有相应 package 明确声明时才把第一项解释为 primary/cause；不得只记录 aggregate message |
| Native/upstream error      | 保留原始 `Error` identity                                                           | 由 provider/runtime 文档决定是否可重试                                                  |

错误参考页把 code 分成两层：公开结构类型声明的 `GO_LIKE_*` 是稳定判别契约；只存在于运行时 source literal、没有公开类型承诺的 code 单列为非稳定诊断，不允许调用方据此分支。每个稳定 code 组提供：来源、语义、是否适合重试、调用方动作、安全/可观测性注意事项。

### 6.2 `cause` 与脱敏

- 已经是 `Error` 的 rejection 保留 identity、name、message、code 和原有 cause。
- application/native lifecycle boundary 抛出非 `Error` 值时，生成固定安全 message，并以标准非枚举 `Error.cause` 保留原始值；不得字符串化、深拷贝或写入 wire。
- 本轮只修复 File Store 与 HTTP 四个已经确认的不一致入口，不新增共享 helper。
- Config/Registry 等明确标记为 secret-bearing 或 untrusted 的边界继续保留当前“固定消息且不持有原值”策略；不能用全局规则覆盖它们。
- go-like 的 Pino/Winston/OTel completion fields 不记录 raw message、stack 或 cause。`TransportLogger` 是应用提供的诊断边界，会收到本地 Error；应用若递归序列化其 cause，必须自行脱敏。

## 7. 最小代码改动

只修改以下四个私有归一化函数：

```ts
// packages/store/file/src/store.ts
// packages/store/file/src/node-host.ts
return value instanceof Error ? value : Object.freeze(new Error(message, { cause: value }))

// packages/transport/http/src/errors.ts
// packages/transport/http/src/node-client.ts
return isError(value) ? value : new Error(message, { cause: value })
```

每个独立 helper 留一个最小回归断言：固定 message、`cause` identity 和原有 cleanup/queue 行为不变。HTTP 的共享 normalizer 不为所有调用点复制测试；另保留一份 wire 脱敏回归。

## 8. 明确排除

- 不新增 `ready()`、`done()`、`admitted()`、`Worker`、`Job` 或 heartbeat 公共接口；
- 不让 worker、cron、Store 或 Broker 伪造 `Endpointer`；
- 不自动启动 management HTTP server，也不自动安装 `/livez`、`/readyz`；
- 不新增全局 Error 基类、Error enum、retry engine 或日志 facade；
- 不修改 Config/Registry 的有意脱敏边界；
- 不增加依赖、example 项目、Kubernetes manifest、systemd adapter 或新的 docs 插件；
- 不在本轮批量翻译 locale 文档；
- 不重跑或覆盖 40 个项目的历史实验记录。

## 9. 完成标准

1. 用户能从一张表判断自己的工作负载是否需要 endpoint、probe、management HTTP 和 completion signal；
2. 文档不再把 HTTP `503`、`afterStart`、TCP accept 或 Docker published port 写成业务 readiness；
3. Kubernetes readiness 不会被描述成 worker pause/unsubscribe；
4. `doc/reference/errors.md` 覆盖全部公开结构类型声明的 `GO_LIKE_*` code，并把 source-only code 明确标成非稳定诊断；
5. 四个归一化 helper 对非 `Error` 值保留标准 cause，原有 Error identity、固定 message 和 cleanup 行为不变；
6. 定向测试、两个受影响 package 的 typecheck/unit/build、全库 unit/typecheck/build、格式与文档构建全部退出 0；
7. 工作区差异只包含本设计列出的文件；提交与推送只在取得明确授权后执行。

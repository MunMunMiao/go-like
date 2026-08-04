# 批量报表运行时示例设计

> 状态：可执行基线。2026-07-23 已通过类型检查、业务单测、Bun 原生覆盖率报告和固定 digest Redis Docker E2E。

本示例定义一个可落地的单实例批量报表服务：Croner 负责按固定 UTC 触发调度，BullMQ 与 Redis 负责持久队列、
重试和 stalled job 恢复，`@go-like/store-file` 保存本地 checkpoint，go-like 负责各常驻资源的显式生命周期。

该方案按“任务可能重复执行”设计，不承诺 exactly-once，也不引入工作流引擎。

## 直接运行

先启动真实 Redis，再直接启动调度、Worker 与 checkpoint 组成的小程序：

```bash
docker compose -f examples/batch-reporting/compose.yaml up -d --wait
bun run --filter @go-like/example-batch-reporting start
```

程序默认连接 `redis://127.0.0.1:46379`，每 10 秒检查一次已关闭窗口，并把 checkpoint 写入
`.artifacts/checkpoints`。可用 `REDIS_URL`、`CRON_SCHEDULE`、`CHECKPOINT_DIR`、`QUEUE_NAME` 和
`QUEUE_PREFIX` 覆盖。结束后执行：

```bash
docker compose -f examples/batch-reporting/compose.yaml down
```

## 用户角色

| 角色       | 关心的问题                                                                  |
| ---------- | --------------------------------------------------------------------------- |
| 报表负责人 | 每个已关闭报表窗口最终产出一份可识别、可重跑的结果。                        |
| 数据工程师 | 窗口边界、输入快照、输出提交和 checkpoint 推进规则明确。                    |
| 平台运维   | Redis、进程、持久卷故障后能判断是否可恢复，并能安全停机。                   |
| 开发者     | 直接使用 Croner、BullMQ 与 go-like 的真实 API，不维护第二套调度或队列抽象。 |

## 业务目标

- 按显式固定 UTC 为已经完整关闭的时间窗口生成报表。
- 服务短暂停机或 Redis 暂时不可用后，从最后一个已提交 checkpoint 继续补齐窗口。
- 对同一窗口的重复调度、原生 retry 和 stalled recovery 保持同一个业务 identity。
- 只有报表结果已经持久提交后才推进 checkpoint；失败窗口保持可见并阻断后续窗口。
- 关停时先停止新调度，再排空 Worker，最后关闭 Queue 与 checkpoint Store。

基线刻意限制为一个应用实例、一个报表序列、同一时间最多一个逻辑窗口在途。该约束让单文件 checkpoint
保持诚实；需要多副本或并行报表流时，应改用共享协调存储，而不是让多个进程争写同一文件。

## 架构

```text
                         application process
  Croner tick / startup reconciliation
                  |
                  v
        scheduler admission barrier
                  |
                  v
       BullMQ Queue ---------> Redis
                  |              |
                  v              | lock / retry / stalled state
        BullMQ Worker <----------+
                  |
          read source snapshot
                  |
          publish report result
                  |
                  v
       @go-like/store-file checkpoint
          on persistent volume
```

Croner、Queue、Worker 和 Store 都保留各自的原生职责。go-like 不定义 job schema、不代理 processor，也不把
Queue 的生命周期错误地转交给 Worker adapter。

### 请求与数据流

1. 启动时，应用打开 File Store，读取 `lastCommittedWindow`，计算最早尚未完成且已经关闭的窗口。
2. 启动 reconciliation 与每次 Croner tick 都只调用同一个 `enqueueNextClosedWindow` 业务函数。
3. 该函数用规范化 UTC 窗口生成确定性 BullMQ `jobId`，例如 `report-20260722T000000Z`，并只入队下一个窗口。
   job payload 只携带窗口和报表版本等业务标识，不携带凭据。
4. Redis 已保留相同 `jobId` 时，BullMQ 的原生去重避免再创建一条并行 job。该去重只在原生 job 仍被保留时有效。
5. Worker 以 `concurrency: 1` 处理 job。processor 再次读取 checkpoint；已经提交的窗口直接返回成功。
6. processor 读取该窗口的输入快照，把结果写入确定性目标键或支持幂等 upsert 的下游，并等待下游确认持久提交。
7. 只有第 6 步成功后，processor 才把 checkpoint 原子推进到当前窗口；随后可触发下一次
   `enqueueNextClosedWindow`，逐个补齐积压窗口。
8. 如果进程在结果提交后、checkpoint 提交前崩溃，同一 job 会再次执行。下游幂等写是收敛该间隙的必要条件；
   文件 checkpoint 与 Redis 之间不存在分布式事务。

### 三层去重

| 层                    | 作用                                              | 明确边界                                           |
| --------------------- | ------------------------------------------------- | -------------------------------------------------- |
| 确定性 `jobId`        | 抑制 Redis 中同一保留 job 的重复入队。            | job 被删除后不再提供历史去重。                     |
| File Store checkpoint | 已完成窗口再次进入 processor 时快速跳过。         | 只适用于该单 owner 报表序列。                      |
| 幂等输出键或 upsert   | 收敛“输出成功、checkpoint 尚未提交”时的重复执行。 | 由报表下游提供，不是 BullMQ 的 exactly-once 保证。 |

### 实现目录

```text
src/
├── report-window.ts   # UTC 窗口和值对象
├── checkpoint.ts      # Store 读写边界
├── scheduler.ts       # 下一窗口调度
├── processor.ts       # 发布与 checkpoint 提交
└── main.ts            # 创建 Redis、Queue、Worker、Croner 并直接启动
```

## go-like 包映射

| 包                                                  | 在本示例中的职责                                             | 不负责的内容                                                              |
| --------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `@go-like/context`                                  | 为启动、停止和 Store 操作提供取消与 deadline。               | 不替代 BullMQ processor 的原生 `AbortSignal`。                            |
| `@go-like/croner`                                   | 接管应用创建的 paused Croner job 的启动与停止。              | cron 表达式、timezone、overlap 和活动回调排空仍归应用/Croner。            |
| `@go-like/bullmq`                                   | 接管官方 Worker 的 ready、run、pause、cancel、close 与终态。 | Queue、processor、attempts、backoff、jobId 和 stalled 参数归应用/BullMQ。 |
| `@go-like/store`                                    | 提供 Context-first Store 契约。                              | 不提供事务 DSL 或分布式协调。                                             |
| `@go-like/store-file` 与 `@go-like/store-file/node` | 用 checksum 快照、临时文件和原子 rename 保存 checkpoint。    | 不支持跨进程 shared writers。                                             |

Queue 仍是 application-owned。本示例的编排代码在 Worker 终止后直接调用 `queue.close()`，不为它新增通用框架
包。Croner callback 的在途 `queue.add()` 由应用内 admission barrier 跟踪，
因为 `@go-like/croner` 能停止后续调度，但 Croner 原生 `stop()` 不会等待已经运行的 callback。

## 生产不变量

1. 当前基线固定使用 UTC 计算窗口和 job identity；只有真实业务要求非 UTC 日界线时，才增加时区参数及夏令时测试。
2. 同一 checkpoint 目录只能有一个存活 owner，应用只能运行一个副本，目录必须位于持久卷而不是容器临时层。
3. 不自动删除 `.go-like-store.lock`。进程异常退出后，运维必须先确认旧 owner 已死亡，再按恢复手册移除 stale lock。
4. 任意时刻只允许一个逻辑窗口在途；后续窗口不能越过失败窗口推进 checkpoint。
5. checkpoint 只能在报表输出得到持久成功确认后推进，不能在调度、入队、开始处理或仅写临时文件时推进。
6. 输出必须使用确定性键或幂等 upsert。任何邮件、Webhook 等不可幂等副作用必须另有业务去重凭据。
7. Queue、Worker 必须使用相同 queue name、prefix 和 Redis 连接策略；应用不得直接改写 BullMQ 管理的 Redis key。
8. Redis 必须禁用会逐出队列 key 的内存策略，并按业务恢复目标配置持久化、备份与容量告警。
9. production job 明确配置有限 `attempts`、有界 backoff、`lockDuration`、`stalledInterval` 与
   `maxStalledCount`；具体数值以最长正常处理时间和故障演练结果为依据，不从测试的短超时照抄。
10. processor 必须允许事件循环续租 lock，并观察 BullMQ 传入的原生 `AbortSignal`；CPU 密集计算应移出主事件循环。
11. 最终失败 job 默认保留并告警。修复输入或代码后由运维显式 retry；不能静默删除失败 job 并跳到下一窗口。
12. completed job 的保留周期只是可观测与第一层去重窗口；即使清理历史 job，checkpoint 与下游幂等性仍必须成立。
13. Redis outage 的普通 Worker `error` event 不等于 Worker terminal；应用必须记录并告警，BullMQ 负责原生重连。
14. 任何 stop timeout 都不得记录为“优雅关闭成功”；`start(ctx)` 返回的 Promise 未到真实终态时必须由应用编排层报告。

## 重试、stalled 恢复与关停顺序

### 重试与 stalled

- `Queue.add` 使用 BullMQ 原生 `attempts` 与 backoff；processor 通过 rejection 表达本次 attempt 失败。
- retry 与 stalled recovery 始终复用同一 job identity，checkpoint 在最终业务成功前保持不变。
- Worker 丢失 lock 后，由 BullMQ 的 stalled 检测把 job 恢复为可处理状态；超过 `maxStalledCount` 后进入 failed，
  由告警和人工处置接管。
- stalled recovery 证明的是“job 会再次获得处理机会”，不是“processor 副作用只发生一次”。

### 关停

本示例的 E2E 按依赖到消费者显式启动 File Store → Queue owner → BullMQ Worker → scheduler，并按相反顺序关停：

1. scheduler 关闭 admission，停止 Croner 的未来 tick，并等待已接纳的 `queue.add()` barrier。
2. `@go-like/bullmq` 调用 `pause(false)` 停止新 job admission，并等待 active processor。
3. Worker 在 hard drain 边界内未结束时，adapter 调用原生 `cancelAllJobs(reason)`；processor 从原生 signal 观察取消。
4. 等待唯一 `close(true)` 与 Worker `closed` 真实终态；pending `start(ctx)` Promise 不能被伪装成关闭完成。
5. application-owned Queue 在 Worker 终止后执行 `queue.close()`。
6. File Store 最后停止并清理正常运行产生的临时文件；Redis 是外部服务，不由应用停机流程关闭。

## 故障场景

| 场景                                        | 预期行为                                                                  | 操作要求                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Croner 重复 tick 或重启 reconciliation 重叠 | 相同窗口生成相同 `jobId`；只有一个逻辑窗口在途。                          | 观察重复调度计数，但不推进 checkpoint。                                |
| processor 暂时失败                          | BullMQ 按有限 attempts/backoff 重试，checkpoint 不变。                    | 最终成功后才提交；耗尽后保留 failed job 并告警。                       |
| Worker 在 active job 中崩溃                 | lock 到期后由 BullMQ stalled 机制重新交付，副作用可能重复。               | 确认输出幂等；硬崩溃若遗留 File Store lock，先确认旧进程已死亡再清理。 |
| Redis 暂时不可用                            | enqueue 失败；Worker 报错并尝试原生重连；File Store 保留 last committed。 | Redis 恢复后由同一 next-window reconciliation 补入队。                 |
| 报表已发布、checkpoint 写入前崩溃           | 同一窗口重跑。                                                            | 下游以确定性键返回已有结果或执行幂等覆盖。                             |
| checkpoint checksum/lock 不合法             | File Store 启动 fail closed，Worker 和 scheduler 不启动。                 | 保留现场，按备份和 owner 证据恢复，禁止跳过到较新窗口。                |
| job 永久失败                                | 后续窗口不越过该窗口。                                                    | 修复后显式 retry；若业务决定跳过，必须形成独立审计记录。               |
| processor 不响应取消                        | adapter 发出原生取消，`start(ctx)` Promise 继续等待真实终态。             | 应用编排层报告未终止资源；不得把超时退出当作业务完成。                 |

## 真实 Docker 服务与版本策略

本示例的真实外部服务只有 Redis；Croner、BullMQ Worker 与 File Store 都运行在应用进程内。

| 组件             | 当前仓库真实 pin                                                                                                 | 用途                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Redis            | `redis:8.10.0-alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241`，E2E 回读为 8.10.0 | BullMQ queue、lock、retry 与 stalled 状态。 |
| BullMQ           | `6.0.6`（默认 Redis adapter 使用 `ioredis` `6.0.0`）                                                             | Queue 与 Worker 原生数据面。                |
| Croner           | `10.0.1`                                                                                                         | 定时调度。                                  |
| go-like packages | workspace `0.0.1`                                                                                                | 生命周期与 checkpoint provider。            |

实现时默认复用上述仓库 pin。若实施日期已经需要升级，则先从 npm 官方 dist-tag 与官方镜像 registry 重新核实
`latest`，再同时固定精确 package version 和不可变 image digest，并 fresh 读取容器内版本；Compose 不使用浮动
`latest` 或仅 tag 引用。Redis 8 的许可选择由部署方审查，本示例不会替生产环境作出许可决定。

Docker E2E 必须启动真实 Redis 容器并执行真实 BullMQ processor；内存 fake 只用于确定性业务单元测试。

## 验证

运行以下命令：

```bash
bun run typecheck
bun run test:unit
bun run test:unit:coverage
bun run test:e2e:examples
```

真实 Docker E2E 覆盖 Redis 8.10.0 与固定 image digest、
重复 Cron tick 只保留一个确定性 job、原生 attempts `0,1,2` 与 fixed backoff、独立 Worker 进程持锁后以 17 退出、
`attemptsStarted=2` 与 `stalledCounter=1` 的恢复、File Store checkpoint fresh readback，以及
scheduler → Worker → Queue → Store 关停顺序。关停后持久 Redis 连接数和 owner-labeled 容器残留数均为 0。

本基线尚未把 Redis stop/start、最终 failed job、checkpoint 写失败、SIGTERM 或非协作 processor timeout 纳入本示例
E2E；这些仍应在采用对应生产策略前单独演练，不能从当前通过结果外推。

## 非目标

- exactly-once 执行或 Redis、文件、报表下游之间的分布式事务。
- Temporal、Airflow、Dagster 等工作流引擎，DAG、人工审批或补偿编排。
- 多副本 scheduler/worker 共享同一个文件 checkpoint。
- 通用报表 DSL、可视化设计器、报表下载 UI 或交付渠道管理。
- Redis Cluster/Sentinel 的生产拓扑设计、备份产品选型或跨区域容灾。
- 自动跳过失败窗口，或把最终失败静默转换为成功。

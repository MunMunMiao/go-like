# `@likego/bullmq`

把应用配置的官方 BullMQ `Worker` 接入 LikeGo 结构化 `Server` 生命周期。本包只承接
`waitUntilReady()`、`run()`、`pause(false)`、`cancelAllJobs()`、`close(true)` 与原生终态观察；不创建
Queue、不包装 processor、不复制 `WorkerOptions`，也不定义 job、token、signal、retry、backoff、result 或
telemetry facade。

```ts
import { newApp, server, stopTimeout } from "@likego/core"
import { bullMqWorkerShutdownTimeout, newBullMqWorkerServer } from "@likego/bullmq"
import { Queue, Worker } from "bullmq"

const connection = {
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null
}
const prefix = "orders"
const queue = new Queue("mail", { connection, prefix })
const worker = new Worker(
  "mail",
  async (job, token, signal) => {
    signal?.throwIfAborted()
    await deliverMail(job.data, token)
  },
  {
    connection,
    prefix,
    autorun: false,
    concurrency: 16,
    lockDuration: 30_000,
    stalledInterval: 15_000,
    skipVersionCheck: false
  }
)

worker.on("error", (error) => {
  console.error("BullMQ Worker error", error)
})

const jobs = newBullMqWorkerServer(worker, bullMqWorkerShutdownTimeout(25_000))
const app = newApp(server(jobs), stopTimeout(30_000))
const running = app.run()

await app.stop()
await running
await queue.close()
```

也可以把构造延迟到 `start(ctx)`：

```ts
const jobs = newBullMqWorkerServer(
  () =>
    new Worker("mail", nativeProcessor, {
      connection,
      prefix,
      autorun: false
    })
)
```

## 原生数据面边界

- 主入口只接受官方 `Worker`，或同步的零参数 `() => Worker` 工厂。Worker 必须由应用通过 BullMQ 官方构造器
  配置完整 processor 与 `WorkerOptions`，并明确使用 `autorun: false`。
- processor 保持 BullMQ 官方三参数 ABI `(job, token, signal)`；原始 `Job` identity、token、`AbortSignal`、
  retry/backoff/stalled/result/telemetry 全部直接由 BullMQ 提供。本包不插入 LikeGo `Context`，不捕获或改写
  processor rejection。
- 应用始终持有原生 Worker 数据面引用，可以使用 BullMQ 的查询和业务 API。成功 `start()` 后，Worker 的
  `run/pause/close` 终止契约转交 LikeGo；应用不得再从旁调用这些生命周期方法。
- 传入已创建 Worker 时，BullMQ 构造器可能已经建立 Redis connection；`autorun: false` 只保证 processor main
  loop 未启动。需要把资源构造也纳入启动边界时，应使用同步工厂。
- 工厂只在首次 `start(ctx)` 的取消预检通过后执行一次，不接收 LikeGo 参数。工厂返回的非官方 Worker、
  `autorun !== false`、已运行或已关闭 Worker 会被拒绝，并由适配器回滚关闭。
- 应用应在交付 Worker 前通过官方 `worker.on("error", ...)` 注册业务观察。适配器自己的 listener 只保护和
  收集生命周期排空期间的原生错误，不代替应用日志、监控或告警策略。

## 启动、停止与真实终态

- `start(ctx)` 是 one-shot：取消预检后获取休眠 Worker，安装 `error`/`closed` listener，等待
  `waitUntilReady()`，再调用一次 `run()`。ready 前原生关闭、readiness failure 或调用方取消都会使启动失败；
  工厂在 start 边界创建的临时 Worker 会被回滚关闭；应用预先创建并直接传入的 Worker 尚未被成功接纳，
  因此只移除 adapter listener，不调用 `close()`，其生命周期仍归应用。
- `start(ctx)` 接纳完成后继续阻塞，直到 Worker 原生终态；`stop(ctx)` 位于 Server 本身，不返回额外
  handle。
- `run()` 非预期 resolve/reject，或未请求的 `closed` event，会转换成 `BullMqUnexpectedExitError`。Redis
  outage 的普通 `error` event 不是 Server terminal；BullMQ 仍负责 reconnect。
- 首次 `stop(ctx)` 启动唯一 owner shutdown：先调用 `pause(false)` 停止 admission 并等待 active jobs，再且只再
  调用一次 `close(true)`，最后等待官方 `closed` event。所有 stop 调用共享这条排空链。
- 调用方 stop Context 只允许当前调用方放弃等待，不会取消已经开始的 owner shutdown。
- `bullMqWorkerShutdownTimeout(ms)` 默认 25 秒，接受 `0..2_147_483_647` 整数。官方
  `pause(false)` 与 `close(true)` 都不接受 `AbortSignal`，所以这里必须保留 provider timeout。到期后
  `stop(ctx)` 报告 `BullMqWorkerShutdownTimeoutError`，并调用官方 `cancelAllJobs(reason)`，让应用的三参数
  processor 从原生 signal 观察取消；适配器不会另造 Context 或绕过 BullMQ。
- timeout 只结束当前 stop waiter，不伪造原生 terminal。`pause(false)`、唯一 `close(true)`、原生 `closed`
  任一仍 pending 时，`start(ctx)` 的运行期 Promise 继续 pending；原生终态最终到达后，它才按原始 failure
  identity 与观察顺序结算。

## 所有权

应用负责 Queue、processor、Worker 配置与原生数据面。Worker 可以由应用预先创建，也可以由应用工厂在 start
边界内创建；成功启动后仅 stop contract 归 LikeGo。Worker 内部 Redis connections 随同官方 Worker 的
`close(true)` 收敛，应用 Queue 完全不在适配器作用域内，最后由应用自行关闭。

所有权拆分如下：Queue 为 `application-owned / native-borrowed / application-owned`；Worker 为
`application-owned / native-borrowed / likego-owned`；Worker connections 为
`likego-owned / managed-private / likego-owned`。最后一项描述的是成功接纳后只能通过 LikeGo stop contract
收敛、且不向应用单独暴露的 Worker 内部 connections，不改变 Worker 配置由应用负责的事实。

## 真实服务测试

本包固定 BullMQ 5.81.2。Docker E2E 使用固定 digest 的 Redis 8.8.1，通过应用层官方三参数 processor 验证：

- raw Job、非空 native token 与 native AbortSignal；
- retry/fixed backoff 与独立进程崩溃后的 stalled recovery；
- Redis outage/reconnect 与应用自己的原生 error listener；
- non-cooperative processor 在 provider timeout 后收到 native signal，但 `start(ctx)` 的运行期 Promise 仍
  保持 pending，直到 processor 与 Worker 真实终止；
- timeout Error identity、应用 Queue 保持可用、Worker connections 回到基线；
- 无残留 container、connection 或 late rejection。

```text
redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb
```

Redis 8 及更高版本采用 tri-license，可选择 AGPLv3、RSALv2 或 SSPLv1。部署方必须自行选择并遵守适用
license；测试镜像 digest 不会替部署方作出许可选择。

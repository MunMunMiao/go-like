# @go-like/bullmq

BullMQ `JobQueue`，同时是队列资源的 `Server`。公开入口只有 `@go-like/bullmq/job`。应用创建 `Queue`；`worker()` 再造一个 `autorun: false` 的 Worker，并返回另一个 `Server`。

## 依赖

| 种类 | 包              | 范围     |
| ---- | --------------- | -------- |
| peer | `@go-like/core` | `0.0.1`  |
| peer | `bullmq`        | `^6.7.5` |
| 开发 | `@types/node`   | `26.6.6` |

没有可选 peer。`@go-like/core` 的 dev 依赖是 `workspace:*`。开发依赖把 `bullmq` 钉在 `6.7.5`。通道是 Node.js 与 Bun。

## 示例

```ts
import { newApp, resources, server } from "@go-like/core"
import { newBullMqJobQueue } from "@go-like/bullmq/job"
import { Queue } from "bullmq"

const queue = new Queue("receipts", { connection: { host: "127.0.0.1", port: 6379 } })
const jobs = newBullMqJobQueue(queue)
const worker = jobs.worker({
  async send() {}
})
const app = newApp(resources(jobs), server(worker))
void app
```

队列放在 `resources(...)`，worker 放在 `server(...)`。这样 worker 会等队列准入之后才启动，并在队列关闭之前停止。

## 错误码

| 代码                             | 类型                        | 说明                                     |
| -------------------------------- | --------------------------- | ---------------------------------------- |
| `GO_LIKE_BULLMQ_UNEXPECTED_EXIT` | `BullMqUnexpectedExitError` | Worker 在 owner 停止之外退出。类型已导出 |

队列状态、排空超时、未知任务名和不可重试错误使用 `@go-like/core/job` 的
`GO_LIKE_JOB_STATE`、`GO_LIKE_JOB_DRAIN_TIMEOUT`、`GO_LIKE_JOB_UNKNOWN_NAME`、`GO_LIKE_JOB_PERMANENT`。
非法选项抛出 `TypeError`。

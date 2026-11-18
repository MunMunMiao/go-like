# 消息、事件与任务

消息和定时工作是三个插座。

- **Broker** 在一个主题上发布和订阅字节，并保留 provider 的原生投递对象。
- **Event** 是这些字节上的 codec。它以 `eventBroker` 的形式位于 `@go-like/core/broker`。它不是单独的包，不是历史日志，也不是重放引擎。
- **Job** 是时间表（`Schedule`）或队列（`JobQueue`）。Croner 填入时间表。BullMQ 填入队列。

当插头调用 provider 工具包时，core 记录 `messaging.publish`、`messaging.process`、`job.run` 和 `job.enqueue`。应用 handler 自己不打开这些 span。

## Broker

```ts
import { newBrokerServer, type BrokerMessage } from "@go-like/core/broker"
import type { Context } from "@go-like/core/context"

declare function handle(ctx: Context, event: { readonly message: BrokerMessage }): Promise<void>
declare const broker: Parameters<typeof newBrokerServer>[0]

const consumer = newBrokerServer(broker, "appointments.created", async (ctx, event) => {
  await handle(ctx, event)
})
void consumer
```

`newBrokerServer` 拥有已接纳订阅的停止。除非该插头的契约这样说，它不关闭借来的连接、流或持久消费者。主题字符串是观测里使用的订阅标签。对 JetStream 来说，消息工厂决定哪些消息到达。标签不决定。

`event.native` 是 provider 对象（`Msg`、`JsMsg`、一次 AMQP delivery）。Ack、nack、term 和死信留在该对象上。Core 没有共享的结算方法。

`@go-like/core/broker/memory` 为测试导出 `newMemoryBroker`。`@go-like/core/broker/provider` 为插头作者导出 `deliver`、`publish` 和 `registerSubscriberTerminal`。

| 插头                       | 构造函数                                                         | 原生所有权                                                      |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `@go-like/nats/broker`     | `newNatsCoreBroker(connection, ...options)`                      | 订阅排空。`natsCoreDrainTimeout` 限制等待，然后取消订阅。       |
| `@go-like/nats/jetstream`  | `newNatsJetStreamBroker(jetstream, messagesFactory, ...options)` | 消费者迭代器。`natsJetStreamCloseTimeout` 限制关闭，然后停止。  |
| `@go-like/rabbitmq/broker` | `newRabbitMqBroker(channel)`                                     | 该 channel 的投递对象。                                         |
| `@go-like/rabbitmq/broker` | `startRecoveringRabbitMqBroker(...)`                             | 在 connector 就绪之前接纳句柄。在某一代存在之前，发布保持关闭。 |

应用打开的 NATS 连接属于资源层：

```ts
import { newApp, resources, server } from "@go-like/core"
import { newResourceServer } from "@go-like/core/lifecycle"
import { newBrokerServer } from "@go-like/core/broker"
import { newNatsJetStreamBroker } from "@go-like/nats/jetstream"

const nats = newResourceServer({
  terminal: connection.closed(),
  close: () => connection.drain()
})
const subscription = newBrokerServer(
  newNatsJetStreamBroker(jetstream, messagesFactory),
  "telemetry.raw.v1",
  async (_ctx, event) => {
    // Settlement stays on the JetStream message: event.native.ack(), nak(), or term().
    void event.native
  }
)
const app = newApp(resources(nats), server(subscription))
void app
```

`connection`、`jetstream` 和 `messagesFactory` 是应用从 NATS 客户端得到的对象。上面的片段是所有权形态；客户端构造见插头 README。

## 带类型的事件

```ts
import { eventBroker } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

const payload = struct.object({ id: struct.string() })
const events = eventBroker(newMemoryBroker(), jsonCodec(payload))
```

`events.publish` 编码。`event.decode()` 解码出一份防御性副本。Codec 失败是 Struct 或协议失败，不是一次成功的投递。

## 任务

`@go-like/core/job` 的 `newScheduleServer(schedule, name, handler)` 拥有计时器、重叠和排空。`newIntervalSchedule(ms)` 是 core 的时间表。`@go-like/croner/job` 的 `newCronerSchedule(pattern, options)` 是纯 Croner 时间表：它不启动 Croner 自己的计时器。把它传给 `newScheduleServer`。

`JobQueue.worker(handlers)` 返回一个给 server 层用的 `Server`。队列本身在需要连接时属于 `resources(...)`，这样 worker 只在队列可用之后启动，并在队列关闭之前停止。

```ts
import { newApp, resources, server } from "@go-like/core"
import { newIntervalSchedule, newScheduleServer } from "@go-like/core/job"
import { newBullMqJobQueue } from "@go-like/bullmq/job"

const jobs = newBullMqJobQueue(bullQueue)
const worker = jobs.worker({
  report: async (_ctx, job) => {
    await writeReport(job.payload)
  }
})
const scheduler = newScheduleServer(newIntervalSchedule(60_000), "report", async (ctx) => {
  await jobs.enqueue(ctx, "report", { window: "hourly" }, { id: "report-hourly" })
})
const app = newApp(resources(jobs), server(worker, scheduler))
void app
```

`bullQueue` 是应用构造的 BullMQ `Queue`，`writeReport` 是应用代码。`newBullMqJobQueue` 接管这个队列：`start` 等到它就绪，`stop` 关闭它一次。`GO_LIKE_BULLMQ_UNEXPECTED_EXIT` 表示 Worker 在没有 `stop` 的情况下结束。队列状态和排空使用 `@go-like/core/job` 的 `GO_LIKE_JOB_STATE` 和 `GO_LIKE_JOB_DRAIN_TIMEOUT`。`newPermanentJobError` 标记队列不应重试的失败。`id` 选项是幂等键，在一个未完成的任务持有它的期间有效。

`@go-like/core/job/provider`（`runJob`、`enqueue`、`dispatchJob`）给插头作者使用。应用代码使用 `newScheduleServer` 和 `JobQueue`。

## 停机

停止顺序遵循[架构](/zh-Hans/guide/architecture)里的层级。Broker server 随 server 层停止。`resources(...)` 里的连接或队列在其后停止，按声明的相反顺序。排空超时会启动原生的取消订阅或关闭，并不能证明原生对象已经结束。在替换所有者之前，观察 provider 的终态 promise。

NATS 的意外退出和排空超时代码在 `@go-like/nats/broker` 和 `@go-like/nats/jetstream` 上。它们列在[错误处理](/reference/errors)里。

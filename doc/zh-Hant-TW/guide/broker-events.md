# 訊息代理、事件與工作

訊息與排程工作是三個插座。

- **訊息代理（Broker）**在一個 topic 上發布與訂閱位元組，並保留 provider 的原生投遞物件。
- **事件**是那些位元組上的 codec。它住在 `@go-like/core/broker` 的 `eventBroker`。它不是獨立套件，不是歷史日誌，也不是重送引擎。
- **工作**是一份時間表（`Schedule`）或一條佇列（`JobQueue`）。Croner 填時間表。BullMQ 填佇列。

當插頭呼叫 provider 工具時，core 記錄 `messaging.publish`、`messaging.process`、`job.run` 與 `job.enqueue`。應用程式的 handler 不會自己打開那些 span。

## 訊息代理

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

`newBrokerServer` 擁有已接受訂閱的停止。除非該插頭的契約這樣說，否則它不會關閉借來的連線、stream 或 durable consumer。Topic 字串是 telemetry 使用的訂閱標籤。對 JetStream 來說，哪些訊息會到，由 message factory 決定。標籤不決定。

`event.native` 是 provider 物件（`Msg`、`JsMsg`、一份 AMQP delivery）。Ack、nack、term 與 dead-letter 留在那個物件上。Core 沒有共用的結算方法。

`@go-like/core/broker/memory` 為測試匯出 `newMemoryBroker`。`@go-like/core/broker/provider` 為插頭作者匯出 `deliver`、`publish` 與 `registerSubscriberTerminal`。

| 插頭                       | 建構函式                                                         | 原生擁有權                                                                   |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@go-like/nats/broker`     | `newNatsCoreBroker(connection, ...options)`                      | 訂閱 drain。`natsCoreDrainTimeout` 限制等待，然後 unsubscribe。              |
| `@go-like/nats/jetstream`  | `newNatsJetStreamBroker(jetstream, messagesFactory, ...options)` | Consumer iterator。`natsJetStreamCloseTimeout` 限制 close，然後 stop。       |
| `@go-like/rabbitmq/broker` | `newRabbitMqBroker(channel)`                                     | Channel 的 delivery 物件。                                                   |
| `@go-like/rabbitmq/broker` | `startRecoveringRabbitMqBroker(...)`                             | 在 connector 就緒之前接納 handle。在 generation 出現之前，publish 維持關閉。 |

應用程式打開的 NATS 連線屬於 resource 層級：

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

`connection`、`jetstream` 與 `messagesFactory` 是應用程式從 NATS 用戶端拿到的物件。上面的片段是擁有權的形狀；用戶端怎麼建立，見插頭 README。

## 帶型別的事件

```ts
import { eventBroker } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

const payload = struct.object({ id: struct.string() })
const events = eventBroker(newMemoryBroker(), jsonCodec(payload))
```

`events.publish` 編碼。`event.decode()` 解碼一份防禦性複本。Codec 失敗是 Struct 或協定失敗，不是一次成功的投遞。

## 工作

`@go-like/core/job` 的 `newScheduleServer(schedule, name, handler)` 擁有計時器、重疊與 drain。`newIntervalSchedule(ms)` 是 core 的時間表。`@go-like/croner/job` 的 `newCronerSchedule(pattern, options)` 是純的 Croner 時間表：它不會啟動 Croner 自己的計時器。把它傳給 `newScheduleServer`。

`JobQueue.worker(handlers)` 回傳一個給 server 層級用的 `Server`。佇列本身若需要連線，就放進 `resources(...)`，這樣 worker 只在佇列可用之後才啟動，並在佇列關閉之前停止。

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

`bullQueue` 是應用程式建立的 BullMQ `Queue`，`writeReport` 是應用程式的程式碼。`newBullMqJobQueue` 收養這條佇列：`start` 等到它就緒，`stop` 關閉它一次。`GO_LIKE_BULLMQ_UNEXPECTED_EXIT` 表示 Worker 在沒有 `stop` 的情況下結束。佇列狀態與 drain 使用 `@go-like/core/job` 的 `GO_LIKE_JOB_STATE` 與 `GO_LIKE_JOB_DRAIN_TIMEOUT`。`newPermanentJobError` 標記一個佇列不該重試的失敗。未完成的工作還持有 `id` 選項時，它就是冪等鍵。

`@go-like/core/job/provider`（`runJob`、`enqueue`、`dispatchJob`）給插頭作者使用。應用程式使用 `newScheduleServer` 與 `JobQueue`。

## 關閉

停止順序遵循[架構](/zh-Hant-TW/guide/architecture)裡的層級。訊息代理 server 跟 server 層級一起停止。放在 `resources(...)` 裡的連線或佇列在那之後停止，依宣告的反向順序。Drain 逾時會啟動原生的 unsubscribe 或 close，但不能證明原生物件已經結束。換掉擁有者之前，先觀察 provider 的 terminal promise。

NATS 的非預期結束與 drain 逾時 code 在 `@go-like/nats/broker` 與 `@go-like/nats/jetstream`。它們列在[錯誤處理](/reference/errors)。

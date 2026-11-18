# Broker、事件同作業

訊息同排程工作係三個插座。

- **Broker** 喺 topic 上發布同訂閱 bytes，並保留 provider 嘅原生投遞物件。
- **事件**係呢啲 bytes 上嘅 codec。佢喺 `@go-like/core/broker` 上，叫 `eventBroker`。佢唔係獨立套件、歷史日誌或重播引擎。
- **作業**係時間表（`Schedule`）或隊列（`JobQueue`）。Croner 填時間表。BullMQ 填隊列。

插頭呼叫 provider 工具時，Core 記錄 `messaging.publish`、`messaging.process`、`job.run` 同 `job.enqueue`。應用 handler 唔自己開呢啲 span。

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

`newBrokerServer` 擁有已接受訂閱嘅停止。除非該插頭嘅契約咁講，否則佢唔關閉借入嘅連線、stream 或 durable consumer。Topic 字串係遙測用嘅訂閱標籤。對 JetStream，message factory 決定邊啲訊息到達。標籤唔決定。

`event.native` 係 provider 物件（`Msg`、`JsMsg`、AMQP delivery）。Ack、nack、term 同 dead-letter 留喺該物件。Core 冇共用 settlement 方法。

`@go-like/core/broker/memory` 匯出測試用嘅 `newMemoryBroker`。`@go-like/core/broker/provider` 為插頭作者匯出 `deliver`、`publish` 同 `registerSubscriberTerminal`。

| 插頭                       | 建構函式                                                         | 原生持有                                                               |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `@go-like/nats/broker`     | `newNatsCoreBroker(connection, ...options)`                      | 訂閱 drain。`natsCoreDrainTimeout` 限制等待，然後 unsubscribe。        |
| `@go-like/nats/jetstream`  | `newNatsJetStreamBroker(jetstream, messagesFactory, ...options)` | Consumer iterator。`natsJetStreamCloseTimeout` 限制 close，然後 stop。 |
| `@go-like/rabbitmq/broker` | `newRabbitMqBroker(channel)`                                     | Channel 嘅 delivery 物件。                                             |
| `@go-like/rabbitmq/broker` | `startRecoveringRabbitMqBroker(...)`                             | Connector 就緒之前接納 handle。有世代存在之前，發布保持關閉。          |

應用打開嘅 NATS 連線屬於資源層：

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

`connection`、`jetstream` 同 `messagesFactory` 係應用由 NATS client 得到嘅物件。上面片段係 ownership 形狀；client 建構喺插頭 README。

## 有型別事件

```ts
import { eventBroker } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

const payload = struct.object({ id: struct.string() })
const events = eventBroker(newMemoryBroker(), jsonCodec(payload))
```

`events.publish` 編碼。`event.decode()` 解碼一份防禦性複本。Codec 失敗係 Struct 或協議失敗，唔係一次成功投遞。

## 作業

`@go-like/core/job` 嘅 `newScheduleServer(schedule, name, handler)` 擁有計時器、重疊同 drain。`newIntervalSchedule(ms)` 係 core 時間表。`@go-like/croner/job` 嘅 `newCronerSchedule(pattern, options)` 係純 Croner 時間表：佢唔啟動 Croner 自己嘅計時器。將佢傳畀 `newScheduleServer`。

`JobQueue.worker(handlers)` 返回 Server 層用嘅 `Server`。Queue 本身需要連線時，屬於 `resources(...)`，令 worker 只喺 queue 可用之後先啟動，並喺 queue 關閉之前停止。

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

`bullQueue` 係應用建立嘅 BullMQ `Queue`，`writeReport` 係應用程式碼。`newBullMqJobQueue` 接管 queue：`start` 等到佢就緒，`stop` 關閉佢一次。`GO_LIKE_BULLMQ_UNEXPECTED_EXIT` 代表 Worker 喺冇 `stop` 嘅情況下結束。Queue 狀態同 drain 用 `@go-like/core/job` 嘅 `GO_LIKE_JOB_STATE` 同 `GO_LIKE_JOB_DRAIN_TIMEOUT`。`newPermanentJobError` 標記隊列唔應該重試嘅失敗。未完成作業持有 `id` option 期間，佢係冪等鍵。

`@go-like/core/job/provider`（`runJob`、`enqueue`、`dispatchJob`）畀插頭作者。應用程式碼用 `newScheduleServer` 同 `JobQueue`。

## 停機

停止次序跟[架構](/zh-Hant-HK/guide/architecture)嘅層。Broker server 同 Server 層一齊停。`resources(...)` 入面嘅連線或 queue 之後先停，按宣告嘅反向次序。Drain 逾時開始原生 unsubscribe 或 close，而且唔證明原生物件已經結束。換持有者之前，觀察 provider 嘅 terminal promise。

NATS 意外退出同 drain 逾時代碼喺 `@go-like/nats/broker` 同 `@go-like/nats/jetstream`。佢哋列喺[錯誤處理](/reference/errors)。

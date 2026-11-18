# Брокер, события и задания

Сообщения и работа по расписанию — три socket.

- **Broker** публикует и подписывается на байты темы и сохраняет нативный объект доставки провайдера.
- **Событие** — кодек поверх этих байтов. Оно живёт в `@go-like/core/broker` как `eventBroker`. Это не отдельный пакет, журнал истории и не механизм повтора.
- **Задание** — расписание (`Schedule`) или очередь (`JobQueue`). Croner заполняет расписание. BullMQ заполняет очередь.

Core записывает `messaging.publish`, `messaging.process`, `job.run` и `job.enqueue`, когда plug вызывает набор провайдера. Обработчики приложения сами эти span не открывают.

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

`newBrokerServer` владеет остановкой принятой подписки. Он не закрывает заимствованное соединение, поток или устойчивого потребителя, пока контракт этого plug этого не говорит. Строка темы — метка подписки, которую использует телеметрия. Для JetStream фабрика сообщений выбирает, какие сообщения приходят. Метка этого не делает.

`event.native` — объект провайдера (`Msg`, `JsMsg`, доставка AMQP). Ack, nack, term и dead-letter остаются на этом объекте. У core нет общего метода подтверждения.

`@go-like/core/broker/memory` экспортирует `newMemoryBroker` для тестов. `@go-like/core/broker/provider` экспортирует `deliver`, `publish` и `registerSubscriberTerminal` для авторов plug.

| Plug                       | Конструктор                                                      | Нативное владение                                                                              |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@go-like/nats/broker`     | `newNatsCoreBroker(connection, ...options)`                      | Drain подписки. `natsCoreDrainTimeout` ограничивает ожидание, затем unsubscribe.               |
| `@go-like/nats/jetstream`  | `newNatsJetStreamBroker(jetstream, messagesFactory, ...options)` | Итератор потребителя. `natsJetStreamCloseTimeout` ограничивает close, затем stop.              |
| `@go-like/rabbitmq/broker` | `newRabbitMqBroker(channel)`                                     | Объект доставки канала.                                                                        |
| `@go-like/rabbitmq/broker` | `startRecoveringRabbitMqBroker(...)`                             | Допускает дескриптор до готовности коннектора. Публикация закрыта, пока не появится поколение. |

Соединение NATS, которое открыло приложение, принадлежит ярусу ресурсов:

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

`connection`, `jetstream` и `messagesFactory` — объекты, которые приложение получило от клиента NATS. Фрагменты выше задают форму владения; построение клиента есть в README plug.

## Типизированные события

```ts
import { eventBroker } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

const payload = struct.object({ id: struct.string() })
const events = eventBroker(newMemoryBroker(), jsonCodec(payload))
```

`events.publish` кодирует. `event.decode()` декодирует одну защитную копию. Сбой кодека — сбой Struct или протокола, а не успешная доставка.

## Задания

`newScheduleServer(schedule, name, handler)` из `@go-like/core/job` владеет таймером, наложением и drain. `newIntervalSchedule(ms)` — расписание core. `newCronerSchedule(pattern, options)` из `@go-like/croner/job` — чистое расписание Croner: собственный таймер Croner оно не запускает. Передайте его в `newScheduleServer`.

`JobQueue.worker(handlers)` возвращает `Server` для яруса серверов. Сама очередь, когда ей нужно соединение, принадлежит `resources(...)`, чтобы worker стартовал только после того, как очередь пригодна, и остановился до того, как очередь закроется.

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

`bullQueue` — это BullMQ `Queue`, который сконструировало приложение, а `writeReport` — код приложения. `newBullMqJobQueue` принимает очередь: `start` ждёт, пока она готова, а `stop` закрывает её один раз. `GO_LIKE_BULLMQ_UNEXPECTED_EXIT` означает, что Worker закончился без `stop`. Состояние очереди и drain используют `GO_LIKE_JOB_STATE` и `GO_LIKE_JOB_DRAIN_TIMEOUT` из `@go-like/core/job`. `newPermanentJobError` помечает сбой, который очередь не должна повторять. Параметр `id` — ключ идемпотентности, пока его держит незавершённое задание.

`@go-like/core/job/provider` (`runJob`, `enqueue`, `dispatchJob`) предназначен для авторов plug. Код приложения использует `newScheduleServer` и `JobQueue`.

## Остановка

Порядок остановки следует ярусам из [Архитектуры](/ru-Cyrl/guide/architecture). Сервер брокера останавливается вместе с ярусом серверов. Соединение или очередь в `resources(...)` останавливается после этого, в обратном порядке объявления. Timeout drain начинает нативный unsubscribe или close и не доказывает, что нативный объект закончился. Наблюдайте Promise завершения провайдера, прежде чем заменять владельца.

Коды неожиданного выхода и timeout drain NATS находятся в `@go-like/nats/broker` и `@go-like/nats/jetstream`. Они перечислены в [Обработке ошибок](/reference/errors).

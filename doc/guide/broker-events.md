# Broker, events, and jobs

Messaging and scheduled work are three sockets.

- **Broker** publishes and subscribes bytes on a topic and keeps the provider's native delivery object.
- **Event** is a codec over those bytes. It lives on `@go-like/core/broker` as `eventBroker`. It is not a separate package, a history log, or a replay engine.
- **Job** is a timetable (`Schedule`) or a queue (`JobQueue`). Croner fills the timetable. BullMQ fills the queue.

Core records `messaging.publish`, `messaging.process`, `job.run`, and `job.enqueue` when the plug calls the provider kit. Application handlers do not open those spans themselves.

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

`newBrokerServer` owns the accepted subscription's stop. It does not close a borrowed connection, stream, or durable consumer unless that plug's contract says so. The topic string is the subscription label used in telemetry. For JetStream, the message factory chooses which messages arrive. The label does not.

`event.native` is the provider object (`Msg`, `JsMsg`, an AMQP delivery). Ack, nack, term, and dead-letter stay on that object. Core has no shared settlement method.

`@go-like/core/broker/memory` exports `newMemoryBroker` for tests. `@go-like/core/broker/provider` exports `deliver`, `publish`, and `registerSubscriberTerminal` for plug authors.

| Plug                       | Constructor                                                      | Native ownership                                                                                 |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@go-like/nats/broker`     | `newNatsCoreBroker(connection, ...options)`                      | Subscription drain. `natsCoreDrainTimeout` bounds the wait, then unsubscribe.                    |
| `@go-like/nats/jetstream`  | `newNatsJetStreamBroker(jetstream, messagesFactory, ...options)` | Consumer iterator. `natsJetStreamCloseTimeout` bounds close, then stop.                          |
| `@go-like/rabbitmq/broker` | `newRabbitMqBroker(channel)`                                     | The channel's delivery object.                                                                   |
| `@go-like/rabbitmq/broker` | `startRecoveringRabbitMqBroker(...)`                             | Admits the handle before the connector is ready. Publish stays closed until a generation exists. |

A NATS connection the application opened belongs in the resource tier:

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

`connection`, `jetstream`, and `messagesFactory` are the objects the application got from the NATS client. The snippets above are the ownership shape; the plug README has the client construction.

## Typed events

```ts
import { eventBroker } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

const payload = struct.object({ id: struct.string() })
const events = eventBroker(newMemoryBroker(), jsonCodec(payload))
```

`events.publish` encodes. `event.decode()` decodes one defensive copy. A codec failure is a Struct or protocol failure, not a successful delivery.

## Jobs

`newScheduleServer(schedule, name, handler)` from `@go-like/core/job` owns the timer, overlap, and drain. `newIntervalSchedule(ms)` is the core timetable. `newCronerSchedule(pattern, options)` from `@go-like/croner/job` is a pure Croner timetable: it does not start Croner's own timer. Pass it to `newScheduleServer`.

`JobQueue.worker(handlers)` returns a `Server` for the server tier. The queue itself, when it needs a connection, belongs in `resources(...)` so the worker starts only after the queue is usable and stops before the queue closes.

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

`bullQueue` is the BullMQ `Queue` the application constructed, and `writeReport` is application code. `newBullMqJobQueue` adopts the queue: `start` waits until it is ready, and `stop` closes it once. `GO_LIKE_BULLMQ_UNEXPECTED_EXIT` means the Worker ended without `stop`. Queue state and drain use `GO_LIKE_JOB_STATE` and `GO_LIKE_JOB_DRAIN_TIMEOUT` from `@go-like/core/job`. `newPermanentJobError` marks a failure the queue should not retry. The `id` option is the idempotency key while an unfinished job holds it.

`@go-like/core/job/provider` (`runJob`, `enqueue`, `dispatchJob`) is for plug authors. Application code uses `newScheduleServer` and `JobQueue`.

## Shutdown

Stop order follows the tiers in [Architecture](/guide/architecture). A broker server stops with the server tier. A connection or queue in `resources(...)` stops afterwards, in reverse declaration order. A drain timeout starts the native unsubscribe or close and does not prove the native object has finished. Observe the provider's terminal promise before replacing the owner.

NATS unexpected-exit and drain-timeout codes are on `@go-like/nats/broker` and `@go-like/nats/jetstream`. They are listed in [Error handling](/reference/errors).

# Broker and events

`@go-like/broker` is a narrow Context-first bytes-and-topic contract. It deliberately preserves the provider's native delivery object because acknowledgement, redelivery, durability, negative acknowledgement, termination, and dead-letter behavior differ across brokers.

`@go-like/event` adds one explicit codec layer. It does not add a schema registry, replay store, universal acknowledgement methods, or exactly-once delivery.

## The portable broker contract

The core shapes are:

```ts
interface BrokerMessage {
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

interface BrokerEvent<Native> {
  readonly topic: string
  readonly message: BrokerMessage
  readonly native: Native
}

interface Subscriber {
  readonly topic: string
  unsubscribe(ctx: Context): Promise<void>
}
```

A Broker exposes Context-first `publish` and `subscribe`. The public SPI does not define `ack`, `nack`, `term`, retry, DLQ, or durable offset methods. Provider packages may expose those native operations through `event.native` or an official provider object.

`newBrokerServer(...)` turns one accepted subscription into a Core `Server`:

```ts
import { newBrokerServer } from "@go-like/broker"

const consumerServer = newBrokerServer(broker, "appointments.created", async (ctx, event) => {
  await handleAppointment(ctx, event)
})
```

The adapter owns the accepted subscription's stop operation. It does not close a borrowed Broker connection, NATS connection, RabbitMQ connection, stream, or durable consumer unless that provider-specific contract explicitly transfers such ownership.

## Typed events

A codec has a media type and byte conversion:

```ts
import { eventBroker } from "@go-like/event"

const codec = {
  mediaType: "application/vnd.example.appointment-created+json",
  encode(value: AppointmentCreated): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value))
  },
  decode(bytes: Uint8Array): AppointmentCreated {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as AppointmentCreated
  }
}

const events = eventBroker(broker, codec)
await events.publish(ctx, "appointments.created", {
  appointmentId: "appointment-1"
})
```

The actual codec type is application-owned. On receive, `event.decode()` is lazy and checks that the content type is exactly the codec media type. The native delivery identity is retained even if decoding fails, so application code can apply provider-specific settlement.

```text
publish typed value
  -> Codec.encode
  -> detached BrokerMessage bytes
  -> provider publish

receive BrokerMessage
  -> EventMessage with native identity
  -> event.decode() when application chooses
  -> application settlement through native provider API
```

## Memory Broker

`newMemoryBroker()` is useful for deterministic unit tests and local composition:

- the address space is private to the Broker instance;
- subscriptions match exact topics and broadcast to matching subscribers;
- each subscriber processes deliveries FIFO and serially;
- different subscribers may process in parallel;
- message headers and bodies are defensively copied;
- there are no queue groups, wildcards, persistence, ack/nack, DLQ, replay, or cross-process behavior;
- a handler failure terminates that subscription and retains the original error.

Memory Broker is not a local simulation of NATS JetStream or RabbitMQ. Test provider-native settlement with the actual provider lane.

## RabbitMQ

`@go-like/broker-rabbitmq` exposes three deliberate construction choices:

- `newRabbitMqBroker(channel)` borrows an ordinary `amqplib` Channel;
- `newConfirmRabbitMqBroker(channel)` borrows a ConfirmChannel and waits for publisher confirms;
- `newRecoveringRabbitMqBroker(...)` creates the canonical recovering generation model.

A borrowed-channel entry does not close the application's connection or channel. The recovering entry replays exchange, queue, binding, QoS, and consumer declarations for a new channel generation. Native delivery settlement is fenced by generation, so an old delivery cannot accidentally acknowledge a new channel. A publisher confirm is not exactly-once delivery; application idempotency is still required.

The package retains native `ack`, `nack`, and `reject` behavior through the provider event identity. Do not add those methods to the portable `Broker` type merely to make RabbitMQ look like Memory Broker.

## NATS Core and JetStream

`@go-like/nats` has separate entrypoints:

| Entry               | Public factory or adapter                             | Native semantics retained                                                                          |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| root                | `newNatsCoreServer`, `natsCoreDrainTimeout`           | NATS Core `Subscription`, queue groups, at-most-once delivery, `drain()`, and `closed`             |
| `/broker`           | `newNatsCoreBroker`                                   | NATS Core `Msg`, publish options, subscription iterator, `unsubscribe`, and `drain`                |
| `/jetstream`        | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout` | `ConsumerMessages`, `close`, `stop`, `closed`, and native close timeout behavior                   |
| `/jetstream/broker` | `newNatsJetStreamBroker`                              | `JsMsg`, `PubAck`, durable consumer behavior, ack/nak/term, redelivery, MaxDeliver, and DLQ policy |

The application owns the connection/client, stream, consumer configuration, and business settlement policy. The adapter joins an accepted native subscription or ConsumerMessages object to Core lifecycle and observes the provider's terminal barrier.

A JetStream handler should make settlement visible in business code:

```text
valid event
  -> publish or apply business result
  -> native JsMsg ackAck()

transient failure
  -> native JsMsg nak(delay)

permanent failure
  -> publish to application DLQ
  -> native JsMsg term()
```

This is a teaching shape, not a go-like portable API. The exact native methods and delivery policy belong to `@nats-io/jetstream` and the application.

## Jobs and schedules are separate models

A Broker is not a job queue. Use the native model that matches the problem:

- `@go-like/croner` adapts application-created Croner `Cron` jobs. The factory must return paused, non-busy, non-stopped jobs. go-like resumes them in order and stops them in reverse order. Cron expressions, time zones, overlap policy, callbacks, and trigger behavior remain Croner/application concerns. Croner stop does not provide a reliable passive callback-drain barrier.
- `@go-like/bullmq` adapts an official BullMQ `Worker` constructed with `autorun: false`. Startup waits for readiness, then calls `run()`. Stop requests `pause(false)`, `cancelAllJobs(reason)`, `close(true)`, and observes the native `closed` boundary. Queue, processor, retry/backoff, stalled-job policy, Redis, and job idempotency remain application/BullMQ concerns.

Core stops sibling Servers concurrently. If a Croner schedule must stop before a BullMQ Worker or a Queue producer, compose that ordering explicitly rather than relying on `server(croner, worker)` declaration order.

## Ownership matrix

| Native resource                               | Application owns                                         | go-like adapter owns after admission                                                            |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| NATS connection, stream, durable consumer     | Create, credentials, stream and consumer policy          | Accepted subscription or ConsumerMessages stop contract                                         |
| RabbitMQ connection and borrowed channel      | Connection, topology policy, channel creation            | Borrowed subscription stop, or recovering channel generation for the canonical recovery adapter |
| Memory Broker                                 | Broker instance and application subscription composition | In-process topic map and accepted delivery owner                                                |
| BullMQ Queue, Worker configuration, processor | Queue, Redis, retry/backoff, processor behavior          | Worker `run`, pause, cancel, close boundary                                                     |
| Croner factory and jobs                       | Cron options, callback, schedule policy                  | Accepted job resume/stop boundary                                                               |
| Event codec                                   | Media type, validation, serialization                    | Detached byte conversion and lazy decode wrapper                                                |

## Failure and shutdown rules

Keep these distinctions visible in tests and runbooks:

- subscriber cancellation is not connection shutdown;
- a broker handler error may terminate one subscriber without proving the connection failed;
- a provider close timeout may mean the owner is still converging;
- a NATS `PubAck`, RabbitMQ confirm, or BullMQ completion is not a universal exactly-once proof;
- a typed decode failure does not erase `event.native`;
- a native broker's retry, redelivery, DLQ, and acknowledgement rules are not converted into a common go-like retry loop;
- a Core App stop result aggregates adapter failures but does not invent a terminal result that the native provider did not expose.

See [Architecture](/guide/architecture) for the caller-wait versus owner-terminal distinction and [Health and observability](/guide/health-observability) for bounded operational signals.

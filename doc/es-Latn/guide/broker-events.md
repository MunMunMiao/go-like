# Broker, eventos y jobs

La mensajería y el trabajo programado son tres sockets.

- **Broker** publica y se suscribe a bytes en un topic y conserva el objeto de entrega nativo del proveedor.
- **Event** es un codec sobre esos bytes. Vive en `@go-like/core/broker` como `eventBroker`. No es un paquete aparte, un log de historia ni un motor de replay.
- **Job** es un horario (`Schedule`) o una cola (`JobQueue`). Croner rellena el horario. BullMQ rellena la cola.

Core registra `messaging.publish`, `messaging.process`, `job.run` y `job.enqueue` cuando el plug llama al kit del proveedor. Los handlers de la aplicación no abren esos spans por su cuenta.

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

`newBrokerServer` posee la parada de la suscripción aceptada. No cierra una conexión, un stream o un consumidor durable prestados, salvo que el contrato de ese plug lo diga. La cadena del topic es la etiqueta de suscripción que se usa en telemetría. En JetStream, la factory de mensajes elige qué mensajes llegan. La etiqueta no.

`event.native` es el objeto del proveedor (`Msg`, `JsMsg`, una entrega AMQP). Ack, nack, term y dead-letter se quedan en ese objeto. Core no tiene un método de settlement compartido.

`@go-like/core/broker/memory` exporta `newMemoryBroker` para pruebas. `@go-like/core/broker/provider` exporta `deliver`, `publish` y `registerSubscriberTerminal` para autores de plugs.

| Plug                       | Constructor                                                      | Propiedad nativa                                                                                                        |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@go-like/nats/broker`     | `newNatsCoreBroker(connection, ...options)`                      | Drain de la suscripción. `natsCoreDrainTimeout` acota la espera y después hace unsubscribe.                             |
| `@go-like/nats/jetstream`  | `newNatsJetStreamBroker(jetstream, messagesFactory, ...options)` | Iterador del consumidor. `natsJetStreamCloseTimeout` acota el cierre y después para.                                    |
| `@go-like/rabbitmq/broker` | `newRabbitMqBroker(channel)`                                     | El objeto de entrega del canal.                                                                                         |
| `@go-like/rabbitmq/broker` | `startRecoveringRabbitMqBroker(...)`                             | Admite el handle antes de que el conector esté listo. La publicación permanece cerrada hasta que existe una generación. |

Una conexión NATS que abrió la aplicación pertenece al nivel de recursos:

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

`connection`, `jetstream` y `messagesFactory` son los objetos que la aplicación obtuvo del cliente NATS. Los fragmentos de arriba son la forma de la propiedad; el README del plug tiene la construcción del cliente.

## Eventos tipados

```ts
import { eventBroker } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

const payload = struct.object({ id: struct.string() })
const events = eventBroker(newMemoryBroker(), jsonCodec(payload))
```

`events.publish` codifica. `event.decode()` decodifica una copia defensiva. Un fallo de codec es un fallo de Struct o de protocolo, no una entrega correcta.

## Jobs

`newScheduleServer(schedule, name, handler)` de `@go-like/core/job` posee el temporizador, el solapamiento y el drain. `newIntervalSchedule(ms)` es el horario de core. `newCronerSchedule(pattern, options)` de `@go-like/croner/job` es un horario Croner puro: no arranca el temporizador propio de Croner. Hay que pasarlo a `newScheduleServer`.

`JobQueue.worker(handlers)` devuelve un `Server` para el nivel de servidores. La propia cola, cuando necesita una conexión, pertenece a `resources(...)`, para que el worker arranque solo después de que la cola se pueda usar y pare antes de que la cola se cierre.

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

`bullQueue` es el `Queue` de BullMQ que construyó la aplicación, y `writeReport` es código de la aplicación. `newBullMqJobQueue` adopta la cola: `start` espera hasta que está lista, y `stop` la cierra una vez. `GO_LIKE_BULLMQ_UNEXPECTED_EXIT` significa que el Worker terminó sin `stop`. El estado de la cola y el drain usan `GO_LIKE_JOB_STATE` y `GO_LIKE_JOB_DRAIN_TIMEOUT` de `@go-like/core/job`. `newPermanentJobError` marca un fallo que la cola no debe reintentar. La opción `id` es la clave de idempotencia mientras un job sin terminar la retiene.

`@go-like/core/job/provider` (`runJob`, `enqueue`, `dispatchJob`) es para autores de plugs. El código de aplicación usa `newScheduleServer` y `JobQueue`.

## Apagado

El orden de parada sigue los niveles de [Arquitectura](/es-Latn/guide/architecture). Un servidor de broker para con el nivel de servidores. Una conexión o una cola en `resources(...)` para después, en orden inverso de declaración. Un timeout de drain arranca el unsubscribe o el cierre nativos y no demuestra que el objeto nativo haya terminado. Hay que observar la promesa terminal del proveedor antes de sustituir al propietario.

Los códigos de salida inesperada y de timeout de drain de NATS están en `@go-like/nats/broker` y `@go-like/nats/jetstream`. Están listados en [Manejo de errores](/reference/errors).

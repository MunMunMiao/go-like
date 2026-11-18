# Broker, événements et jobs

La messagerie et le travail planifié sont trois sockets.

- **Broker** publie et s'abonne à des octets sur un sujet et conserve l'objet de livraison natif du fournisseur.
- **Event** est un codec au-dessus de ces octets. Il vit sur `@go-like/core/broker` sous le nom `eventBroker`. Ce n'est pas un paquet séparé, un journal d'historique ni un moteur de rejeu.
- **Job** est un calendrier (`Schedule`) ou une file (`JobQueue`). Croner remplit le calendrier. BullMQ remplit la file.

Core enregistre `messaging.publish`, `messaging.process`, `job.run` et `job.enqueue` lorsque le plug appelle le kit fournisseur. Les handlers applicatifs n'ouvrent pas ces spans eux-mêmes.

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

`newBrokerServer` possède l'arrêt de la souscription acceptée. Il ne ferme pas une connexion, un flux ou un consommateur durable empruntés, sauf si le contrat de ce plug le dit. La chaîne de sujet est l'étiquette de souscription utilisée en télémétrie. Pour JetStream, la factory de messages choisit quels messages arrivent. L'étiquette ne le fait pas.

`event.native` est l'objet du fournisseur (`Msg`, `JsMsg`, une livraison AMQP). Ack, nack, term et dead-letter restent sur cet objet. Core n'a pas de méthode de règlement partagée.

`@go-like/core/broker/memory` exporte `newMemoryBroker` pour les tests. `@go-like/core/broker/provider` exporte `deliver`, `publish` et `registerSubscriberTerminal` pour les auteurs de plugs.

| Plug                       | Constructeur                                                     | Propriété native                                                                                       |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@go-like/nats/broker`     | `newNatsCoreBroker(connection, ...options)`                      | Drain de la souscription. `natsCoreDrainTimeout` borne l'attente, puis unsubscribe.                    |
| `@go-like/nats/jetstream`  | `newNatsJetStreamBroker(jetstream, messagesFactory, ...options)` | Itérateur du consommateur. `natsJetStreamCloseTimeout` borne la fermeture, puis l'arrêt.               |
| `@go-like/rabbitmq/broker` | `newRabbitMqBroker(channel)`                                     | L'objet de livraison du canal.                                                                         |
| `@go-like/rabbitmq/broker` | `startRecoveringRabbitMqBroker(...)`                             | Admet le handle avant que le connecteur soit prêt. La publication reste fermée jusqu'à une génération. |

Une connexion NATS ouverte par l'application appartient au palier ressources :

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

`connection`, `jetstream` et `messagesFactory` sont les objets que l'application a obtenus du client NATS. Les extraits ci-dessus sont la forme de propriété ; le README du plug a la construction du client.

## Événements typés

```ts
import { eventBroker } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

const payload = struct.object({ id: struct.string() })
const events = eventBroker(newMemoryBroker(), jsonCodec(payload))
```

`events.publish` encode. `event.decode()` décode une copie défensive. Un échec de codec est un échec Struct ou de protocole, pas une livraison réussie.

## Jobs

`newScheduleServer(schedule, name, handler)` de `@go-like/core/job` possède le minuteur, le chevauchement et le drain. `newIntervalSchedule(ms)` est le calendrier de core. `newCronerSchedule(pattern, options)` de `@go-like/croner/job` est un calendrier Croner pur : il ne démarre pas le minuteur propre de Croner. Passez-le à `newScheduleServer`.

`JobQueue.worker(handlers)` renvoie un `Server` pour le palier serveurs. La file elle-même, lorsqu'elle a besoin d'une connexion, appartient à `resources(...)` afin que le worker ne démarre qu'après que la file est utilisable et s'arrête avant la fermeture de la file.

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

`bullQueue` est la `Queue` BullMQ que l'application a construite, et `writeReport` est du code applicatif. `newBullMqJobQueue` adopte la file : `start` attend qu'elle soit prête, et `stop` la ferme une fois. `GO_LIKE_BULLMQ_UNEXPECTED_EXIT` signifie que le Worker s'est terminé sans `stop`. L'état de la file et le drain utilisent `GO_LIKE_JOB_STATE` et `GO_LIKE_JOB_DRAIN_TIMEOUT` de `@go-like/core/job`. `newPermanentJobError` marque un échec que la file ne doit pas réessayer. L'option `id` est la clé d'idempotence tant qu'un job inachevé la détient.

`@go-like/core/job/provider` (`runJob`, `enqueue`, `dispatchJob`) est destiné aux auteurs de plugs. Le code applicatif utilise `newScheduleServer` et `JobQueue`.

## Arrêt

L'ordre d'arrêt suit les paliers de [Architecture](/fr-Latn/guide/architecture). Un serveur broker s'arrête avec le palier serveurs. Une connexion ou une file dans `resources(...)` s'arrête ensuite, dans l'ordre inverse de déclaration. Un timeout de drain lance le unsubscribe ou la fermeture natifs et ne prouve pas que l'objet natif a terminé. Observez la promesse terminale du fournisseur avant de remplacer le propriétaire.

Les codes de sortie inattendue et de timeout de drain NATS sont sur `@go-like/nats/broker` et `@go-like/nats/jetstream`. Ils sont listés dans [Gestion des erreurs](/reference/errors).

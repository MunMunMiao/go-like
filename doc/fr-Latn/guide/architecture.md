# Architecture

go-like est une couche de composition. `@go-like/core` déclare les sockets et implémente les mécanismes qui n'ont pas besoin d'un client tiers. Un plug remplit un socket. L'application construit l'objet natif, construit le plug et choisit le palier d'App qui en est propriétaire.

La question utile est : qui admet cet objet, dans quel palier il se trouve, qui observe son résultat terminal, et quel runtime ou backend donne un sens à ce résultat ?

## Sockets et plugs

```text
Application composition root
  |
  +--> Context, metadata, struct, health, resilience     core mechanisms
  |
  +--> Lifecycle
  |      telemetry(tel) -> resources(...) -> server(...) -> registrar
  |
  +--> External Web
  |      Handler on @go-like/core/web
  |      host on @go-like/core/web/node or @go-like/core/web/bun
  |
  +--> Internal calls
  |      Client, Server, Transport
  |      memory and Fetch transports in core; gRPC on @go-like/connectrpc
  |
  +--> State
  |      Config, Registry, Store, Cache sockets
  |      memory references in core; Consul, etcd, Vault, Kubernetes,
  |      ZooKeeper, mDNS, YAML, Redis, and file plugs
  |
  +--> Messages and jobs
  |      Broker and Job sockets
  |      memory broker in core; NATS, RabbitMQ, BullMQ, and Croner plugs
  |
  +--> Telemetry sockets
         LogHandler, TracerProvider, MeterProvider, Propagator
         filled by @go-like/otel, @go-like/pino/log, @go-like/winston/log,
         @go-like/prometheus/metric
```

Core enregistre chaque unité de travail à un site d'appel fixe. Un plug n'enveloppe pas `newClient` ni un handler Web pour ajouter un span. La direction des imports à l'intérieur de core est imposée par `test/portable-lane.test.ts` : les couches basses n'importent pas l'entrée racine.

## Trois paliers

`newApp(...options)` applique les options dans l'ordre des arguments. Le même objet ne peut pas apparaître à la fois dans `resources(...)` et dans `server(...)`. Passer un bundle `Telemetry` à l'une ou l'autre liste est une erreur de type et un `TypeError` à l'exécution.

| Palier     | Option                                        | Démarrage                                                                                                                                                       | Arrêt                                                                                                                                        |
| ---------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Télémétrie | `telemetry(tel)` remplace le bundle précédent | En premier. Handlers de log, puis le tracer, puis les meters. Chaque `lifecycle.start` est contrôlé pour un échec immédiat. Un échec annule ceux déjà démarrés. | En dernier, après `afterStop`, sur son propre budget `stopTimeout`. Le tracer et les meters sont drainés ensemble, puis les handlers de log. |
| Ressources | `resources(...)` remplace la liste précédente | Après `beforeStart`, avant tout serveur. Ordre de déclaration. Chaque `start(ctx)` est attendu et doit se résoudre lorsque la ressource est utilisable.         | Après l'arrêt de chaque serveur lancé, ordre inverse de déclaration. Un échec d'arrêt est consigné et la ressource suivante s'arrête.        |
| Serveurs   | `server(...)` remplace la liste précédente    | Tous les appels `start` sont émis, puis un contrôle d'échec immédiat. `start` peut rester en attente jusqu'à la fin de l'objet natif. `Endpointer` facultatif.  | `stop` concurrent, puis chaque promesse `start` est jointe.                                                                                  |

Hooks : `beforeStart` s'exécute avant le palier ressources. `afterStart` s'exécute après l'enregistrement. `beforeStop` s'exécute avant le désenregistrement. `afterStop` s'exécute après le palier ressources et avant le drain de télémétrie. Les hooks de démarrage échouent immédiatement. Les hooks d'arrêt s'exécutent comme nettoyage.

L'enregistrement n'utilise que le palier serveurs. Une ressource est une dépendance, pas une adresse à annoncer.

```text
run()
  1  install signal() or another runtime option
  2  phase = starting
  3  admit telemetry
  4  open the start budget, if startTimeout is set
  5  beforeStart
  6  admit each resource and wait
  7  launch every server, then check for an immediate failure
  8  prepare endpoints and register, server tier only
  9  afterStart
 10  phase = ready; go_like.app.ready flips with the ready probe
 11  wait for stop or the first participant failure

stop()
  1  phase = stopping; the ready probe fails from this moment
  2  open the shared stop budget, if stopTimeout is set
  3  cancel the application Context
  4  join startup inside that budget
  5  beforeStop
  6  deregister
  7  cancel the server Context and stop launched servers concurrently
  8  join server start promises
  9  cancel the resource Context and stop owned resources in reverse order
 10  join resource start promises inside the same budget
 11  afterStop
 12  cancel the telemetry Context and stop the bundle on a fresh budget of the same length
```

`run()` ne s'exécute qu'une fois. `stop()` est idempotent et partage une seule promesse. `App.stop()` ne prend pas de Context. La première raison d'arrêt l'emporte : `requested` pour `App.stop()` et `signal()`, `context_canceled` lorsque le Context parent se termine, `start_failed` lorsque le démarrage échoue, `server_failed` lorsqu'un participant admis échoue après ready. Un seul échec est levé tel quel. Plusieurs échecs deviennent un `AggregateError` dans l'ordre des phases, la télémétrie en dernier.

Les Servers frères n'ont pas de garantie d'ordre inverse. Si un worker doit s'arrêter avant sa file, placez la file dans `resources(...)` et le worker dans `server(...)`. Le palier ressources existe pour que cette combinaison attende l'admission. Un `Server` écrit à la main dont `start` ne se résout jamais bloque l'admission des ressources ; utilisez `newResourceServer` pour un objet natif, ou placez un participant de longue durée dans `server(...)`.

## Portées de Context

```text
parent
  -> appContext          canceled at the start of stop
       -> telemetryContext    canceled just before Telemetry.stop
       -> resourceContext     canceled just before the resource tier stops
       -> serverContext       canceled just before Server.stop
       -> startContext        appContext, plus startTimeout when configured
       -> stopContext         withoutCancel(appContext), plus the shared stopTimeout
       -> telemetryStop       a second stopTimeout, opened when the drain begins
```

Un `start(ctx)` de longue durée reçoit le Context de son propre palier. Ce Context reste vivant jusqu'à ce que ce palier soit prié de s'arrêter, de sorte qu'une ressource ne voit pas l'annulation pendant que les serveurs sont encore en drain. La télémétrie utilise son propre Context pour la même raison : annuler `appContext` au début de l'arrêt ne doit pas drainer la télémétrie avant les serveurs qu'elle observe.

## Budgets et propriété

`startTimeout` couvre les hooks, l'admission des ressources, la préparation des endpoints, l'enregistrement et `afterStart`. Il ne couvre pas l'admission de la télémétrie, et il ne transforme pas le `start` d'un serveur en promesse de readiness. La valeur par défaut `0` signifie l'absence de limite. `registrarTimeout` vaut 10 secondes par défaut et borne les appels d'enregistrement et de désenregistrement.

`stopTimeout` est le budget d'attente de l'appelant partagé par les hooks, le désenregistrement, le palier serveurs et le palier ressources. Le drain de télémétrie ouvre un second budget de la même durée lorsque cette phase commence, de sorte qu'un export peut encore se terminer après l'épuisement du budget partagé. Un drain qui ne se règle jamais fait attendre `App.run()` environ deux fois `stopTimeout`. La valeur par défaut `0` signifie l'absence de limite pour les deux. Lorsque le budget partagé est déjà épuisé, les appels `stop` ultérieurs sont tout de même émis. Core n'attend pas davantage, et un timeout n'est pas un état terminal natif. Les timeouts appartenant au plug restent avec le plug : l'arrêt OpenTelemetry attend 25 secondes par défaut, le drain Pino attend 25 secondes par défaut, et le handler Winston n'a pas de timeout de drain propre.

Après la résolution de `start`, l'App est propriétaire du participant. `newResourceServer({ open, terminal, close })` résout `start` lorsque `open` se termine, ou immédiatement lorsque `open` est omis. `close` est le drain unique du propriétaire et est appelé avec `withoutCancel` du premier Context d'arrêt. Si `open` échoue, `close` n'est pas appelé. Un second `start` est rejeté avec `GO_LIKE_RESOURCE_ALREADY_STARTED`. Un règlement `terminal` propre avant l'arrêt fait échouer l'App avec `GO_LIKE_RESOURCE_CLOSED`. Une résolution `Error` ou un rejet fait échouer l'App avec cette erreur. La promesse terminale est observée en privé ; ce n'est pas un champ public du socket.

## Readiness

`readyProbe(registry, name?)` enregistre une probe synchrone, de nom par défaut `"app"`. Elle ne réussit que pendant que `run()` est dans la phase ready, et elle bascule au même instant que la jauge `go_like.app.ready`. En dehors de cette fenêtre, elle lève `AppNotReadyError` (`GO_LIKE_APP_NOT_READY`) avec `phase` `created`, `starting`, `stopping` ou `stopped`. Après le règlement de `run()`, la probe est retirée. Une App qui n'a jamais été exécutée reste `created`.

`createHealthHandler(probes)` projette `/livez` et `/readyz`. Une liveness vide réussit. Une readiness vide échoue en position fermée, de sorte qu'un handler sans `readyProbe` ni autre probe ready renvoie 503 pour `/readyz`. Chaque probe ready enregistrée doit réussir. Core n'enregistre pas de probe de liveness.

Un listener `newServer` interne répond encore à `GET` et `HEAD` `/healthz` par un 200 vide. Cette réponse signifie que le listener unaire a accepté la requête. Ce n'est pas le registre de probes.

## Listeners et ports publiés

Les exemples qui se lient à `127.0.0.1` puis appellent cette adresse ont la bonne forme locale. Un port publié par Docker peut accepter le TCP à travers le proxy avant que le conteneur ne serve le protocole. Atteignez Redis, AMQP, etcd et le HTTP applicatif sur le réseau Compose par le DNS de service lorsque c'est la topologie que vous avez démarrée.

`Server.start(ctx)` sur le palier serveurs ne signifie pas ready. `Endpointer.endpoint(ctx)` renvoie une adresse qui peut être annoncée. `afterStart` signifie que Core a atteint ce hook.

`startRecoveringRabbitMqBroker` peut admettre un handle de broker avant la fin de la mise en place du connecteur, de sorte que HTTP peut se lier sans attendre AMQP. La publication reste fermée jusqu'à l'existence d'une génération. C'est l'admission du handle, pas une route de santé.

## Chemin de requête

```text
External Web
  Request -> framework or Handler -> Response -> host writes the body

Internal unary
  Context + operation
    -> Client middleware
    -> direct address or Discovery snapshot
    -> Filters, then Selector
    -> Transport
    -> POST /<service>/<endpoint>
    -> Server middleware, Struct decode, handler, Struct encode
```

L'identité d'opération est `service/endpoint`, par exemple `appointment-policy.v1/check`. Un endpoint de `ServiceInstance` est une adresse de transport opaque, par exemple `memory://orders` ou `https://orders.example`.

## Portabilité des runtimes

Les entrées portables utilisent JavaScript standard et les API Web, ou des capacités injectées par l'appelant. Une entrée portable ne promet pas un listener TCP, des signaux de processus, des surveillances de fichiers, du multicast UDP ni un client fournisseur.

| Entrée                                                                                          | Où elle s'exécute                                                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Entrées de concept de `@go-like/core`, y compris `/web`, `/transport/http`, `/transport/memory` | Portable. `/transport/http` compose avec Fetch. L'écoute exige un host injecté.                     |
| `@go-like/core/node`, `/transport/http/node`, `/web/node`, `/config/node`                       | API Node. `/web/node` peut aussi s'exécuter là où ces API existent.                                 |
| `@go-like/core/web/bun`                                                                         | Host Bun.                                                                                           |
| `@go-like/mdns/registry/node`, `@go-like/zookeeper/registry/node`, `@go-like/file/store/node`   | Host Node pour ce plug. L'entrée sœur reste portable au-dessus d'un host ou d'une factory injectés. |
| `@go-like/connectrpc`                                                                           | Handler Fetch portable.                                                                             |
| `@go-like/connectrpc/node`                                                                      | Serveur et client gRPC Node.                                                                        |
| NATS, RabbitMQ, Redis, BullMQ                                                                   | Node et Bun, selon le client natif.                                                                 |

Les exports de paquets n'utilisent pas de conditions `bun` ou `node`. Importez le sous-chemin que vous visez. La bibliothèque TypeScript `DOM` fournit les types. Ce n'est pas un polyfill d'exécution.

## Composition

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { newNodeServer, port } from "@go-like/core/web/node"

const policy = defineService("policy", {
  check: {
    request: struct.object({ ok: struct.boolean() }),
    response: struct.object({ ok: struct.boolean() })
  }
})

const transport = newMemoryTransport()
const policyServer = newServer(serverTransport(transport), address("memory://policy"))
policy.registerHandler(policyServer, {
  check() {
    return { ok: true }
  }
})
const policyClient = newClient(withTransport(transport), withEndpoint("memory://policy"))
const webServer = newNodeServer((_request: Request) => new Response("ok"), port(3000))

const app = newApp(
  name("appointments"),
  server(policyServer, webServer),
  afterStop(async (ctx) => {
    await policyClient.close(ctx)
  }),
  signal()
)
void app
```

`newApp` ne devient pas un conteneur, et un transport mémoire ne devient pas un réseau. Les identifiants, les factories et l'arrêt des objets qui n'ont pas été donnés à l'App restent dans la racine de composition.

Les notes de conception plus anciennes utilisent des noms tels que `ServerHandle` et `AppHandle`. Les signatures de cette page sont celles exportées aujourd'hui. `Server` et `Endpointer` sont exportés depuis `@go-like/core/lifecycle`, pas depuis l'entrée racine.

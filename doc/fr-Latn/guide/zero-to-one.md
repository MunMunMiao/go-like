# Réserver un rendez-vous en clinique : de 0 à 1

Voici un parcours guidé de 0 à 1 pour apprendre go-like à partir d'un invariant métier concret, plutôt qu'avec un Todo générique. Il décrit une cible et des checkpoints exécutables ; il ne prétend pas que l'arborescence cible existe déjà comme une application complète à copier-coller. Le projet est un service de prise de rendez-vous pour une clinique, avec un service de policy en processus, un repository canonique des rendez-vous, un cache de disponibilité jetable, des endpoints de santé et un cycle de vie d'application explicite.

Le dépôt contient déjà `examples/healthcare-appointments`, qui sert d'implémentation de départ pour ce guide. Son code actuel utilise une gestion JSON brute de `Message` pour le service de policy. La version typée avec `Endpoint` et `Struct` présentée ci-dessous est une trajectoire d'amélioration documentée, construite à partir des exports publics actuels ; elle n'a pas été ajoutée à l'exemple pendant cette phase de documentation. Gardez cette distinction lorsque vous rendez compte de la vérification.

## L'invariant

Le service doit respecter cinq règles :

1. Un médecin ne peut pas avoir de rendez-vous actifs qui se chevauchent.
2. Une annulation libère le créneau.
3. Répéter la même demande de rendez-vous avec le même identifiant de rendez-vous est idempotent.
4. Réutiliser un identifiant de rendez-vous avec un contenu différent est refusé.
5. La disponibilité est mise en cache uniquement pour accélérer les lectures ; le repository reste la source faisant autorité.

L'exemple actuel du dépôt implémente les quatre premières règles avec un repository en mémoire et valide la durée maximale d'un rendez-vous via un service de policy interne. Il ne prétend fournir ni base de données, ni verrou distribué, ni cache durable, ni authentification, ni workflow de réservation prêt pour la production.

## Ce que vous allez construire

```text
clinic-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- contract.ts       # typed policy Endpoint and Structs
|   |-- service.ts        # domain invariant and canonical repository
|   |-- transport.ts      # policy Server and Client over Memory Transport
|   |-- cache.ts          # availability cache and invalidation policy
|   |-- http.ts           # Fetch routes and health delegation
|   `-- main.ts           # one composition root and one Core App
`-- test/
    |-- main.test.ts      # domain, typed call, HTTP, cache, health, cancellation
    `-- node-e2e.ts       # real bind, request, stop, and port release
```

L'exemple actuel du workspace a cette arborescence plus petite :

```text
examples/healthcare-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- service.ts
|   |-- transport.ts      # current raw JSON policy boundary
|   |-- http.ts
|   `-- main.ts
`-- test/main.test.ts
```

La seconde arborescence est la source de vérité de ce qui se trouve déjà dans le checkout. La première est la forme cible des jalons du tutoriel.

## Prérequis et commandes

Depuis la racine du dépôt :

```sh
bun install --frozen-lockfile
```

Les paquets sont des dépendances du workspace dans ce checkout. Le dépôt racine indique Bun `1.3.14`, Node.js `26.x`, Deno `2.9.4`, TypeScript `7.0.2` et k6 `2.1.0` dans sa matrice de validation ; tout patch de Node.js 26.x convient. La documentation actuelle des paquets précise qu'ils ne sont pas encore publiés sur npm.

Lancez l'exemple de référence existant :

```sh
HOST=127.0.0.1 PORT=3000 bun run --cwd examples/healthcare-appointments start
```

Le script `start` construit les paquets racine, crée un bundle préparé pour Node puis l'exécute. Attendez la ligne `GO_LIKE_EXAMPLE_READY` avant d'envoyer du trafic. Dans un autre terminal :

```sh
NOW=$(($(date +%s) * 1000))
curl -i -sS http://127.0.0.1:3000/v1/appointments \
  -H 'content-type: application/json' \
  -d "{\"appointmentId\":\"appointment-1\",\"doctorId\":\"doctor-1\",\"patientId\":\"patient-1\",\"startsAt\":$((NOW + 3600000)),\"endsAt\":$((NOW + 5400000))}"

curl -i -sS -X DELETE \
  http://127.0.0.1:3000/v1/appointments/appointment-1
```

Arrêtez le processus au premier plan avec `Ctrl-C`. Ne démarrez pas une seconde App cachée pour le service de policy ; l'exemple actuel place le Server de policy et le Web Server dans la même Core App.

Les vérifications ciblées de l'exemple actuel sont :

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
```

L'exemple déclare également un wrapper E2E :

```sh
bun run --cwd examples/healthcare-appointments test:e2e
```

Cette commande construit et exécute la tâche E2E de l'exemple. C'est une commande à lancer, pas une affirmation que le checkout actuel l'a déjà passée.

## M0 : commencer par les règles métier

Le module métier est Context-first, même si la section critique du repository en mémoire est synchrone. L'annulation et le remplacement futur du fournisseur restent ainsi visibles à la frontière :

```ts
import type { Context } from "@go-like/context"

export interface BookAppointmentCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

export type AppointmentStatus = "booked" | "cancelled"

export interface Appointment extends BookAppointmentCommand {
  readonly status: AppointmentStatus
}

export interface AppointmentRepository {
  book(ctx: Context, command: BookAppointmentCommand): Appointment
  cancel(ctx: Context, appointmentId: string): Appointment
  get(ctx: Context, appointmentId: string): Appointment | undefined
}
```

Le repository doit vérifier `ctx.err()` avant de modifier l'état. L'exemple actuel le fait dans `newMemoryAppointmentRepository()` et conserve une empreinte avec chaque rendez-vous. Son prédicat de chevauchement est :

```ts
function overlaps(
  leftStartsAt: number,
  leftEndsAt: number,
  rightStartsAt: number,
  rightEndsAt: number
): boolean {
  return leftStartsAt < rightEndsAt && rightStartsAt < leftEndsAt
}
```

Ce prédicat autorise les rendez-vous adjacents, tandis que les rendez-vous actifs qui se chevauchent pour un même médecin échouent. L'annulation fait passer le statut stocké à `cancelled` ; une deuxième annulation renvoie le même enregistrement annulé.

### Tests M0

Écrivez ces tests avant d'ajouter HTTP ou le transport :

```ts
import { background } from "@go-like/context"
import { expect, test } from "bun:test"

// The concrete repository factory is the one in src/service.ts.
test("rejects an overlapping active slot", () => {
  const repository = newMemoryAppointmentRepository()
  const book = newBookAppointment(repository, () => 1_000)
  book(background(), {
    appointmentId: "a-1",
    doctorId: "doctor-1",
    patientId: "patient-1",
    startsAt: 2_000,
    endsAt: 3_000
  })

  expect(() =>
    book(background(), {
      appointmentId: "a-2",
      doctorId: "doctor-1",
      patientId: "patient-2",
      startsAt: 2_500,
      endsAt: 3_500
    })
  ).toThrow("doctor time conflict")
})
```

Le `test/main.test.ts` actuel contient ce cas, ainsi que la réutilisation après annulation, l'annulation idempotente et une vérification du handler HTTP. Ces tests constituent une preuve inspectée dans le dépôt jusqu'à l'exécution de la commande ci-dessus dans votre environnement.

## M1 : un service de policy interne typé

Le contrat interne typé utilise `@go-like/struct` et `@go-like/transport`. Il s'agit d'une validation à l'exécution sur une frontière `Message` unaire, pas d'un IDL ni d'un service RPC généré.

### `src/contract.ts`

```ts
import { struct, type Infer } from "@go-like/struct"
import { endpoint } from "@go-like/transport"

const CheckRequest = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const CheckResponse = struct.object({
  allowed: struct.boolean()
})

export type CheckRequest = Infer<typeof CheckRequest>
export type CheckResponse = Infer<typeof CheckResponse>

export const checkAppointment = endpoint(
  "appointment-policy",
  "AppointmentPolicy.Check",
  CheckRequest,
  CheckResponse
)
```

Les tokens de route sont en ASCII visible et ne peuvent pas contenir `/` ni `*`. L'`Endpoint` contient les instances de `Struct` de la requête et de la réponse, ainsi que les deux tokens de route. Il ne décrit ni une adresse réseau ni un client généré.

### `src/transport.ts`

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"

import { checkAppointment, type CheckRequest, type CheckResponse } from "./contract"

const policyAddress = "memory://appointment-policy"

export interface AppointmentPolicy {
  readonly server: Server
  validate(ctx: Context, request: CheckRequest): Promise<CheckResponse>
  close(ctx: Context): Promise<void>
}

export function newAppointmentPolicy(maximumDurationMs = 7_200_000): AppointmentPolicy {
  const transport = newMemoryTransport()
  const client = newClient(withTransport(transport))
  const server = newServer(
    serverTransport(transport),
    address(policyAddress),
    handler(checkAppointment, (_ctx, request) => {
      if (request.endsAt - request.startsAt > maximumDurationMs) {
        throw new Error("appointment duration exceeds policy")
      }
      return { allowed: true }
    })
  )

  return Object.freeze({
    server,
    async validate(ctx: Context, request: CheckRequest): Promise<CheckResponse> {
      return await client.call(ctx, checkAppointment, request, withAddress(policyAddress))
    },
    close(ctx: Context): Promise<void> {
      return client.close(ctx)
    }
  })
}
```

L'exemple actuellement versionné utilise un handler de policy basé sur un `Message` brut et un `serviceError(...)` avec le statut `409`. C'est une frontière valide, plus bas niveau. La version typée ci-dessus modifie le codec de la requête et de la réponse, mais pas le modèle fondamental de propriété : une instance de Memory Transport, un Server interne, un Client et une fermeture explicite.

### Transmettre le Context

Le cas d'utilisation de réservation doit transmettre le même Context de la requête au Client de policy et au repository :

```ts
async function validatedBook(ctx: Context, command: CheckRequest): Promise<Appointment> {
  await policy.validate(ctx, command)
  return repository.book(ctx, command)
}
```

Remplacer `ctx` par `background()` supprimerait l'échéance, l'annulation et l'ascendance du Context de la requête. C'est une régression de correction, pas une simplification anodine.

### Tests M1

Testez tout ce qui suit :

| Test                      | Résultat attendu                                           |
| ------------------------- | ---------------------------------------------------------- |
| requête typée valide      | `allowed: true` et un rendez-vous réservé                  |
| requête trop longue       | échec de la policy avant la mutation du repository         |
| type de champ invalide    | échec du décodage de la requête typée                      |
| forme de réponse invalide | échec de l'encodage de la réponse à la frontière du Server |
| Context annulé            | la policy et le repository observent la même annulation    |
| fermeture du client       | le nettoyage du Client résident du Transport est explicite |

Le test de policy de l'exemple vérifie déjà le refus avant mutation du repository et le succès via `Client -> Memory Transport -> Server`. Le test typé est une extension proposée.

## M2 : le Cache de disponibilité

Le Cache sert à une projection de lecture, pas à l'autorité de réservation. Le paquet Cache expose `get`, `put` et `delete` avec Context en premier argument ; `@go-like/cache-memory` fournit `newMemoryCache()` et `@go-like/cache` fournit `expiresIn(...)` :

```ts
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"

const availabilityCache = newMemoryCache()

async function readAvailability(ctx: Context, doctorId: string) {
  const key = `availability/${doctorId}`
  const cached = await availabilityCache.get(ctx, key)
  if (cached !== null) {
    return JSON.parse(new TextDecoder().decode(cached)) as Availability
  }

  const authoritative = repository.readAvailability(ctx, doctorId)
  await availabilityCache.put(
    ctx,
    key,
    new TextEncoder().encode(JSON.stringify(authoritative)),
    expiresIn(30_000)
  )
  return authoritative
}

async function invalidateAvailability(ctx: Context, doctorId: string): Promise<void> {
  await availabilityCache.delete(ctx, `availability/${doctorId}`)
}
```

`repository.readAvailability(...)` est une méthode détenue par l'application dans ce tutoriel, pas un export go-like. La réservation et l'annulation doivent invalider la clé après la mutation faisant autorité. Si l'invalidation échoue, signalez-le et choisissez une policy de cohérence explicite ; ne traitez pas silencieusement le Cache comme la source de vérité des réservations.

### Tests M2

- un miss lit le repository et alimente le Cache ;
- un hit ne relit pas le repository ;
- une réservation ou une annulation supprime la projection ;
- une valeur expirée revient au repository ;
- une panne du Cache ne transforme pas une lecture correcte de la source faisant autorité en faux résultat de réservation ;
- le redémarrage du processus perd par conception l'état du Memory Cache.

## M3 : vivacité et disponibilité

Créez le registry dans le composition root et déléguez deux chemins à `createHealthHandler(...)` :

```ts
import { createHealthHandler } from "@go-like/web/health"
import { newProbeRegistry } from "@go-like/health"
import type { Handler } from "@go-like/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policy.server.endpoint(ctx)
})

const healthHandler = createHealthHandler(probes)
const appointmentHandler: Handler = newAppointmentHandler(book, cancel)

const webHandler: Handler = (request) => {
  const path = new URL(request.url).pathname
  if (path === "/livez" || path === "/readyz") return healthHandler(request)
  return appointmentHandler(request)
}
```

Les routes par défaut sont `/livez` et `/readyz`. Une liveness vide est saine ; une readiness vide échoue par défaut. La probe `policy` ci-dessus fait dépendre la readiness de l'admission du listener interne, sans prétendre qu'une base de données externe définit toujours la vivacité du processus.

Un service de production ne devrait ajouter que les dépendances de readiness réellement nécessaires pour accepter du trafic. Les noms des probes sont des identifiants publics et les payloads de santé sont volontairement nettoyés.

## M4 : un seul propriétaire du cycle de vie

Le composition root doit construire les ressources une seule fois et les placer sous une App :

```ts
import process from "node:process"
import { afterStart, afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

const policy = newAppointmentPolicy()
const httpServer = newNodeServer(webHandler, hostname("127.0.0.1"), port(3000))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=healthcare-appointments\n")
  }),
  afterStop((ctx) => policy.close(ctx))
)

await app.run()
```

Le hook `afterStop` constitue une frontière explicite d'ordonnancement pour le Client de policy. Core arrête les Servers frères en parallèle. Si un ordre de dépendances plus complexe est nécessaire, composez les ressources dépendantes dans un seul Server ou dans un hook explicite, plutôt que de compter sur l'ordre de déclaration.

`signal()` est l'adaptateur de processus Node/Bun. Le domaine, le contrat typé, le Memory Transport et les modules de santé peuvent rester portables ; l'import depuis `@go-like/core/node` est un choix de runtime délibéré.

## M5 : plan de tests et preuves

| Couche       | Test                                                                            | Cible de preuve                                               |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Domaine      | chevauchement, réutilisation après annulation, idempotence, ID en conflit       | comportement de `src/service.ts` et résultat du test unitaire |
| Context      | une réservation annulée ne modifie pas le repository et n'appelle pas la policy | test Context ciblé                                            |
| Appel typé   | décodage/encodage Struct, refus de la policy, validation de la réponse          | frontière `@go-like/client` et `@go-like/server`              |
| Cache        | miss, hit, TTL, invalidation, repli après échec                                 | tests de `newMemoryCache()`                                   |
| Santé        | liveness vide, readiness vide, probe en échec, 405/404                          | `newProbeRegistry()` et `createHealthHandler()`               |
| HTTP         | `POST`, `DELETE`, JSON invalide, statut de conflit                              | test du Handler Fetch standard                                |
| Cycle de vie | policy et Web Server admis sous une App ; fermeture explicite du Client         | comportement terminal de Core App et Server                   |
| Node E2E     | bind réel, requête, signal, arrêt, libération du port                           | wrapper E2E de l'exemple et contrôles résiduels               |

Pour l'exemple actuel du dépôt, les commandes ciblées sont :

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
bun run --cwd examples/healthcare-appointments test:e2e
```

Pour toute la lane des examples :

```sh
bun run test:e2e:examples
```

La lane E2E complète construit les paquets et utilise le runner du dépôt. Les fournisseurs Docker et les consommateurs multi-runtime couvrent des périmètres séparés. Notez le commit candidat, les versions de runtime, le code de sortie, le résumé et les processus ou conteneurs résiduels ; la présence d'un script ne constitue pas un résultat positif.

## Jalons

| Jalon | Livrable                                       | Passez au suivant lorsque...                                                       |
| ----- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| M0    | Repository métier et tests d'invariants        | le chevauchement et l'annulation sont déterministes                                |
| M1    | Endpoint de policy typé sur Memory Transport   | l'appel passe réellement par Client/Server/Transport, pas par une fonction directe |
| M2    | Projection de Cache avec invalidation          | une panne du Cache ne peut pas remplacer l'autorité                                |
| M3    | `/livez` et `/readyz`                          | readiness vide et probes en échec sont compris                                     |
| M4    | Une App, signal, nettoyage explicite du Client | chaque ressource admise a un propriétaire                                          |
| M5    | Preuves unitaires et Node E2E                  | les résultats sont consignés avec commande et code de sortie                       |

N'ajoutez pas Registry, Redis, Vault, un broker réel, l'authentification ou les retries avant que ces jalons soient clairs. Chacun introduit un nouveau modèle de propriété ou d'échec qu'il vaut mieux ajouter délibérément.

## Dépannage

### `Cannot find package "@go-like/..."`

Vous exécutez probablement la commande hors du workspace ou vous dépendez d'un paquet non publié. Lancez `bun install --frozen-lockfile` depuis la racine du dépôt et utilisez un script du workspace, par exemple `bun run --cwd examples/healthcare-appointments start`.

### La requête renvoie `404`

L'exemple actuel n'expose que `POST /v1/appointments` et `DELETE /v1/appointments/{appointmentId}`. Vérifiez la méthode, le chemin et la ligne `GO_LIKE_EXAMPLE_READY`. Les routes de santé appartiennent à l'extension tutorielle M3, pas à l'exemple actuellement versionné.

### La requête renvoie `400`

L'exemple exige des identifiants de type string et des valeurs numériques pour `startsAt`/`endsAt`. `startsAt` doit être dans le futur par rapport à l'horloge injectée et `endsAt` doit être supérieur à `startsAt`. Vérifiez que l'arithmétique du shell a produit des nombres, et non des chaînes entre guillemets.

### La requête renvoie `409`

Un créneau de médecin chevauche un rendez-vous actif, un identifiant de rendez-vous a été réutilisé avec un contenu différent ou le service de policy a refusé la durée. La policy est appelée avant la mutation du repository : un refus de policy ne devrait donc pas créer d'enregistrement.

### Un appel typé signale un corps de requête ou de réponse invalide

Vérifiez que le client et le serveur utilisent les mêmes `Endpoint` Structs et que le Content-Type de la requête est exactement `application/json`. `handler(contract, fn)` effectue la validation JSON et Struct à la frontière du Server.

### Le Memory Client n'atteint pas le Server

`newMemoryTransport()` crée une table d'adresses privée à chaque instance. Le Client et le Server doivent partager la même instance de Transport et l'adresse `memory:` exactement liée. Une URL identique dans deux instances de Memory Transport construites séparément ne permet pas la connexion.

### `app.run()` semble rester bloqué

Un `Server.start(ctx)` de longue durée peut rester en attente pendant toute la durée de vie du service. C'est prévu. `app.run()` se résout après l'arrêt et le nettoyage terminal, pas juste après qu'un listener a été lié. Utilisez `afterStart` ou `server.endpoint(ctx)` comme signal d'admission.

### L'arrêt renvoie un timeout ou une erreur agrégée

Le timeout borne l'attente de nettoyage du caller. Il ne prouve pas qu'une ressource native s'est arrêtée, et les Servers frères s'arrêtent en parallèle. Examinez l'erreur principale, la barrière terminale de l'adaptateur et les preuves de processus ou de socket résiduels avant de considérer l'arrêt comme propre.

### Les données du Cache ont disparu

`@go-like/cache-memory` est local au processus et jetable. Utilisez un fournisseur de Store explicite pour les enregistrements faisant autorité et documentez sa durabilité et sa propriété réelles, au lieu de traiter un Cache comme une base de données.

## Récapitulatif des frontières

Ce projet montre un parcours réel dans go-like tout en restant petit :

```text
Request
  -> standard Fetch Handler
  -> Context-first appointment use case
  -> typed Client call
  -> Memory Transport
  -> unary Server policy handler
  -> canonical appointment repository
  -> disposable availability Cache
  -> Response

App.stop()
  -> deregistration if configured
  -> concurrent Server stop
  -> explicit Client / provider cleanup
  -> terminal result
```

Il n'enseigne ni gRPC, ni Protobuf, ni génération d'IDL, ni streams internes full-duplex, ni verrou distribué, ni messagerie durable, ni authentification de production. Ce sont des décisions de conception distinctes, en dehors de ce petit projet.

# Rendez-vous en clinique : de 0 à 1

Ce parcours suit un invariant métier à travers un appel de policy interne, un handler Fetch, la santé et une App. L'arborescence exécutable est `examples/healthcare-appointments`. Les extraits ci-dessous utilisent les noms de cet exemple. Un cache de disponibilité jetable est un jalon supplémentaire que vous ajoutez dans la même racine de composition. Ce n'est pas une seconde source de vérité.

## L'invariant

1. Un médecin ne peut pas avoir de rendez-vous actifs qui se chevauchent.
2. Une annulation libère le créneau.
3. Répéter le même identifiant de rendez-vous avec le même contenu est idempotent.
4. Réutiliser un identifiant de rendez-vous avec un contenu différent est refusé.
5. Une projection de disponibilité mise en cache, si vous en ajoutez une, n'autorise jamais une réservation à elle seule.

L'exemple implémente les quatre premières règles avec un repository en mémoire et contrôle une durée maximale via `appointment-policy.v1/check`. Il ne revendique ni base de données, ni verrou distribué, ni authentification, ni workflow de clinique en production.

## Disposition

```text
examples/healthcare-appointments/
  src/contract.ts    defineService and Structs
  src/service.ts     repository and booking rules
  src/transport.ts   memory Server and Client
  src/http.ts        Fetch handler
  src/main.ts        Node host and App
  test/main.test.ts
```

Depuis la racine du dépôt :

```sh
bun install --frozen-lockfile
bun run --cwd examples/healthcare-appointments test:unit
```

La version de paquet `0.0.1` n'établit pas la disponibilité sur npm. Dans ce checkout, la seule dépendance go-like dont l'exemple a besoin est `@go-like/core`.

## M0 : règles de domaine

`src/service.ts` possède `BookAppointmentCommand`, le repository et le contrôle de chevauchement. Le Context est le premier argument même lorsque le repository en mémoire ne bloque pas. Un store ou un cache ultérieur peut utiliser la même signature.

L'exemple refuse un mauvais identifiant, une fenêtre non positive, un chevauchement et un identifiant réutilisé avec un contenu différent. Les tests de ces cas se placent à côté du repository, sans App et sans HTTP.

## M1 : le service de policy

`src/contract.ts` lie l'opération :

```ts
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"

const command = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: command,
    response: struct.object({ allowed: struct.literal(true) })
  }
})
```

`src/transport.ts` place les deux extrémités sur un transport mémoire. L'adresse `memory://appointment-policy.v1` n'est pas le nom de l'opération.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { appointmentPolicy } from "./contract"

const transport = newMemoryTransport()
const server = newServer(serverTransport(transport), address("memory://appointment-policy.v1"))
appointmentPolicy.registerHandler(server, {
  check(_ctx, command) {
    if (command.endsAt - command.startsAt > 7_200_000) {
      throw serviceError("appointment_policy_rejected", "appointment duration exceeds policy", 409)
    }
    return { allowed: true as const }
  }
})
const caller = appointmentPolicy.newClient(
  newClient(withTransport(transport), withEndpoint("memory://appointment-policy.v1"))
)
```

`src/http.ts` est un `contextHandler`. Il transmet le Context de requête vers la réservation et l'annulation. HTTP 400 est un corps mal formé. HTTP 409 est une réservation refusée. Ces statuts sont le choix du handler Web. L'échec de policy est une `ServiceError` de statut 409 sur l'appel interne.

## M2 : cache de disponibilité

Un cache mémoire est facultatif et local au processus. Les clés et les valeurs sont des octets. Le repository reste faisant autorité : une présence en cache saute une lecture, une absence ou une expiration relit, et une réservation ou une annulation supprime la clé. Une erreur de cache ne doit pas devenir une réservation réussie.

```ts
import { expiresIn } from "@go-like/core/cache"
import { newMemoryCache } from "@go-like/core/cache/memory"

const cache = newMemoryCache()
await cache.put(ctx, key, bytes, expiresIn(5_000))
const hit = await cache.get(ctx, key)
```

`newMemoryCache` n'est pas un `Server`. `@go-like/redis/cache` est un `Server` ; celui-là va dans `resources(...)`.

## M3 : liveness et readiness

Créez un registre, pointez l'App vers lui, et répartissez `/livez` et `/readyz` vous-même. Sans `readyProbe`, `/readyz` reste 503.

```ts
import { newApp, readyProbe, server } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler, type Handler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policyServer.endpoint(ctx)
})
const health = createHealthHandler(probes)

const handler: Handler = async (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return appointmentHandler(request)
}

const app = newApp(readyProbe(probes), server(policyServer, web))
void handler
void app
```

## M4 : un propriétaire de cycle de vie

`src/main.ts` de l'exemple est la racine de composition : repository, service de policy, handler, `newNodeServer`, `signal()`, et `afterStart` qui attend `endpoint(ctx)` avant d'écrire `GO_LIKE_EXAMPLE_READY`. Ajoutez `readyProbe` lorsque vous exposez `/readyz`. Fermez le client de policy dans `afterStop` s'il survit au serveur mémoire.

```ts
import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"

const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
  })
)
await app.run()
```

`server(...)` lance les deux participants ensemble. Le serveur de policy est dans le processus, donc il n'a pas besoin du palier ressources. Un cache Redis ou un store fichier en aurait besoin.

## M5 : ce que les tests établissent

`test/main.test.ts` exerce les règles en mémoire et l'appel interne. Un test unitaire réussi n'établit ni Docker, ni un tarball publié, ni un système de réservation en production. Consignez la commande si vous revendiquez un résultat. Voir [Vérification](/fr-Latn/reference/verification).

## Dépannage

| Symptôme                          | Contrôle                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `Cannot find package`             | Exécutez `bun install --frozen-lockfile`. Les imports sont `@go-like/core/...`.         |
| HTTP 404                          | Le handler ne connaît pas ce chemin. Les routes de santé ne sont pas montées pour vous. |
| HTTP 400                          | Le corps JSON a échoué au contrôle propre du handler.                                   |
| HTTP 409                          | Le repository ou la policy a refusé la commande.                                        |
| L'appel typé échoue la validation | La requête ou la réponse ne correspond pas au Struct.                                   |
| Le client ne joint pas le serveur | Le client et le serveur doivent partager une instance `newMemoryTransport()`.           |
| `app.run()` ne revient pas        | Il attend l'arrêt. `signal()` ou `app.stop()` y met fin.                                |
| `EADDRINUSE`                      | Le port est pris.                                                                       |
| La valeur de cache a disparu      | Le cache mémoire est local au processus. Le TTL et `delete` la retirent aussi.          |
| `/readyz` vaut 503                | Enregistrez une probe ready, y compris `readyProbe(probes)`.                            |

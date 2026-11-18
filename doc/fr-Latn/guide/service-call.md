# Appels de service

Un appel de service interne est un échange Fetch. Le nom de l'opération et l'adresse de transport sont des valeurs différentes. Un appel typé ajoute la validation Struct sur le corps JSON. Le RPC Protobuf généré est un chemin séparé ; voir [Streaming](/fr-Latn/guide/streaming).

## Identité d'opération et adresse

`defineService("appointment-policy.v1", { check })` nomme l'opération `appointment-policy.v1/check`. `withEndpoint("memory://appointment-policy.v1")` et `address("memory://appointment-policy.v1")` nomment la destination des octets. Une `ServiceInstance` de registre stocke les URL de transport dans `endpoints`. Les filtres et les sélecteurs choisissent parmi ces URL. Ils ne choisissent pas l'opération.

## Memory Transport typé

Utilisez un seul `newMemoryTransport()` pour les deux côtés. Il est local au processus et privé à l'instance. C'est la forme de `examples/healthcare-appointments` :

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { name, newApp, server } from "@go-like/core"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService, serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const math = defineService("math", {
  add: {
    request: struct.object({ left: struct.number(), right: struct.number() }),
    response: struct.object({ sum: struct.number() })
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://math"))
math.registerHandler(rpc, {
  add(_ctx, request) {
    if (!Number.isFinite(request.left) || !Number.isFinite(request.right)) {
      throw serviceError("math_rejected", "operands must be finite", 400)
    }
    return { sum: request.left + request.right }
  }
})

const client = newClient(withTransport(transport), withEndpoint("memory://math"))
const api = math.newClient(client)
const app = newApp(name("math"), server(rpc))
const running = app.run()
await rpc.endpoint(background())
try {
  const result = await api.add(background(), { left: 2, right: 3 })
  console.log(result.sum)
} finally {
  await client.close(background())
  await app.stop()
  await running
}
```

`service.registerHandler` lie chaque handler typé avant le démarrage. `service.newClient(client).add(ctx, value)` valide la requête et la réponse. `client.close(ctx)` est un nettoyage applicatif. Dans un processus réel, fermez le client depuis `afterStop` et laissez `app.run()` posséder la durée de vie.

`newHTTPTransport()` est le client Fetch portable. Il n'écoute pas. Un listener Node utilise `newNodeHTTPTransport()` de `@go-like/core/transport/http/node` à la fois sur le serveur et sur le client Node. Passer `newHTTPTransport()` à `newServer` passe le typecheck, puis échoue à l'écoute avec `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY`.

`@go-like/core/server` et `@go-like/core/client` exportent tous deux `middleware` et `use`. Importez l'un d'eux comme espace de noms lorsqu'un fichier a besoin des deux.

## Une tentative

L'appel par défaut fait une tentative. Le client construit un `POST` avec `content-type: application/json`, compose ou réutilise un transport, et lit la réponse. Un corps JSON non 2xx qui correspond à l'enveloppe d'erreur de service devient une `ServiceError`. Reconnaissez-la avec `isServiceError` de `@go-like/core/transport` avant de lire `code`, `status` ou `metadata`. `ServiceError.code` appartient à l'application. Ce n'est pas un code `GO_LIKE_*`.

Un `client.call` brut prend `{ service, endpoint, headers, body }` et renvoie une `Response` Fetch. L'appelant lit le corps ou l'annule.

Les métadonnées voyagent sur le Context. `@go-like/core/metadata` fournit `newClientContext`, `fromServerContext` et `propagateToClientContext`. La propagation est explicite. Les métadonnées entrantes ne sont pas copiées vers le saut suivant, sauf si le handler le fait.

## Découverte, filtres et sélection

`newDiscoveryResolver` de `@go-like/core/registry` observe un service et conserve un instantané de remplacement complet. Un instantané vide fait autorité : la sélection échoue avec `GO_LIKE_NO_AVAILABLE_ENDPOINT` au lieu de réutiliser les instances précédentes.

```ts
import { newClient, withDiscovery, withEndpoint, withSelector } from "@go-like/core/client"
import { newP2CSelector } from "@go-like/core/registry"

const client = newClient(
  withDiscovery(registry),
  withEndpoint("discovery:///pricing"),
  withSelector(newP2CSelector())
)
void client
```

`withDiscovery` prend la `Discovery`. Le client construit un résolveur privé. N'appelez `newDiscoveryResolver(discovery)` que lorsque le code applicatif a besoin d'instantanés en dehors d'un client. Deux résolveurs sur une même Discovery ne partagent pas les watchers.

Les filtres sont purs et ordonnés. `filterVersion` et `filterLabel` sont les filtres intégrés, passés par appel avec `withFilter`. Les sélecteurs sont `newRoundRobinSelector`, `newWeightedRoundRobinSelector`, `newRandomSelector`, `newP2CSelector` et `newEWMASelector`. P2C et EWMA prennent un retour synchrone après la tentative. Cet état est distinct de `circuitBreakerMiddleware`, qui associe un breaker à une opération.

`withBlock()` attend le premier instantané non vide. Une liste d'adresses directe de `withEndpoint` est un instantané statique et passe tout de même par le sélecteur. `withEndpoint("discovery:///name")` nomme le service à observer.

## Le retry est une autorisation de rejeu

`withRetry` de `@go-like/core/client` exige :

- `authorization` : `"idempotent"` ou `"caller-approved"` ;
- `maxAttempts` : un entier positif, qui compte la première tentative ;
- `shouldRetry(ctx, error, attempt)` renvoyant un booléen.

L'autorisation est une déclaration de l'appelant. Core n'inspecte pas les effets de bord. Chaque tentative entre à nouveau dans la découverte et la sélection. Une réponse déjà reçue, suivie d'un échec de retour ou de nettoyage, n'est pas rejouée.

`retry` et `exponentialBackoff` dans `@go-like/core/resilience` sont la même idée pour le code applicatif en dehors du client. `newCircuitBreaker` et `circuitBreakerMiddleware` s'ouvrent sur des échecs définis par l'appelant. `circuitOpen` est la sentinelle levée pendant que le breaker est ouvert. `newTokenBucketLimiter` et `rateLimitMiddleware` rejettent les appels en excès.

## Nettoyage

- Fermez les clients et les watchers de configuration dans `afterStop`, ou admettez une connexion native avec `newResourceServer`.
- Conservez le Context de requête pour l'appel. Le remplacer par `background()` abandonne l'annulation et le span courant.
- Appariez les échecs par sentinelle, `isServiceError`, ou un `code` documenté. Laissez le message au diagnostic. Le catalogue est [Gestion des erreurs](/reference/errors).

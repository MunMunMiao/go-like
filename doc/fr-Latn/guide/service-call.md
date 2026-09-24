# Appels de service

Un appel unaire interne assemble quelques composants. `@go-like/client` fournit un instantané de `Discovery` au `Selector`, puis effectue un échange `send`/`recv` à travers un `Transport`. La construction repose sur des options fonctionnelles :

```ts
import {
  newClient,
  withDiscovery,
  withFilter,
  withSelector,
  withService,
  withTransport
} from "@go-like/client"
import { filterLabel, filterVersion, type Filter } from "@go-like/registry"

const client = newClient(
  withDiscovery(discovery),
  withService("orders"),
  withSelector(selector),
  withTransport(serviceTransport)
)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
const reply = await client.call(
  ctx,
  {
    service: "orders",
    endpoint: "Orders.Get",
    message: { header: {}, body: requestBytes }
  },
  withFilter(...filters)
)
```

L’API racine de Registry exporte le type `Filter` ainsi que `filterVersion(...)` et `filterLabel(...)` ; `withFilter(...)` associe ces filtres à l’appel. Les filtres s’exécutent dans leur ordre de déclaration avant `Selector.select`. Pour une destination directe, construisez `newClient(withTransport(serviceTransport), withAddress(serviceAddress))` ; `withAddress(...)` contourne Discovery, mais passe par le même Selector que les instantanés découverts. Un client adossé à Discovery utilise ensemble `withService(serviceName)` et `withDiscovery(discovery)`, ouvre paresseusement un watcher par service et sélectionne depuis le dernier instantané complet. Chaque appel n’effectue qu’une tentative par défaut ; une fois le rejeu jugé sûr, `withRetry(...)` configure explicitement un nombre borné de tentatives, la classification des échecs et un délai optionnel, chaque tentative admise sélectionnant à nouveau depuis le dernier instantané. Appelez `client.close(ctx)` lorsqu’il n’est plus utilisé. `closeTimeout(...)` borne uniquement le nettoyage du client `Transport` logique ; le Transport et le runtime restent propriétaires de la réutilisation des connexions physiques.

`@go-like/server` projette les handlers sur le Transport et expose l’adresse réellement liée. Construisez le Server avec `transport(...)`, `address(...)`, `middleware(...)` et `listenOption(...)`, puis enregistrez la route avant le démarrage avec `server.registerHandler(...)`. `listenOption(...)` transmet à `Transport.listen` les valeurs `ListenOption` propres au fournisseur. `endpoint(ctx)` renvoie le même endpoint effectif que celui utilisé par `start(ctx)`. Une Core App composée avec `newApp(registrar(registry), server(serviceServer))` publie cet endpoint comme `ServiceInstance`, puis le retire à l’arrêt. C’est le cycle de vie recommandé ; l’utilisateur n’a besoin ni d’un jeton d’inscription, ni d’un DSL de disponibilité, ni d’un outil d’inscription propre au serveur.

À chaque tentative unaire, le client injecte dans le Context du Transport un `TransportInfo` contenant la cible réelle, l’opération stable `service/endpoint` et les en-têtes de transport effectifs. Le serveur injecte la valeur `TransportInfo` correspondante avant d’appeler le handler métier. Client et serveur encodent les métadonnées multivaluées du Context dans l’enveloppe canonique et bornée `Go-Like-Metadata`, transportée comme un en-tête Message opaque. `propagateToClientContext(...)` ne propage les métadonnées serveur vers le contexte client qu’au moyen d’une liste d’autorisation explicite `exact` ou `prefix`.

L’appel attend le feedback et le retour du Client logique Transport au pool, ou sa fermeture si nécessaire. Par défaut, un client qui a réussi est conservé ; `poolSize(0)` désactive cette rétention. Un échec de nettoyage après réception conserve la réponse dans `AggregateError.cause` et les erreurs ordonnées dans `errors` ; l’opération n’est pas rejouée. Fermez le propriétaire avec `client.close(ctx)` lorsque vous avez terminé.

# Appels de service

Un appel unaire interne assemble quelques composants. `@go-like/client` fournit un instantané de `Discovery` au `Selector`, puis effectue un échange `send`/`recv` à travers un `Transport`. La construction repose sur des options fonctionnelles :

```ts
import { newClient, withDiscovery, withFilter, withSelector, withTransport } from "@go-like/client"
import { filterLabel, filterVersion, type Filter } from "@go-like/registry"

const client = newClient(
  withDiscovery(discovery),
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

L’API racine de Registry exporte le type `Filter` ainsi que `filterVersion(...)` et `filterLabel(...)` ; `withFilter(...)` associe ces filtres à l’appel. Les filtres s’exécutent dans leur ordre de déclaration avant `Selector.select`. Un client réservé aux appels directs n’a besoin que de `newClient(withTransport(serviceTransport))` ; `withAddress(...)` contourne alors `Discovery` et `Selector`. Un client adossé à Discovery ouvre paresseusement un watcher par service et sélectionne depuis le dernier instantané complet. Chaque appel n’effectue qu’une tentative par défaut ; une fois le rejeu jugé sûr, `withRetry(...)` configure explicitement un nombre borné de tentatives, la classification des échecs et un délai optionnel, chaque tentative admise sélectionnant à nouveau depuis le dernier instantané. Appelez `client.close(ctx)` lorsqu’il n’est plus utilisé. `closeTimeout(...)` borne uniquement le nettoyage du client `Transport` logique ; le Transport et le runtime restent propriétaires de la réutilisation des connexions physiques.

`@go-like/server` projette les handlers sur le Transport et expose l’adresse réellement liée. Ses options sont `transport(...)`, `address(...)`, `handler(service, endpoint, fn)`, `middleware(...)` et `listenOption(...)` ; la dernière transmet à `Transport.listen` les valeurs `ListenOption` propres au fournisseur. `endpoint(ctx)` renvoie le même endpoint effectif que celui utilisé par `start(ctx)`. Une Core App composée avec `newApp(registrar(registry), server(serviceServer))` publie cet endpoint comme `ServiceInstance`, puis le retire à l’arrêt. C’est le cycle de vie recommandé ; l’utilisateur n’a besoin ni d’un jeton d’inscription, ni d’un DSL de disponibilité, ni d’un outil d’inscription propre au serveur.

À chaque tentative unaire, le client injecte dans le Context du Transport un `TransportInfo` contenant la cible réelle, l’opération stable `service/endpoint` et les en-têtes de transport effectifs. Le serveur injecte la valeur `TransportInfo` correspondante avant d’appeler le handler métier. Client et serveur encodent les métadonnées multivaluées du Context dans l’enveloppe canonique et bornée `Go-Like-Metadata`, transportée comme un en-tête Message opaque. `propagateToClientContext(...)` ne propage les métadonnées serveur vers le contexte client qu’au moyen d’une liste d’autorisation explicite `exact` ou `prefix`.

Le SPI de transport reprend les rôles de go-micro : `Transport`, `Client`, `Listener` et `Socket`. `@go-like/transport-http` fournit les deux côtés sur un protocole Fetch standard, tout en distinguant les erreurs de protocole, de transport et de service. La réponse n’est rendue à l’appelant qu’après l’envoi du retour d’information (`feedback`) détenu par l’appel et la fermeture (`close`) du client Transport logique. Si l’échange a abouti mais que l’une de ces étapes échoue, un `AggregateError` natif conserve la réponse dans `cause`, puis les erreurs de feedback et de close, dans cet ordre, dans `errors` ; ces échecs tardifs ne déclenchent aucune nouvelle tentative.

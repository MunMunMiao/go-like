# go-like

go-like propose de petites briques TypeScript explicites pour des services backend exécutés sur Bun, Node.js et Deno. L'application dispose de contrats pour l'annulation par Context, le cycle de vie de l'application et des ressources, les handlers Fetch standard, les appels de service internes unaires, la découverte et la sélection, la configuration, les Store, les Cache, les Broker, la santé, la résilience et des adaptateurs optionnels de logs et de télémétrie.

go-like est volontairement complémentaire d'un framework applicatif. Votre framework reste propriétaire des routes, du middleware, de la policy de requête, des Web Streams, des upgrades WebSocket, de la composition des dépendances et du comportement métier. Votre fournisseur reste propriétaire de sa connexion native, de son modèle d'acknowledgement, de ses leases, de ses retries et de son protocole. go-like fournit des contrats étroits et une propriété de cycle de vie là où ces frontières sont utiles.

> [!IMPORTANT]
> Ce checkout est un workspace privé en `0.0.1`. La documentation du dépôt indique que les paquets `@go-like/*` ne sont pas encore publiés sur npm. Les exemples ci-dessous sont destinés à être exécutés depuis un checkout, sauf si une release publiée a été confirmée séparément.

> [!NOTE]
> L'arborescence anglaise `doc/` est la source canonique de ce parcours documentaire. Le code des paquets, les manifests et les tests ciblés font autorité pour l'API. La présence d'un test ou d'un script E2E dans le dépôt correspond à une couverture déclarée ; ce n'est pas un résultat réussi tant qu'une commande n'a pas été exécutée et que son code de sortie n'a pas été relevé.

## Choisir un parcours

| Lecteur                             | Commencer par                                   | Lire ensuite                                                                               | Vous êtes prêt lorsque...                                                                        |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Nouveau sur go-like                 | [Bien démarrer](/fr-Latn/guide/getting-started) | [Architecture](/fr-Latn/guide/architecture), [Projet clinique](/fr-Latn/guide/zero-to-one) | vous savez démarrer un service Web, transmettre un Context, exposer la santé et l'arrêter        |
| Ingénieur TypeScript expérimenté    | [Architecture](/fr-Latn/guide/architecture)     | [Appels de service](/fr-Latn/guide/service-call), [Comparaison](/fr-Latn/guide/comparison) | vous savez nommer le propriétaire et la frontière terminale de chaque ressource                  |
| Lecteur Go ou Kratos                | [Bien démarrer](/fr-Latn/guide/getting-started) | [Appels de service](/fr-Latn/guide/service-call), [Migration](/fr-Latn/guide/migration)    | vous savez rapprocher Context et Server sans supposer gRPC ni compatibilité ABI Go               |
| Utilisateur d'un framework          | [Comparaison](/fr-Latn/guide/comparison)        | [Migration](/fr-Latn/guide/migration), [Architecture](/fr-Latn/guide/architecture)         | vous gardez le routeur natif et n'ajoutez que la frontière de cycle de vie ou d'appel nécessaire |
| Ingénieur fournisseur ou plateforme | [Fournisseurs](/fr-Latn/reference/providers)    | [Paquets](/fr-Latn/reference/packages), [Vérification](/fr-Latn/reference/verification)    | vous savez préciser runtime, backend, propriété et limites de preuve d'un fournisseur            |

## Choisir son parcours

- **Débutant :** commencez par [Bien démarrer](/fr-Latn/guide/getting-started), puis suivez [le projet clinique](/fr-Latn/guide/zero-to-one) jusqu'au signal ready et à l'arrêt.
- **Expert TypeScript ou Go :** lisez [Architecture](/fr-Latn/guide/architecture), puis [Appels de service](/fr-Latn/guide/service-call) et la [référence des fournisseurs](/fr-Latn/reference/providers) pour vérifier ownership et état terminal.
- **Utilisateur d'un framework :** lisez [Comparaison](/fr-Latn/guide/comparison) puis [Migration](/fr-Latn/guide/migration), en gardant le routeur natif.

## Le modèle mental

Le modèle utile le plus petit tient en cinq noms :

- **Context** est le premier argument explicite du travail annulable. Il porte une échéance, un résultat d'annulation de type `AbortSignal`, une cause facultative et des valeurs.
- **Server** est un objet de cycle de vie structurel, avec `start(ctx)` et `stop(ctx)`. Il possède une frontière de ressource admise.
- **App** compose des Servers, des hooks, l'enregistrement, l'admission au démarrage et l'arrêt progressif. Il ne devient pas un conteneur d'injection de dépendances.
- **Handler** est la fonction Web standard `(Request) => Response | Promise<Response>`. Un Handler n'est pas, à lui seul, un serveur en écoute.
- **Endpoint** est une opération interne typée et nommée. Il est distinct d'une adresse réseau comme `memory://pricing` ou `https://pricing.example`.

Les plans Web externe et de service interne sont séparés :

```text
External Web request
  Request
    -> framework router or application handler
    -> @go-like/web Handler
    -> Web host, such as @go-like/web/node
    -> @go-like/core App / Server lifecycle

Internal unary call
  @go-like/client
    -> Discovery, Filter, Selector, or direct address
    -> @go-like/transport Client
    -> Message send / recv
    -> @go-like/server unary handler
    -> response Message
```

## Ce que go-like ne prend volontairement pas en charge

La frontière produit actuelle ne revendique pas :

- gRPC, Protobuf, fichiers IDL, clients RPC générés ou stubs de serveur générés ;
- une API de streams RPC internes full-duplex, un protocole de half-close, un modèle de frames ou un contrat de backpressure ;
- un routeur externe ou un DSL de middleware propre à un framework ;
- un conteneur global d'injection de dépendances ou un service locator ;
- JWT, OAuth, OIDC, claims, ACL ou autorisation applicative automatiques ;
- un Event Store, des requêtes d'historique, un moteur de replay ou un modèle universel de règlement durable des messages ;
- des fournisseurs OpenTelemetry, exporters, context managers ou instrumentation globale installés automatiquement ;
- une sémantique distribuée, durable ou interprocessus pour les fournisseurs mémoire ;
- la publication npm, l'adoption en production, l'état d'une CI hébergée ou une garantie de préparation à la production déduite d'un manifest ou d'un script.

Le streaming Web public reste fondé sur `Request`/`Response` Fetch standard et les Web Streams. Ce n'est pas un RPC interne full-duplex. Voir [Streaming](/fr-Latn/guide/streaming) pour cette frontière.

## Inventaire public

Les manifests source actuels contiennent **43 paquets `@go-like/*` non privés**, tous en version `0.0.1` dans ce checkout, ainsi que **23 sous-chemins source publics**. `@go-like/struct` fait partie de cet inventaire public et fournit le contrat runtime utilisé par les appels `Endpoint` typés. Les exports de métadonnées `dist/package.json` générés ne sont ni des paquets supplémentaires ni des API source.

Utilisez la [référence des paquets](/fr-Latn/reference/packages) pour choisir un contrat ou un fournisseur, puis la [référence des fournisseurs](/fr-Latn/reference/providers) pour comparer backend et sémantique runtime.

## Limite de vérification

L'audit local du contrat a relevé les résultats suivants sur le commit de référence documentaire `9385dbf5b6a7d913be56a80ade359e1bf9be8675` : `bun run typecheck`, `bun run test:unit` et `bun run fmt:check` ont réussi, couvrant la racine, les paquets, les exemples et le périmètre de tests unitaires déclaré. Le rapport comptait 2 736 tests unitaires, 1 514 fichiers formatés et un audit d'import réussi pour 66 entrées d'exports source déclarées.

Ce rapport n'établissait pas `build`, `doc:build`, les E2E des fournisseurs Docker, l'exécution multi-runtime, les consommateurs de tarballs publiés, la publication npm, une CI hébergée, l'adoption en production ni le soak de 60 minutes. Consultez [Vérification](/fr-Latn/reference/verification) avant de transformer une affirmation de source ou de script en affirmation de release.

## Pour continuer

- [Bien démarrer](/fr-Latn/guide/getting-started) : installer ou utiliser un checkout, exécuter un handler Web et comprendre le premier point de contrôle du cycle de vie.
- [Architecture](/fr-Latn/guide/architecture) : étudier les plans, la propriété, les portées de Context, l'ordre du cycle de vie et la portabilité runtime.
- [Rendez-vous en clinique : de 0 à 1](/fr-Latn/guide/zero-to-one) : suivre une route guidée par milestones, d'un invariant métier concret à l'appel unaire de policy interne, la santé, les tests et l'arrêt.
- [Appels de service](/fr-Latn/guide/service-call) : commencer avec un Memory Transport typé, puis ajouter découverte, sélection, retry et nettoyage de façon délibérée.
- [Configuration, Registry, Store et Cache](/fr-Latn/guide/config-registry-store) : choisir des contrats d'état sans mélanger leurs garanties.
- [Broker et événements](/fr-Latn/guide/broker-events) : préserver les sémantiques natives de livraison, d'acknowledgement, de consommateurs durables et de jobs.
- [Santé et observabilité](/fr-Latn/guide/health-observability) : ajouter readiness, métriques, traces et logs sans installer silencieusement une infrastructure globale.
- [Comparaison](/fr-Latn/guide/comparison) et [Migration](/fr-Latn/guide/migration) : comparer la propriété avec les frameworks tiers et adopter go-like progressivement.
- [Paquets](/fr-Latn/reference/packages), [Fournisseurs](/fr-Latn/reference/providers) et [Vérification](/fr-Latn/reference/verification) : utiliser la piste de référence lorsque l'API ou la limite de preuve compte.

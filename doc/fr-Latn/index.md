# go-like

go-like est un ensemble de briques TypeScript explicites pour des services backend sur Bun et Node.js. `@go-like/core` est le panneau de sockets sans dépendance d'exécution : Context, cycle de vie de l'application, appels internes, configuration, découverte, enregistrements, cache, messagerie, jobs, santé et base de télémétrie. Dix-neuf autres paquets sont des plugs. Un plug remplit un ou plusieurs sockets avec un client d'écosystème que l'application construit. `@go-like/protoc-gen-like` est le générateur Protobuf de build et ne dépend pas de core.

L'application reste la racine de composition. Elle construit les objets natifs, les passe aux constructeurs de plugs et installe les résultats sur `newApp`. Il n'y a pas de registre global de serveurs, de loggers ou de fournisseurs de télémétrie.

> [!IMPORTANT]
> Ce checkout est un workspace privé en version `0.0.1`. Une version de manifest n'établit pas la disponibilité sur npm. Les exemples utilisent les paquets du workspace et sont prévus pour être exécutés depuis un checkout, sauf si une release publiée est confirmée indépendamment.

> [!NOTE]
> L'arborescence anglaise `doc/` est la source canonique de ce parcours documentaire. Le code des paquets, les manifests et les tests ciblés font autorité pour l'API. La présence d'un test ou d'un script E2E dans le dépôt correspond à une couverture déclarée ; ce n'est pas un résultat réussi tant qu'une commande n'a pas été exécutée et que son code de sortie n'a pas été relevé.

## Choisir un parcours

| Lecteur                          | Commencer par                                          | Lire ensuite                                                                               | Vous êtes prêt lorsque                                                                                     |
| -------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Nouveau sur go-like              | [Bien démarrer](/fr-Latn/guide/getting-started)        | [Architecture](/fr-Latn/guide/architecture), [Projet clinique](/fr-Latn/guide/zero-to-one) | vous savez démarrer un service Web, transmettre un Context, exposer la santé et l'arrêter                  |
| Ingénieur TypeScript expérimenté | [Architecture](/fr-Latn/guide/architecture)            | [Appels de service](/fr-Latn/guide/service-call), [Comparaison](/fr-Latn/guide/comparison) | vous savez nommer le propriétaire, le palier et la frontière terminale de chaque ressource                 |
| Lecteur Go ou Kratos             | [Bien démarrer](/fr-Latn/guide/getting-started)        | [Terminologie](/reference/terminology), [Appels de service](/fr-Latn/guide/service-call)   | vous savez rapprocher les concepts Context et Server sans supposer gRPC ni une compatibilité avec l'ABI Go |
| Utilisateur d'un framework       | [Comparaison](/fr-Latn/guide/comparison)               | [Migration](/fr-Latn/guide/migration), [Architecture](/fr-Latn/guide/architecture)         | vous gardez le routeur natif et n'ajoutez que la frontière de cycle de vie ou d'appel nécessaire           |
| Auteur de plug                   | [Index des fournisseurs](/fr-Latn/reference/providers) | [Vérification](/fr-Latn/reference/verification), [Affirmations](/reference/claims)         | vous savez énoncer le socket, le runtime, la propriété et les limites de preuve d'un plug                  |

## Parcours d'apprentissage canonique

Le parcours canonique de quatre pages sous `doc/guide/` est volontairement progressif :

1. [Bien démarrer](/fr-Latn/guide/getting-started) exécute un Handler Fetch standard, un host Node, un signal d'admission et une App.
2. [Rendez-vous en clinique](/fr-Latn/guide/zero-to-one) transforme le cycle de vie en domaine concret, appel unaire interne, cache, santé, test et arrêt.
3. [Comparaison](/fr-Latn/guide/comparison) explique où go-like s'écarte volontairement de NestJS, Fastify, Hono, Elysia, Koa, tRPC, go-micro et go-kratos.
4. [Migration](/fr-Latn/guide/migration) projette les paquets d'avant la migration sur la disposition à 20 paquets.

[Paquets](/fr-Latn/reference/packages) est l'inventaire de 20 paquets et 75 entrées publiques. [Fournisseurs](/fr-Latn/reference/providers) pointe vers le README de chaque plug d'écosystème.

## Le modèle mental

Trois règles traversent la bibliothèque :

1. **Context d'abord.** Chaque opération d'E/S prend `ctx: Context` comme premier argument. Le Context porte l'annulation, une échéance, l'AppInfo, les métadonnées de requête et l'état de télémétrie courant.
2. **Composition explicite.** L'application construit chaque implémentation et la transmet. Les plugs ne s'enregistrent pas globalement.
3. **Un chemin pour chaque travail.** Abonnez-vous avec `newBrokerServer`, planifiez avec `newScheduleServer`, consommez une file avec `JobQueue.worker`, attachez une ressource native avec `newResourceServer`, et publiez la readiness avec `readyProbe` plus `createHealthHandler`.

```text
Application main.ts
  construct plugs from native objects the application created
  newTelemetry({...})  newConfig(...)  newServer(...)  newClient(...)
        |
        v
@go-like/core  newApp(...)
  telemetry(tel)     admitted first, drained last
  resources(...)     started in order, each start awaited, stopped in reverse
  server(...)        started together, stopped together
  registrar(r)       after the server tier is admitted
  readyProbe(...)    ready only between startup completion and stop
```

Cinq noms suffisent pour lire le reste du site :

- **Socket** est un contrat structurel que core déclare (`Server`, `LogHandler`, `Registry`, `Broker`, `Store`, et les autres). Un plug implémente le socket. Il n'enveloppe pas un site d'appel de core.
- **Context** est la portée explicite du travail annulable.
- **Server** est `start(ctx)` et `stop(ctx)`. Dans `resources(...)`, `start` se résout lorsque la ressource est utilisable. Dans `server(...)`, `start` peut rester en attente jusqu'à la fin de l'objet natif.
- **App** admet ces paliers, les hooks, l'enregistrement et l'arrêt. Ce n'est pas un conteneur d'injection de dépendances.
- **Handler** est la fonction Web standard `(Request) => Response | Promise<Response>`. Un Handler n'est pas, à lui seul, un serveur en écoute.

Les appels Web externes et les appels de service internes restent séparés. Le RPC Protobuf généré est un chemin optionnel supplémentaire : `@go-like/protoc-gen-like` émet le code de liaison avec le Context en premier argument, `@go-like/connectrpc` adapte Connect et gRPC-Web à Fetch, et `@go-like/connectrpc/node` héberge le gRPC standard. Voir [Streaming](/fr-Latn/guide/streaming).

## Ce que l'application conserve

La frontière produit actuelle laisse ceci à l'application ou à la bibliothèque native :

- les routes, le middleware du framework, les Web Streams et les upgrades WebSocket ;
- la policy métier, les identifiants et l'autorisation ;
- l'acknowledgement natif, les leases, les retries et les détails de protocole ;
- la construction du SDK OpenTelemetry, la configuration du logger et le choix de l'exporter ;
- la durabilité, les transactions, et toute signification interprocessus d'une implémentation de référence en mémoire ;
- la publication npm, l'état d'une CI hébergée, ou une affirmation de préparation à la production déduite d'un manifest.

## Inventaire public

Le workspace publie **20** paquets `@go-like/*`, tous en version `0.0.1` dans ce checkout, et **75** entrées publiques. `@go-like/core` contribue 41 entrées. Les 34 autres appartiennent aux plugs et au générateur. Les exports de métadonnées `dist/package.json` générés ne sont pas des API source supplémentaires.

Utilisez la [référence des paquets](/fr-Latn/reference/packages) pour choisir une entrée, et l'[index des fournisseurs](/fr-Latn/reference/providers) pour ouvrir le README d'un plug. Le [registre des affirmations](/reference/claims) consigne le niveau de preuve derrière les formulations publiques.

## Limite de vérification

Un audit historique du contrat du dépôt a rapporté des résultats locaux sur le commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675` : `bun run typecheck`, `bun run test:unit` et `bun run fmt:check` ont réussi. Ce rapport comptait 2 736 tests unitaires, 1 514 fichiers formatés et un audit d'import réussi pour 66 entrées d'exports source. Ce décompte décrit l'arborescence d'avant la migration. L'inventaire actuel est de 75 entrées. L'audit n'établissait pas `build`, `doc:build`, les E2E des fournisseurs Docker, les consommateurs de tarballs publiés, la publication npm, une CI hébergée, ni le soak de 60 minutes.

Lisez [Vérification](/fr-Latn/reference/verification) avant de transformer une affirmation de source ou de script en affirmation de release.

## Pour continuer

- [Bien démarrer](/fr-Latn/guide/getting-started) : exécuter un handler Web et le premier point de contrôle du cycle de vie.
- [Architecture](/fr-Latn/guide/architecture) : paliers, portées de Context, ordre de démarrage et d'arrêt, readiness et budgets.
- [Rendez-vous en clinique](/fr-Latn/guide/zero-to-one) : un invariant métier, de HTTP jusqu'à un appel de policy interne, la santé et l'arrêt.
- [Appels de service](/fr-Latn/guide/service-call) : Memory Transport typé, puis découverte, sélection et retry.
- [Configuration, registre, Store et cache](/fr-Latn/guide/config-registry-store) : quatre contrats, un client partagé par écosystème.
- [Broker, événements et jobs](/fr-Latn/guide/broker-events) : octets, codecs, planifications et files.
- [Santé et observabilité](/fr-Latn/guide/health-observability) : probes, `newTelemetry` et les quatre plugs de télémétrie.
- [Comparaison](/fr-Latn/guide/comparison) et [Migration](/fr-Latn/guide/migration) : la propriété face aux autres outils, et le codemod d'import.
- [Paquets](/fr-Latn/reference/packages), [Fournisseurs](/fr-Latn/reference/providers), [Erreurs](/reference/errors), [Terminologie](/reference/terminology) et [Vérification](/fr-Latn/reference/verification).

Le drain gRPC géré avec consommateur lent sur Node 26.12.1 et Bun 1.4.4 est consigné dans la [matrice de drain gRPC natif](/reference/claims#native-grpc-drain-status). Les observations antérieures d'annulation Fetch de Connect 2.1.2 et de Bun 1.4.2 restent dans le [registre des affirmations](/reference/claims#stream-cancellation-limits).

# go-like comparé aux autres outils

Une comparaison juste commence par la responsabilité, pas par une liste de fonctionnalités cochées. NestJS, Fastify, Hono, Elysia, Koa et tRPC résolvent des parties différentes de la stack applicative TypeScript. go-micro et go-kratos sont des références de frameworks Go, avec d'autres choix de transport et de génération de code. go-like est un ensemble de briques TypeScript qui rend explicites le cycle de vie, les appels internes unaires, les contrats de fournisseurs et la composition entre runtimes.

Cette page distingue les niveaux de preuve :

- **Source** signifie que le checkout go-like actuel expose l'API ou la frontière indiquée.
- **Externe épinglé** signifie que la comparaison utilise la release, le commit ou la documentation officielle consignés dans le registre de recherche. Ce n'est ni un benchmark récent ni une affirmation qu'une branche `main` non épinglée n'a pas changé.
- **Déclaré** signifie qu'un exemple ou une lane de tests existe dans le dépôt. Ce n'est pas un résultat réussi.
- **Lacune** signifie que le dépôt actuel ne prouve pas un engagement de compatibilité.

Le baseline source actuel de go-like pour ce parcours est le commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. Le relevé de recherche local contient une divergence de commit pour go-micro : une fiche de comparaison cite `9d306dcfc1a912a8a9493f31fee0bb983475258d`, tandis que le mémo détaillé sur une version fixe a inspecté go-micro `v6.9.0` au commit `3c39d17fadaa9ec21b671be4afef3e63846406e6`. Considérez ces valeurs comme des entrées de comparaison à revérifier, et non comme une garantie actuelle de l'upstream.

## Place dans la stack

| Outil     | Problème principal                                     | Ce qu'il prend généralement en charge                                                                                                                                                      | Ce que go-like peut compléter, sans le remplacer                                                                                          |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS    | Framework d'application Node fondé sur des conventions | Modules, providers, controllers, decorators, application context, cycle de vie du framework, adaptateur HTTP ou microservices                                                              | Une frontière de cycle de vie structurelle ou un contrat d'appel interne autour d'une application native, si un pont explicite est écrit |
| Fastify   | Serveur HTTP Node et pipeline de requêtes              | Table de routes, hooks, plugins, encapsulation, listener Node, objets request/reply                                                                                                        | Un adaptateur de cycle de vie ou de fournisseur autour d'une ressource dont Fastify est propriétaire                                     |
| Hono      | Routage et middleware fondés sur les Web Standards     | Routes, middleware, sous-applications, `app.fetch`, choix de l'adaptateur de runtime                                                                                                       | Core App, cycle de vie explicite des ressources, Client/Transport interne, découverte                                                    |
| Elysia    | Framework Web typé centré sur Bun                      | Arbre de routes, composition de schémas, decorators, hooks, adaptateur Bun ou Web Standard                                                                                                 | Briques de cycle de vie Core et services internes, tout en conservant le comportement natif d'Elysia                                     |
| Koa       | Noyau minimal de middleware Node                       | Pile de middleware et listener Node ; le routeur est généralement externe                                                                                                                  | Cycle de vie et contrats de services internes sans introduire un autre routeur                                                           |
| tRPC      | Couche de procédures typées                            | Chemins de router/procedure, parseurs d'entrée/sortie, context factory, adaptateurs HTTP/Fetch/WS                                                                                          | Propriété des fournisseurs, politique de découverte, cycle de vie explicite de l'App                                                     |
| go-micro  | Écosystème Go orienté microservices et agents          | Go Context, abstractions service/client/transport/registry/broker, écosystème de fournisseurs et périmètre supplémentaire agent/flow/MCP/A2A                                               | go-like reprend une partie du vocabulaire, pas l'ABI Go, les goroutines ni la compatibilité des transports                                |
| go-kratos | Framework Go pour services cloud-native                | Cycle de vie App, Go Context, transports HTTP/gRPC, middleware, registry, config, génération de code Protobuf                                                                              | go-like partage le vocabulaire du cycle de vie explicite, mais choisit les API TypeScript/Web et ne revendique ni gRPC ni IDL             |
| go-like    | Briques explicites pour services TypeScript            | Context, cycle de vie App/Server, bordure Fetch standard, transport interne unaire avec Message, Client/Server, Registry/Discovery/Selector, Config/Store/Cache/Broker/Health, adaptateurs | L'application reste propriétaire de ses routes, de ses plans de données natifs, de sa policy métier, de l'auth et du déploiement         |

Le projet n'essaie donc pas de gagner un concours du « plus gros framework ». La vraie question est de savoir si une application a besoin de rendre ces frontières explicites et composables.

## Matrice des responsabilités

| Préoccupation                 | NestJS                                            | Fastify                                       | Hono / Elysia / Koa                                                | tRPC                                                 | go-like                                                                                  |
| ----------------------------- | ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Table de routes externe       | Controllers et decorators                         | Instance Fastify                              | Instance du framework ou routeur externe                           | Router de procédures, pas des routes REST ordinaires | Framework externe ou application                                                        |
| ABI du handler Web            | Abstraction request/reply du framework            | request/reply Node                            | Fetch standard au centre pour Hono et les adaptateurs Web Standard | Adaptateurs Fetch/Node/Express/Fastify               | `(Request) => Response \| Promise<Response>`                                            |
| Cycle de vie de l'application | Application context et hooks                      | `ready`, `listen`, `close`, hooks             | L'adaptateur de runtime et le framework varient                    | Responsabilité du host/de l'adaptateur               | `newApp`, `App.run`, `App.stop`, hooks, Servers structurels                             |
| Cycle de vie des ressources   | Hooks du container/framework                      | Hooks de plugin et de serveur                 | Responsabilité de l'application/runtime                            | Responsabilité de l'application/adaptateur           | Contrats explicites `Server.start(ctx)` / `stop(ctx)` et propriété de l'adaptateur      |
| Composition des dépendances   | Container/providers Nest                          | Decoration et encapsulation des plugins       | Context/env et composition ; pas de conteneur DI général           | Context factory explicite et composition du router   | Constructeurs explicites et functional options ; pas de conteneur DI                    |
| Transport interne             | Transports microservices et adaptateurs framework | Pas une abstraction de découverte de services | Pas une abstraction de découverte de services                      | Adaptateurs de procédures et WebSocket optionnel     | `Transport`, `Client`, `Listener`, `Socket`, `Message`                                  |
| Découverte et sélection       | Spécifiques au transport ou externes              | Externes                                      | Externes                                                           | Externes                                             | `Registry`, `Discovery`, `Watcher`, Filters, cinq policies de Selector                  |
| Retry                         | Spécifique au framework ou fournisseur            | Spécifique à l'application/plugin             | Spécifique à l'application                                         | Spécifique au middleware/adaptateur                  | Une tentative par défaut ; `withRetry` exige une autorisation et un total de tentatives |
| Streaming                     | Choix du framework/fournisseur                    | Choix des streams Node/Web                    | Web Streams natives et API du framework                            | Dépend de l'adaptateur HTTP/WS                       | Le streaming Web public est natif ; le RPC interne reste unaire                         |
| Instrumentation globale       | Intégration framework/fournisseur                 | Écosystème de plugins                         | Écosystème de middleware                                           | Middleware/adaptateurs                               | Wrappers explicites ; aucune installation de fournisseurs globaux                       |

Les libellés des cinq premières lignes décrivent des positions d'architecture, pas un classement de qualité. Lorsqu'un framework possède la table de routes, c'est utile si la composition des routes est le problème à résoudre. C'est simplement un choix de responsabilité différent de celui de go-like, qui laisse les routes à l'application.

## Cycle de vie et Context

Le code source actuel de go-like définit :

```ts
interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}
```

Le contrat `Server` est structurel. Un worker natif, un listener, un scheduler, une souscription de broker, une destination de logs ou un fournisseur de télémétrie peut rejoindre Core si un adaptateur sait décrire honnêtement son admission et son état terminal.

Le Context de go-like est lui aussi structurel et utilise `AbortSignal` en interne. Il expose `deadline()`, `done()`, `err()` et `value(key)`, avec des constructeurs tels que `background`, `withCancel`, `withCancelCause`, `withTimeout`, `withDeadline`, `withoutCancel` et `withValue`.

Cela rappelle le style explicite de Go où le Context est le premier argument, mais ce n'est pas compatible au niveau ABI avec `context.Context`. Cela ne fournit ni goroutines, ni channels, ni gRPC. La bonne question de migration est « où l'annulation et la propriété franchissent-elles cette frontière ? », et non « quel nom de type est identique ? ».

Core ne promet pas un arrêt dans l'ordre inverse pour les Servers frères. Il appelle les `stop(ctx)` frères en parallèle, puis attend les Promises `start` terminales et agrège les échecs. Un application context Nest, un graphe de plugins Fastify, le cycle de vie Elysia ou un adaptateur de host peuvent avoir un ordre et une sémantique terminale différents. Comparez le véritable propriétaire, pas seulement l'étiquette « graceful ».

## Transport et appels de service

La chaîne d'appel interne de go-like est volontairement décomposée :

```text
Client
  -> Discovery snapshot, optional
  -> ordered Filter callbacks, optional
  -> Selector.select
  -> opaque ServiceEndpoint URL
  -> Transport.dial or resident logical owner
  -> send(Message)
  -> @go-like/server route and unary handler
  -> recv(Message)
  -> feedback and owner release
```

Un `Endpoint` typé associe la validation `Struct` des requêtes et réponses à la frontière `Message` existante. Ce n'est ni un IDL ni un protocole généré. `withAddress(...)` contourne Discovery et Selector, ce qui fait du chemin Memory Transport en processus un bon premier test.

Les options de transport microservices de NestJS, les adaptateurs de procédures tRPC et les transports des frameworks Go ne sont pas interchangeables avec ce DAG. Ils peuvent avoir une autre identité de route, un autre modèle de sérialisation, un autre pool de connexions ou une autre couche de retry. Une comparaison doit noter ces différences plutôt que cocher comme équivalentes toutes les cases « RPC ».

## Périmètre du retry et du streaming

La différence négative la plus importante concerne les sémantiques :

- Les appels go-like font exactement une tentative par défaut.
- `withRetry(...)` exige `authorization: "idempotent" | "caller-approved"`, un `maxAttempts` positif et `shouldRetry`.
- L'autorisation est une déclaration du caller, pas une preuve d'idempotence.
- Un retry peut sélectionner un nouvel endpoint, car chaque tentative repasse par la découverte et la sélection.
- Une réponse déjà reçue, mais suivie d'un échec de feedback ou de nettoyage, n'est pas rejouée.

La recherche comparative Go relève d'autres valeurs par défaut et capacités : `DefaultRetries` de go-micro ne signifie pas simplement « cinq requêtes au total », car la limite de sa boucle peut produire six itérations lorsque l'autorisation de retry reste vraie ; sa forme de stream publique et son implémentation par défaut de `CloseSend` varient également selon le fournisseur. go-kratos combine génération Protobuf/gRPC et formes de streaming HTTP, où SSE et WebSocket ont des directions et des comportements de fermeture différents. Ce sont des choix de fournisseur et d'architecture, pas des options go-like manquantes.

Pour go-like :

```text
Web framework or Fetch Handler
  -> Web Streams, SSE, or WebSocket behavior owned by the application/framework

go-like internal Client/Transport
  -> one unary Message request and one unary Message response
  -> no full-duplex RPC Stream SPI
```

Un `ReadableStream` Web n'est pas un canal RPC interne. Ne comparez pas un corps HTTP en streaming avec un transport `send`/`recv` à plusieurs frames comme s'il s'agissait de la même fonctionnalité.

## Comparaison des runtimes

| Question de runtime                                                | Preuve go-like                                                                                                        | Conséquence pour la comparaison                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Le code partagé peut-il utiliser Fetch et `AbortSignal` ?          | Le Web root et les fournisseurs Config/Transport sélectionnés utilisent des Web APIs standard ou un Fetch injecté    | Des objectifs de portabilité similaires sont possibles, mais les types ne simulent pas le comportement du runtime |
| Le même paquet peut-il lier un listener Node et un listener Deno ? | Les sous-chemins runtime sont explicites ; `@go-like/web/node` et `@go-like/transport-http/node` sont des chemins Node | N'écrivez pas que « tous les paquets fonctionnent partout sans changement »                                       |
| Fetch peut-il transporter partout PEM TLS, mTLS, ALPN et HTTP/2 ?  | Le sous-chemin Transport Node possède le comportement natif ; le chemin Fetch root n'expose pas tous les contrôles   | Comparez les capacités du host et les chemins d'import, pas seulement les noms de paquets                         |
| L'application conserve-t-elle le routeur du framework ?            | Les exemples Hono, Elysia et H3 transmettent des handlers Fetch natifs                                               | go-like complète la responsabilité de routage du framework                                                         |
| La version d'un paquet prouve-t-elle sa publication ?              | Root et packages sont privés/workspace `0.0.1` ; la documentation du dépôt dit qu'ils ne sont pas encore publiés     | N'en déduisez ni disponibilité npm ni maturité de l'écosystème                                                    |

Le dépôt actuel contient des exemples directs pour Hono, Elysia, H3 et Fetch sans framework. Il ne contient ni pont NestJS ou Fastify actuel, ni suite de compatibilité. Ce sont des publics de migration, pas des intégrations directes prises en charge.

## Comparaison détaillée par outil

### NestJS

NestJS est un framework d'application fondé sur des conventions. Ses modules, providers, controllers, decorators, interceptors, pipes et hooks d'application forment un conteneur et un modèle de requête cohérents. go-like ne fournit ni conteneur de modules compatible avec Nest, ni pont pour controllers.

Une frontière d'intégration raisonnable est un adaptateur appartenant à l'application, qui implémente le `Server` structurel de go-like autour d'une application Nest ou de son host. L'adaptateur devrait définir à quel moment Nest a admis le listener, comment `stop(ctx)` se traduit par la fermeture de Nest et ce qui se passe après un timeout. Le dépôt actuel ne prouve pas l'existence d'un tel pont ; la documentation ne doit donc pas montrer un appel direct comme `newNodeServer(nestApp, ...)`.

### Fastify

Fastify possède une table de routes, l'encapsulation des plugins, des hooks et un listener Node. Son graphe de plugins est un bon point de comparaison pour les scopes de dépendances, mais `decorate` n'est pas un conteneur général de providers comme celui de Nest. go-like ne convertit pas automatiquement l'ABI `request`/`reply` de Fastify en Fetch Handler, et aucun pont Fastify actuel n'est testé dans le dépôt.

Gardez routes et plugins Fastify natifs. Si vous adoptez go-like, écrivez un Server structurel explicite autour du propriétaire Fastify ou exposez une frontière Fetch implémentée séparément. N'appelez ni l'injection de requête ni l'arrêt natif de Fastify un contrat go-like de Transport ou de Client.

### Hono

Hono est le complément le plus clairement démontré. L'exemple actuel crée les routes dans Hono, transmet `app.fetch` à `newNodeServer` et place ce host dans une Core App. Hono reste propriétaire des routes et du middleware ; go-like possède la frontière de cycle de vie du host lorsque l'application le choisit.

### Elysia

Elysia fournit un modèle de composition de routes et de schémas centré sur Bun et expose aussi un handler Web Standard dans le chemin d'adaptateur concerné. Conservez l'arbre de routes, les decorators, derives, hooks, streams et le comportement spécifique à Bun d'Elysia. go-like peut posséder l'App et une frontière explicite de ressource, mais ne transforme pas `.listen()` en API go-like inter-runtime.

### Koa

Koa est un petit noyau de middleware Node qui n'embarque pas de routeur. C'est un bon exemple de framework qui laisse volontairement davantage de composition à l'application, en dehors du core. go-like ne doit pas combler ce vide en ajoutant un routeur. Gardez le middleware Koa et tout routeur externe natifs, puis ajoutez une frontière de cycle de vie ou d'appel interne uniquement là où elle est nécessaire.

### tRPC

tRPC possède un router de procédures typées et son middleware de procédures. Il peut utiliser des adaptateurs Fetch, Node, Express, Fastify ou WebSocket, mais ce n'est ni un Registry, ni un Selector, ni un pool de connexions, ni un gestionnaire du cycle de vie applicatif. L'`Endpoint` typé de go-like est une liaison runtime `Struct` plus petite sur des `Message` unaires, pas un DSL de procédures ni un IDL généré concurrent de tRPC.

### go-micro et go-kratos

Ces projets Go sont des références d'architecture utiles pour les appels Context-first, le cycle de vie des services, Registry, Discovery, Selector et le vocabulaire des transports. Ils ne sont pas des cibles de compatibilité :

- `context.Context` de Go et `Context` de go-like partagent l'intention d'une annulation explicite, mais leurs représentations runtime diffèrent.
- Le modèle de watcher Registry de go-micro et les snapshots de remplacement complet de go-like ne doivent pas être présentés comme des flux d'événements identiques.
- Protobuf/gRPC et le code généré de go-kratos sont un choix d'architecture que go-like ne revendique explicitement pas.
- Les valeurs par défaut des fournisseurs go-micro et go-kratos, les boucles de retry, le half-close des streams et les sélecteurs par défaut dépendent de la version. Utilisez la table des commits upstream épinglés dans le relevé de recherche et revérifiez-la avant de publier une nouvelle comparaison.

## Que choisir ?

| Si votre problème principal est...                  | Commencez avec...     | Ajoutez go-like lorsque...                                                                                                            |
| --------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Controllers, modules, decorators et DI              | NestJS                | vous avez besoin d'une frontière explicite autour d'une ressource existante ou d'un appel interne, et acceptez d'écrire l'adaptateur |
| Routes HTTP Node, hooks et encapsulation de plugins | Fastify               | vous avez besoin d'une composition de cycle de vie au-delà du host ou de contrats de services internes                               |
| Routes Web Standards entre runtimes                 | Hono                  | vous avez besoin du cycle de vie App/Server, d'appels internes ou de propriété des fournisseurs                                      |
| Composition de schémas et routes centrée sur Bun    | Elysia                | vous avez besoin de frontières explicites de cycle de vie et de transport tout en gardant Elysia                                     |
| Middleware Node minimal                             | Koa et un routeur     | il vous manque le contrat de cycle de vie ou d'appel interne, pas un autre routeur                                                   |
| Procédures typées                                   | tRPC                  | vous avez aussi besoin de découverte explicite, de propriété des fournisseurs ou d'un cycle de vie Core                              |
| Stack de microservices Go                           | go-micro ou go-kratos | vous construisez une composition TypeScript séparée, et non un port compatible au niveau du source                                   |
| Briques de services TypeScript inter-runtime        | go-like                | utilisez uniquement les paquets et fournisseurs qui résolvent la frontière voulue                                                    |

La bonne réponse peut être d'utiliser les deux systèmes. go-like est le plus utile lorsque son modèle de propriété explicite supprime une ambiguïté réelle ; ajouter tous ses paquets à une application déjà complète avec un autre framework irait à l'encontre de l'objectif de petites briques.

## Ancrages de preuve

Les affirmations go-like de cette page peuvent être retracées dans l'arbre actuel et les entrypoints de paquets :

- `README.md` pour le périmètre du produit et ses exclusions explicites ;
- `packages/core/src/app.ts` pour `App`, `Server`, le démarrage, l'arrêt et le comportement des timeouts ;
- `packages/web/src/context.ts` pour le Handler standard et le pont Context ;
- `packages/client/src/index.ts` pour les options du Client, le pooling, le retry et le pipeline des tentatives ;
- `packages/server/src/index.ts` pour les handlers internes unaires et le dispatch des routes ;
- `packages/transport/src/types.ts` et `packages/transport/src/endpoint.ts` pour les frontières Message et Endpoint ;
- `packages/registry/src/types.ts` et `packages/registry/src/selector.ts` pour les snapshots, filtres, sélecteurs et feedback.

Le relevé de recherche conserve également ces entrées de comparaison externes épinglées :

- [commit de comparaison go-micro enregistré dans le dépôt](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d);
- [commit de comparaison go-kratos v3](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e);
- [commit de comparaison go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336);
- [documentation du cycle de vie NestJS](https://docs.nestjs.com/fundamentals/lifecycle-events), [référence du serveur Fastify](https://fastify.dev/docs/latest/Reference/Server/), [API Hono](https://hono.dev/docs/api/hono), [cycle de vie Elysia](https://elysiajs.com/essential/life-cycle), [Koa](https://koajs.com/) et [routers tRPC](https://trpc.io/docs/server/routers).

Ces URL sont des références de comparaison, pas une affirmation que cette phase de documentation a téléchargé ou revérifié chaque page upstream. Revérifiez les tags de release ou les commits avant de modifier une affirmation sensible à la version.

# go-like comparé aux autres outils

Une comparaison juste commence par la propriété. NestJS, Fastify, Hono, Elysia, Koa et tRPC résolvent des parties différentes d'une application TypeScript. go-micro et go-kratos sont des références Go, avec d'autres transports et une autre génération de code. go-like est un panneau de sockets : des paliers de cycle de vie explicites, des appels internes et des plugs pour les backends que vous choisissez.

Libellés de preuve sur cette page :

- **Source** signifie que le checkout actuel expose l'API.
- **Externe épinglé** signifie une release, un commit ou une page officielle consignés. Ce n'est pas un benchmark frais.
- **Déclaré** signifie qu'un exemple ou un test existe. Ce n'est pas un résultat réussi.
- **Lacune** signifie que ce dépôt ne prouve pas un engagement de compatibilité.

Le baseline documentaire historique est le commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. Le relevé de recherche contient deux commits go-micro : `9d306dcfc1a912a8a9493f31fee0bb983475258d` et, pour le mémo v6.9.0, `3c39d17fadaa9ec21b671be4afef3e63846406e6`. Traitez les deux comme des entrées à revérifier.

## Place dans la stack

| Outil     | Ce qu'il possède en général                                              | Ce que go-like ajoute à côté                                                               |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| NestJS    | Modules, controllers, decorators, l'application context                  | Un `Server` structurel seulement si vous écrivez cet adaptateur                            |
| Fastify   | Routes, hooks, plugins, le listener Node                                 | Une frontière de cycle de vie ou d'appel autour d'une ressource que Fastify possède encore |
| Hono      | Routes, middleware, `app.fetch`                                          | Paliers d'App, appels internes, plugs                                                      |
| Elysia    | Arbre de routes, schéma, hooks, son propre adaptateur                    | La même chose, tandis que `.listen()` reste à Elysia                                       |
| Koa       | Middleware et un routeur externe                                         | Cycle de vie et appels internes, pas un autre routeur                                      |
| tRPC      | Procédures, parseurs, adaptateurs                                        | Découverte, sélection et cycle de vie de l'App                                             |
| go-micro  | Go Context, service, registry, broker, et une surface d'agent plus large | Vocabulaire seulement. Pas d'ABI Go                                                        |
| go-kratos | Cycle de vie App, HTTP/gRPC, registry, config, Protobuf                  | Une composition TypeScript. Le chemin gRPC est Connect-ES, pas le runtime Google           |
| go-like   | Sockets, paliers, appels Fetch et SSE, plugs                             | L'application conserve les routes, la policy, l'auth et les détails de protocole natif     |

## Propriété

| Préoccupation             | go-like                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Routes externes           | Le framework ou le `Handler` de l'application                                                                       |
| Handler Web               | `(Request) => Response \| Promise<Response>`                                                                        |
| Cycle de vie du processus | `newApp`, trois paliers, hooks                                                                                      |
| Dépendances               | Constructeurs et options. Pas de conteneur                                                                          |
| Appels internes           | `Transport`, `Client`, `Server`, `defineService`, SSE `ServerStream`                                                |
| Découverte                | `Registry`, `Discovery`, filtres, cinq sélecteurs                                                                   |
| Retry                     | Une tentative, sauf si `withRetry` en autorise davantage                                                            |
| Streaming                 | Web Streams à la bordure ; JSON ou SSE en interne ; quatre cardinalités gRPC sur `@go-like/connectrpc/node`         |
| Instrumentation           | Core enregistre les unités de travail. Les plugs remplissent les sockets de télémétrie. Pas d'enregistrement global |

## Cycle de vie et Context

```ts
import type { Server } from "@go-like/core/lifecycle"

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

type Lifecycle = Server
void null as unknown as Lifecycle
```

`Server` est structurel : `start(ctx)` et `stop(ctx)`. Sur le palier ressources, `start` se résout lorsque la ressource est utilisable. Sur le palier serveurs, `start` peut rester en attente, et les arrêts des frères s'exécutent en concurrence. Les arrêts de ressources s'exécutent dans l'ordre inverse de déclaration. Un context Nest, un graphe de plugins Fastify ou un hook Elysia a son propre ordre. Comparez les propriétaires, pas le mot « graceful ».

Le Context expose `deadline()`, `done()`, `err()` et `value(key)`, avec `background`, `withCancel`, `withTimeout`, `withDeadline`, `withoutCancel` et `withValue`. Il utilise `AbortSignal` en interne. Ce n'est pas un `context.Context` Go et ce n'est pas une API gRPC.

## Appels, retry et flux

Le chemin interne est Client, Discovery facultative, filtres, sélecteur, transport, `POST /<service>/<endpoint>`, puis le handler serveur. Un endpoint typé valide le JSON avec Struct. Ce n'est pas un IDL. `withEndpoint("discovery:///name")` sélectionne un service. Une liste d'adresses directe ne le fait pas.

Les appels font une tentative, sauf si `withRetry` positionne `authorization` à `"idempotent"` ou `"caller-approved"`, un `maxAttempts` positif et `shouldRetry`. Cette autorisation est une déclaration. Une réponse déjà reçue n'est pas rejouée lorsque le retour ultérieur échoue.

```text
Web Handler
  Web Streams, framework SSE, or WebSocket

@go-like/core client and server
  one JSON body, or SSE when stream: true

@go-like/connectrpc
  Connect and gRPC-Web unary and server-streaming on Fetch

@go-like/connectrpc/node
  standard gRPC unary, server-streaming, client-streaming, and bidi
```

La boucle de retry par défaut de go-micro et les formes de streaming HTTP de go-kratos dépendent de la version. Revérifiez les commits épinglés avant de publier une comparaison qui en dépend.

## Runtimes

Les entrées partagées utilisent Fetch et `AbortSignal`, ou une capacité injectée. Le TLS personnalisé, HTTP/2 et mTLS vivent sur `@go-like/core/transport/http/node` et `@go-like/connectrpc/node`. Les exemples Hono, Elysia, H3 et Fetch ordinaire passent un handler Fetch à un host de core. Il n'y a pas de pont NestJS ni Fastify dans ce dépôt. La version de manifest `0.0.1` n'établit pas une publication npm.

## Par outil

**NestJS.** Les modules, les providers et les controllers restent à Nest. Une intégration est un `Server` dont l'application est propriétaire, autour de l'application Nest, avec une admission et une fermeture explicites. Ce dépôt n'inclut pas cet adaptateur.

**Fastify.** Les routes, l'encapsulation et le listener restent à Fastify. go-like ne convertit pas `request` / `reply` en `Handler` Fetch.

**Hono.** `examples/hono` passe `app.fetch` à `newNodeServer` et place ce host dans `server(...)`. Les routes restent dans Hono.

**Elysia.** Conservez l'arbre de routes et le comportement propre à Bun. L'exemple utilise le handler Fetch avec le host Node. `.listen()` n'est pas une API go-like.

**Koa.** Conservez le middleware et le routeur externe. Ajoutez une frontière de cycle de vie ou d'appel seulement là où vous pouvez nommer le propriétaire.

**tRPC.** Les procédures restent à tRPC. Un endpoint go-like est un Struct au-dessus de JSON Fetch, pas un routeur de procédures.

**go-micro et go-kratos.** Ce sont des références pour les appels Context-first, le cycle de vie et le vocabulaire de découverte. Les watchers de go-like produisent des instantanés de remplacement complet. L'entrée gRPC gérée est `@go-like/connectrpc/node`.

## Que choisir

Utilisez le framework qui possède le problème que vous avez réellement. Ajoutez un socket go-like lorsque la pièce manquante est l'admission, l'annulation, la découverte, ou un contrat de backend avec un propriétaire nommé. Installer chaque plug dans une application de framework déjà terminée retire le bénéfice des petits contrats.

## Ancres de preuve

Arborescence actuelle :

- `packages/core/src/app/app.ts` et `packages/core/src/app/tiers.ts` pour les paliers, les budgets et l'ordre d'arrêt ;
- `packages/core/src/lifecycle/index.ts` pour `Server` et `Endpointer` ;
- `packages/core/src/web/context.ts` pour `Handler` et `contextHandler` ;
- `packages/core/src/client/index.ts` pour les options d'appel, la découverte et le retry ;
- `packages/core/src/server/index.ts` pour le dispatch interne ;
- `packages/core/src/transport/service.ts` pour `defineService` ;
- `packages/core/src/registry/selector.ts` pour les filtres, les sélecteurs et le retour ;
- `packages/connectrpc/src/node.ts` pour le gRPC géré.

Entrées externes épinglées, non revalidées par cette édition documentaire :

- [commit de comparaison go-micro](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d) ;
- [commit go-micro v6.9.0](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6) ;
- [commit go-kratos v3](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e) ;
- [commit go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336) ;
- [cycle de vie NestJS](https://docs.nestjs.com/fundamentals/lifecycle-events), [serveur Fastify](https://fastify.dev/docs/latest/Reference/Server/), [Hono](https://hono.dev/docs/api/hono), [cycle de vie Elysia](https://elysiajs.com/essential/life-cycle), [Koa](https://koajs.com/), [routeurs tRPC](https://trpc.io/docs/server/routers).

Versions TypeScript tierces consignées pour la comparaison, pas comme promesses de compatibilité : NestJS `@nestjs/core@11.1.28`, Fastify `5.11.2`, Hono `4.12.34`, Elysia `1.4.29`, Koa `3.2.1`, tRPC `@trpc/server@11.18.0`. Le manifest de l'exemple Elysia est l'épingle de cet exemple ; ce tableau est l'instantané de recherche.

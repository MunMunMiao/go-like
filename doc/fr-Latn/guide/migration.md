# Migration et adoption

La règle de migration la plus sûre est la suivante : **conservez le plan de données et adoptez la frontière que vous savez expliquer**.

Gardez le framework Web, le worker, le scheduler, le broker, le logger ou le fournisseur de télémétrie existant. Ajoutez un contrat go-like explicite autour d'un vrai problème de cycle de vie ou d'appel de service. Vérifiez cette frontière avant d'ajouter un autre fournisseur.

## Une migration par étapes

1. Laissez le bootstrap existant et le code des routes/du plan de données inchangés.
2. Identifiez un propriétaire : listener, worker, scheduler, souscription de broker, destination de logs ou fournisseur de télémétrie.
3. Ajoutez un adaptateur `Server` structurel ou utilisez un adaptateur go-like existant. Définissez l'admission, l'arrêt, le timeout et l'observation terminale.
4. Ajoutez `@go-like/context` aux vraies frontières d'annulation ou d'échéance. Transmettez-le comme premier argument de l'opération.
5. Ajoutez liveness et readiness avec `@go-like/health` et `@go-like/web/health`.
6. Ajoutez un appel interne unaire typé en utilisant `@go-like/transport-memory` dans les tests.
7. Ne déplacez cet appel vers `@go-like/transport-http` ou `@go-like/transport-http/node` que lorsqu'un wire réel ou un host Node natif est nécessaire.
8. Ajoutez Registry, Config, Store, Cache, Broker, logs, métriques ou traces, une capacité à la fois.
9. Notez le fournisseur, le runtime, le propriétaire et le niveau de preuve de chaque nouvelle frontière.

Ne commencez pas par une réécriture du service entier. L'intérêt de petits contrats est de garder petite l'unité de migration.

## Matrice de migration des frameworks

| Système existant | Gardez natif                                                                        | Adoptez d'abord                                                                                                        | Frontière actuelle                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| NestJS           | Modules, controllers, decorators, DI, interceptors, pipes, adapter                  | Un `Server` structurel personnalisé autour de l'application existante ou une frontière interne Client/Server distincte | Aucun pont Nest go-like ni intégration DI automatique n'existe dans ce dépôt                                                 |
| Fastify          | Routes, plugins, hooks, request/reply, listener natif                               | Un wrapper de cycle de vie personnalisé ou un pont Fetch explicitement implémenté                                      | Aucune conversion actuelle de request/reply Fastify vers un Handler go-like n'est démontrée                                  |
| Hono             | Routes, middleware, sous-applications, `app.fetch`                                  | `newNodeServer(app.fetch, ...)`, puis `newApp(...)`                                                                    | L'intégration Fetch native est démontrée dans `examples/hono`                                                                |
| Elysia           | Arbre de routes, schémas, decorators, derives, hooks, comportement Bun/Web Standard | `app.fetch` natif avec le host/cycle de vie Core lorsque c'est pertinent                                               | Conservez la sémantique Bun de `.listen()` ; n'en faites pas une API go-like inter-runtime                                   |
| H3               | Routeur H3 et conversion native du handler                                          | Le chemin Fetch du handler de l'exemple H3 actuel                                                                      | `app.fetch` de H3 2.x est la forme démontrée ; l'ancienne recommandation `toWebHandler` nécessite son propre exemple épinglé |
| Koa              | Middleware et routeur externe                                                       | Un wrapper du propriétaire ou un appel de service interne                                                              | `@go-like/web` n'accepte pas l'objet Node request/reply de Koa sans pont applicatif                                          |
| tRPC             | Router, middleware de procédures, parseurs input/output, adaptateur                 | Le cycle de vie Core autour du host ou une frontière de transport interne séparée                                      | L'Endpoint go-like n'est pas un router de procédures tRPC                                                                    |

### Exemple Hono

Voici la forme d'intégration démontrée :

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/web/node"

const web = new Hono().get("/users/:id", (c) => c.json({ id: c.req.param("id") }))

const app = newApp(name("users"), server(newNodeServer(web.fetch, port(3000))), signal())

await app.run()
```

L'exemple Hono actuel conserve à Hono la responsabilité des routes et transmet le handler Fetch natif au host Node. Il n'ajoute ni table de routes go-like ni paquet de pont spécifique à Hono.

### Elysia et H3

Appliquez la même frontière à un framework qui expose un handler Fetch standard :

```text
framework route table
  -> framework native Fetch handler
  -> @go-like/web/node (when using the Node host)
  -> @go-like/core App
```

Vérifiez l'adaptateur de runtime du framework avant d'importer un sous-chemin Node. L'adaptateur Bun d'Elysia et son adaptateur Web Standard n'ont pas un comportement d'écoute identique. Les versions de H3 et leurs API de conversion des handlers nécessitent également un exemple épinglé. Ne déduisez pas une promesse pour toute combinaison de versions et de runtimes à partir d'un seul exemple.

## Migrer un service Go

Pour un lecteur venant de Go ou de Kratos, migrez les concepts plutôt que les noms :

| Concept Go          | Concept go-like                                                                                                    | Différence importante                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `context.Context`   | `@go-like/context` `Context`                                                                                       | `done()` est un `AbortSignal` ou `null`, pas un channel Go                      |
| Cycle de vie Server | `Server` structurel de Core                                                                                        | `start(ctx)` peut durer toute la vie du service et ne signifie pas readiness    |
| App runner          | `newApp`, `App.run`, `App.stop`                                                                                    | `App.stop()` n'accepte pas de Context du caller et renvoie une Promise partagée |
| RPC client          | `@go-like/client`                                                                                                  | Les appels internes sont des `Message` unaires ; le retry est opt-in            |
| Transport           | `@go-like/transport`                                                                                               | Les fournisseurs et les headers de `Message` sont des contrats TypeScript/Web   |
| Registry            | `@go-like/registry`                                                                                                | Les watchers renvoient des snapshots de remplacement complet                    |
| Selector            | `newRoundRobinSelector`, `newRandomSelector`, `newWeightedRoundRobinSelector`, `newP2CSelector`, `newEWMASelector` | Le feedback est synchrone et propre à la policy                                 |
| Protobuf/IDL        | aucun équivalent go-like                                                                                           | `Endpoint` + `Struct` est une validation runtime, pas du code de schéma généré  |
| gRPC stream         | aucun équivalent go-like actuel                                                                                    | Le streaming Web public est séparé du transport interne unaire                  |

Un premier pas incrémental consiste à effectuer un appel typé à une adresse directe sur Memory Transport :

```ts
const transport = newMemoryTransport()
const server = newServer(
  serverTransport(transport),
  address("memory://pricing"),
  handler(pricingEndpoint, pricingHandler)
)
const client = newClient(withTransport(transport))

const result = await client.call(ctx, pricingEndpoint, request, withAddress("memory://pricing"))
```

Ce n'est qu'après avoir testé cette frontière qu'il faut introduire Discovery, un fournisseur Registry réel ou un transport HTTP. Vous conservez ainsi le contrat métier tout en remplaçant la destination et le câblage de propriété.

## Adopter Kubernetes

Gardez Kubernetes natif :

- Deployments, Services, DNS, Ingress, RBAC, probes, stratégie de rollout, HPA et network policy restent des responsabilités de la plateforme ;
- `@go-like/config-kubernetes` lit une clé dans un ConfigMap ou Secret d'un seul namespace via une capacité Fetch injectée ;
- `@go-like/registry-kubernetes` utilise les enregistrements EndpointSlice lorsqu'une découverte directe est réellement nécessaire ;
- un EndpointSlice n'est pas le DNS d'un Kubernetes Service et ne fournit pas de TTL d'enregistrement universel ;
- les références facultatives au propriétaire du Pod et le deregistration explicite ont des sémantiques d'échec différentes.

Commencez par la santé et la configuration avant de sélectionner directement depuis des EndpointSlice. Si l'application dispose déjà d'un nom DNS stable de Service, `withAddress(...)` avec un transport HTTP peut être plus simple et plus honnête que l'ajout d'un fournisseur Registry.

## Adopter les brokers et les jobs

Conservez natifs le règlement et la policy des jobs :

| Plan de données existant | À garder                                                         | Ajoutez go-like pour                                                                    |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| NATS Core                | Connection, subscription, queue group, `Msg`, drain              | `newNatsCoreServer`, `newNatsCoreBroker`, cycle de vie et frontière de bytes            |
| NATS JetStream           | Stream, durable consumer, `JsMsg`, ack/nak/term, redelivery, DLQ | `newNatsJetStreamServer`, `newNatsJetStreamBroker`, cycle de vie                        |
| RabbitMQ                 | Connection, topology, confirm policy, channel                    | Cycle de vie du subscriber borrowed ou recovering et règlement natif sûr par génération |
| BullMQ                   | Queue, Worker, processor, retry/backoff, Redis                   | `newBullMqWorkerServer` autour d'un Worker officiel dormant                             |
| Croner                   | Cron expression, time zone, callback, overlap policy             | `newCronerServer` autour de jobs Cron natifs en pause                                   |
| Memory Broker            | Map de topics en processus et sémantique de test                 | `newBrokerServer` et un codec d'événement facultatif                                    |

Ne migrez pas ack/nak/term de NATS, le règlement durable de JetStream, les confirmations RabbitMQ ou les retries BullMQ dans une abstraction générique go-like Broker. Ces sémantiques expliquent précisément pourquoi l'objet natif du fournisseur reste visible.

## Migrer l'état

Choisissez un domaine d'état à la fois :

- Config pour les snapshots immuables de configuration du processus et le reload ;
- Registry pour la joignabilité éphémère des services ;
- Store pour les enregistrements faisant autorité, les révisions, CAS, TTL et pages ;
- Cache pour les valeurs jetables qui peuvent être recalculées.

Un test de migration utile consiste à noter ce qui se passe après un redémarrage du processus, une lecture obsolète, une panne du fournisseur, une compaction du watcher, un conflit CAS et un cache miss. Si la réponse diffère, ces domaines ne devraient pas partager une interface générique de repository.

## Ajouter l'observabilité

Ajoutez d'abord le fournisseur natif, puis enveloppez la frontière :

```text
application creates logger / Registry / MeterProvider / TracerProvider
  -> go-like wrapper records bounded operation facts
  -> application-owned exporter or destination
  -> explicit Core lifecycle adapter closes the admitted resource
```

`@go-like/prometheus` n'utilise pas le registre global. `@go-like/otel` n'installe ni fournisseurs ni exporters globaux. Les adaptateurs Pino et Winston ne remplacent pas la configuration native du logger. Gardez les labels et attributs bornés et masquez séparément les logs appartenant à l'application.

## Checklist d'acceptation de la migration

Avant de fusionner une frontière, vérifiez :

- un propriétaire clairement nommé existe ;
- le propriétaire reçoit le bon Context et ne le remplace pas par `background()` ;
- l'admission au démarrage et la readiness sont distinctes ;
- le comportement du timeout d'arrêt est documenté comme une limite d'attente ;
- l'observation terminale native est conservée lorsqu'elle existe ;
- les handlers Web externes et les handlers unaires internes ne sont pas mélangés ;
- l'autorisation de retry correspond à l'opération métier ;
- les credentials, metadata, logs et attributs de trace ont une policy de masquage ;
- les sémantiques propres au fournisseur restent visibles ;
- la commande unit/typecheck ciblée a réussi dans le checkout visé ;
- la commande E2E pertinente (runtime, fournisseur, publication ou exemple) a été exécutée et consignée, ou explicitement marquée comme non exécutée.

## Frontière de support actuelle

Le dépôt contient des exemples directs pour Fetch sans framework, Hono, Elysia, H3, Memory Transport, appels internes typés, santé, brokers, workers et adaptateurs d'observabilité. Il ne prouve pas de ponts automatiques pour NestJS ou Fastify, de compatibilité gRPC/Protobuf/IDL, de streams internes full-duplex, d'authentification universelle ni d'orchestration de déploiement. Ces sujets exigeraient des adaptateurs, des tests et des engagements produit distincts.

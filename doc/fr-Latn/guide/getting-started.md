# Bien démarrer

Ce guide suit le plus court chemin utile dans go-like :

1. Exécuter un handler Fetch standard sur un host Node, dans une seule App.
2. Enregistrer la readiness pour que `/readyz` puisse réussir.
3. Ajouter un Context de requête explicite lorsque le handler fait un travail annulable.
4. Passer au [projet Rendez-vous en clinique](/fr-Latn/guide/zero-to-one) lorsque ce cycle de vie est clair.

go-like n'est pas le routeur. Le handler peut venir de code Web ordinaire, de Hono, d'Elysia, de H3 ou d'un autre framework qui expose la forme Fetch standard.

## Avant l'installation

La racine du dépôt est privée et enregistre la version de paquet `0.0.1`. Cette version n'établit pas la disponibilité sur npm. Depuis un checkout :

```sh
bun install --frozen-lockfile
```

Le dépôt n'utilise pas les versions de runtime ou d'outil comme condition d'exécution. Chaque piste de vérification sélectionnée contrôle que ses outils requis peuvent s'exécuter et consigne l'environnement observé.

Lorsqu'une release publiée est confirmée indépendamment, un petit service Web Node dépend d'un seul paquet :

```sh
bun add @go-like/core
```

Les logs, les métriques, les traces et les backends d'écosystème sont des plugs séparés. Ajoutez-en un seulement lorsque l'application construit ce client natif.

## Un service Web

`Handler` se trouve dans `@go-like/core/web`. Le host Node se trouve dans `@go-like/core/web/node`. Les signaux de processus se trouvent dans `@go-like/core/node`. La forme suivante est l'API publique actuelle. Passez `signal()` vous-même : core n'installe pas de gestionnaires de signaux. Passez `readyProbe(probes)` sur le même registre que le handler de santé, sinon `/readyz` reste fermé.

```ts
import { name, newApp, readyProbe, server, version } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { signal } from "@go-like/core/node"
import { contextHandler, createHealthHandler, requestContext } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"

const probes = newProbeRegistry()
probes.register("ready", "warmup", async () => {
  // Check a process-local dependency here. Return to pass, throw to fail.
})

const health = createHealthHandler(probes)
const handler = contextHandler(async (ctx, request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return Response.json({
    path: pathname,
    hasContext: requestContext(request) !== null && ctx.err() === null
  })
})

const web = newNodeServer(handler, port(3000))
export const app = newApp(
  signal(),
  name("hello-web"),
  version("v1"),
  readyProbe(probes),
  server(web)
)

await app.run()
```

`run()` se résout après l'arrêt de l'App. `Ctrl-C` délivre `SIGINT`. `signal()` mappe le premier `SIGTERM`, `SIGQUIT` ou `SIGINT` vers le même `App.stop()` idempotent et positionne `process.exitCode` à `128` plus le numéro du signal. Un signal ultérieur est laissé au runtime.

Une liveness vide réussit. Une readiness vide échoue en position fermée. `readyProbe` ne réussit qu'après la fin du démarrage et avant le début de l'arrêt. Voir [Santé et observabilité](/fr-Latn/guide/health-observability).

### Premier point de contrôle

- Le handler possède la route d'URL.
- `web` possède le socket réseau d'écoute.
- `app` admet ce serveur, puis l'arrête.
- `stopTimeout`, lorsqu'il est défini, borne la durée d'attente de `run()`. Il ne termine pas, à lui seul, un socket réseau natif qui ignore l'arrêt.

## Ajouter un Context de requête

`contextHandler` adapte `(ctx, request)` en `Handler` Fetch. Le host stocke le Context de requête sur la `Request`. `requestContext(request)` le relit. Le Context porte l'AppInfo et, lorsque la télémétrie est installée, le span `http.server`. Il est annulé lorsque la requête se termine ou est abandonnée.

```ts
import type { Context } from "@go-like/core/context"
import { contextHandler, type Handler } from "@go-like/core/web"

export const handler: Handler = contextHandler(async (ctx: Context, request: Request) => {
  if (ctx.err() !== null) return new Response(null, { status: 499 })
  const url = new URL(request.url)
  return Response.json({ path: url.pathname })
})
```

Pour un travail qui continue après que le handler a renvoyé un corps, observez aussi `request.signal`. `contextHandler` termine son Context lorsque le handler renvoie la `Response`.

## Utiliser un framework Fetch existant

Les exemples Hono, Elysia et H3 passent la fonction Fetch du framework à `newNodeServer` et placent ce host dans `server(...)`. Le framework conserve les routes et le middleware.

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/core/web/node"

const app = new Hono()
app.get("/hello", (c) => c.json({ ok: true }))

const web = newNodeServer(app.fetch, port(3000))
await newApp(signal(), name("hono"), server(web)).run()
```

Les copies exécutables sont `examples/hono`, `examples/elysia`, `examples/h3` et `examples/vanilla-web`.

## Apprendre dans l'ordre

1. Cette page : un host, une App, une probe ready.
2. [Rendez-vous en clinique](/fr-Latn/guide/zero-to-one) : un invariant de domaine et un appel unaire interne.
3. [Architecture](/fr-Latn/guide/architecture) : palier ressources, palier serveurs et budgets.
4. [Appels de service](/fr-Latn/guide/service-call), puis [Configuration, registre, Store et cache](/fr-Latn/guide/config-registry-store).
5. [Santé et observabilité](/fr-Latn/guide/health-observability) lorsque vous ajoutez des logs, des métriques ou des traces.

## Commandes depuis le checkout

Depuis la racine du dépôt, après `bun install --frozen-lockfile` :

```sh
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments test:unit
```

Ces commandes font le typecheck et exécutent les tests unitaires de l'exemple. Elles ne démarrent pas Docker et ne prouvent pas une publication npm.

## Échecs au premier lancement

| Ce que vous voyez                                | Ce que cela signifie en général                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/readyz` renvoie 503                            | Le registre n'a aucune probe de readiness qui réussit. Enregistrez-en une, y compris `readyProbe(probes)` si l'App elle-même compte.                            |
| Le processus se termine sur `SIGTERM` sans drain | `signal()` a été omis.                                                                                                                                          |
| `TypeError: pass telemetry with telemetry(...)`  | Un bundle `Telemetry` a été passé à `server(...)` ou `resources(...)`. Utilisez `telemetry(tel)`.                                                               |
| Le port est déjà utilisé                         | Un autre processus le détient. L'erreur du host est l'erreur d'écoute du runtime.                                                                               |
| `Cannot find package`                            | L'installation du workspace n'a pas été exécutée, ou l'import utilise encore un spécificateur d'avant la migration. Voir [Migration](/fr-Latn/guide/migration). |

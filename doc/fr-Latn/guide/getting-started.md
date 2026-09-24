# Bien démarrer

Installez uniquement les briques utiles. Un service HTTP classique part de `@go-like/context`, `@go-like/core`, `@go-like/web` et d’un framework qui expose un handler Fetch natif. Les appels internes ajoutent `@go-like/client`, `@go-like/transport` et `@go-like/transport-http` ; registre, configuration et stockage sont des choix explicites.

> [!IMPORTANT]
> Ce checkout utilise des paquets `workspace:*` en version `0.0.1`. La version du manifest ne prouve pas leur disponibilité sur npm ; vérifiez la publication avant une installation hors workspace.
>
> ```sh
> bun install --frozen-lockfile
> bun run test:e2e:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @go-like/context @go-like/core @go-like/web
```

Créez `src/main.ts` :

```ts
import process from "node:process"

import { background } from "@go-like/context"
import { afterStart, context, name, newApp, server, stopTimeout } from "@go-like/core"
import { signal } from "@go-like/core/node"
import type { Handler } from "@go-like/web"
import { newNodeServer, port } from "@go-like/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from go-like", path })
}

const webServer = newNodeServer(handler, port(3000))
const app = newApp(
  context(background()),
  name("hello"),
  server(webServer),
  stopTimeout(30_000),
  signal(),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=hello\n")
  })
)

await app.run()
```

Exécutez le service :

```sh
bun run src/main.ts
```

Attendez la ligne `GO_LIKE_EXAMPLE_READY=hello` avant d’envoyer du trafic. Tout objet qui satisfait structurellement l’interface `Server` peut rejoindre l’application. `@go-like/croner`, `@go-like/bullmq`, `@go-like/pino` et `@go-like/winston` raccordent déjà des bibliothèques répandues, sans recopier toute leur surface d’options.

L’application continue de créer les connexions, les identifiants, les routes et la configuration du framework. Elle transmet seulement la capacité minimale à go-like, souvent un objet natif ou un `fetch`. Les tests restent ainsi maîtrisables et, à l’arrêt, chacun sait quelle ressource il doit fermer.

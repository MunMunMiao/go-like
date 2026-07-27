# Bien démarrer

Installez uniquement les briques utiles. Un service HTTP classique part de `@likego/context`, `@likego/core`, `@likego/web` et du pont vers le framework choisi. Les appels internes ajoutent `@likego/client`, `@likego/transport` et `@likego/transport-http` ; registre, configuration et stockage sont des choix explicites.

> [!IMPORTANT]
> Les paquets `@likego/*` ne sont pas encore publiés sur npm. Depuis une copie de travail du dépôt, `workspace:*` résout les dépendances vers les paquets `@likego/*` locaux ; la version `0.0.1` des manifestes ne signifie pas qu’ils sont disponibles sur npm. La commande `bun add` ci-dessous décrit donc le parcours après publication. Pour valider et exécuter le code source actuel depuis la racine du dépôt :
>
> ```sh
> bun install --frozen-lockfile
> bun run test:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @likego/context @likego/core @likego/web
```

Créez `src/main.ts` :

```ts
import { background } from "@likego/context"
import { context, name, newApp, server, stopTimeout } from "@likego/core"
import { signal } from "@likego/core/node"
import type { Handler } from "@likego/web"
import { newNodeServer, port } from "@likego/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from LikeGo", path })
}

const app = newApp(
  context(background()),
  name("hello"),
  server(newNodeServer(handler, port(3000))),
  stopTimeout(30_000),
  signal()
)

await app.run()
```

Exécutez le service :

```sh
bun run src/main.ts
```

Tout objet qui satisfait structurellement l’interface `Server` peut rejoindre l’application. `@likego/croner`, `@likego/bullmq`, `@likego/pino` et `@likego/winston` raccordent déjà des bibliothèques répandues, sans recopier toute leur surface d’options.

L’application continue de créer les connexions, les identifiants, les routes et la configuration du framework. Elle transmet seulement la capacité minimale à LikeGo, souvent un objet natif ou un `fetch`. Les tests restent ainsi maîtrisables et, à l’arrêt, chacun sait quelle ressource il doit fermer.

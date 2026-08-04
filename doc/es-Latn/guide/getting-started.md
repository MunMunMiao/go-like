# Primeros pasos

Instala solo las piezas que necesites. Un servicio HTTP habitual parte de `@go-like/context`, `@go-like/core`, `@go-like/web` y un framework que exponga un handler Fetch nativo. Para llamadas internas añade `@go-like/client`, `@go-like/transport` y `@go-like/transport-http`; el registro, la configuración y el almacén se eligen de forma explícita.

> [!IMPORTANT]
> Este checkout enlaza los paquetes `@go-like/*` mediante `workspace:*` con la versión de manifest `0.0.1`; esa versión todavía no se ha publicado en npm. El comando `bun add` de abajo describe el uso posterior a la publicación. Para validar y ejecutar el código fuente actual desde la raíz del repositorio:
>
> ```sh
> bun install --frozen-lockfile
> bun run test:e2e:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @go-like/context @go-like/core @go-like/web
```

Crea `src/main.ts`:

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

Ejecuta el servicio:

```sh
bun run src/main.ts
```

Espera la línea `GO_LIKE_EXAMPLE_READY=hello` antes de enviar tráfico. Cualquier objeto que cumpla estructuralmente la interfaz `Server` cabe en la aplicación. `@go-like/croner`, `@go-like/bullmq`, `@go-like/pino` y `@go-like/winston` ya conectan bibliotecas conocidas, pero no vuelven a inventar todas sus opciones.

La aplicación sigue creando conexiones, credenciales, rutas y configuración del framework. Pasa a go-like la capacidad mínima, normalmente un objeto nativo o una función `fetch`. Así las pruebas se controlan mejor y al apagar queda claro quién debe cerrar cada recurso.

# Primeros pasos

Instala solo las piezas que necesites. Un servicio HTTP habitual parte de `@likego/context`, `@likego/core`, `@likego/web` y el adaptador del framework elegido. Para llamadas internas añade `@likego/client`, `@likego/transport` y `@likego/transport-http`; el registro, la configuración y el almacén se eligen de forma explícita.

> [!IMPORTANT]
> Este checkout enlaza los paquetes `@likego/*` mediante `workspace:*` con la versión de manifest `0.0.1`; esa versión todavía no se ha publicado en npm. El comando `bun add` de abajo describe el uso posterior a la publicación. Para validar y ejecutar el código fuente actual desde la raíz del repositorio:
>
> ```sh
> bun install --frozen-lockfile
> bun run test:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @likego/context @likego/core @likego/web
```

Crea `src/main.ts`:

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

Ejecuta el servicio:

```sh
bun run src/main.ts
```

Cualquier objeto que cumpla estructuralmente la interfaz `Server` cabe en la aplicación. `@likego/croner`, `@likego/bullmq`, `@likego/pino` y `@likego/winston` ya conectan bibliotecas conocidas, pero no vuelven a inventar todas sus opciones.

La aplicación sigue creando conexiones, credenciales, rutas y configuración del framework. Pasa a LikeGo la capacidad mínima, normalmente un objeto nativo o una función `fetch`. Así las pruebas se controlan mejor y al apagar queda claro quién debe cerrar cada recurso.

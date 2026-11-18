# Primeros pasos

Esta guía toma el recorrido útil más corto por go-like:

1. Ejecutar un handler Fetch estándar en un host de Node, dentro de una App.
2. Registrar readiness para que `/readyz` pueda pasar.
3. Añadir un Context de petición explícito cuando el handler hace trabajo cancelable.
4. Pasar al [proyecto de citas de una clínica](/es-Latn/guide/zero-to-one) cuando ese ciclo de vida esté claro.

go-like no es el router. El handler puede venir de código Web plano, Hono, Elysia, H3 u otro framework que exponga la forma Fetch estándar.

## Antes de instalar

La raíz del repositorio es privada y registra la versión de paquete `0.0.1`. Esa versión no establece disponibilidad en npm. Desde un checkout:

```sh
bun install --frozen-lockfile
```

El repositorio no usa versiones de runtime ni de herramientas como criterio de elegibilidad de ejecución. Cada carril de verificación elegido comprueba que sus herramientas necesarias pueden ejecutarse y registra el entorno observado.

Cuando una release publicada se confirma por separado, un servicio Web pequeño de Node depende de un paquete:

```sh
bun add @go-like/core
```

Logs, métricas, trazas y backends del ecosistema son plugs aparte. Añade uno solo cuando la aplicación construye ese cliente nativo.

## Un servicio Web

`Handler` vive en `@go-like/core/web`. El host de Node vive en `@go-like/core/web/node`. Las señales de proceso viven en `@go-like/core/node`. La forma siguiente es la API pública actual. Hay que pasar `signal()`: core no instala manejadores de señales. Hay que pasar `readyProbe(probes)` sobre el mismo registro que usa el handler de salud, o `/readyz` permanece cerrado.

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

`run()` se resuelve después de que la App se detiene. `Ctrl-C` entrega `SIGINT`. `signal()` asigna el primer `SIGTERM`, `SIGQUIT` o `SIGINT` al mismo `App.stop()` idempotente y pone `process.exitCode` en `128` más el número de la señal. Una señal posterior queda en manos del runtime.

El liveness vacío pasa. El readiness vacío falla cerrado. `readyProbe` pasa solo después de que el arranque ha terminado y antes de que empiece la parada. Véase [Salud y observabilidad](/es-Latn/guide/health-observability).

### Primer punto de control

- El handler es dueño de la ruta URL.
- `web` es dueño del socket de escucha.
- `app` admite ese servidor y después lo detiene.
- `stopTimeout`, cuando se define, acota cuánto espera `run()`. Por sí solo no termina un socket nativo que ignora el apagado.

## Añadir un Context de petición

`contextHandler` adapta `(ctx, request)` a un `Handler` de Fetch. El host guarda el Context de la petición en el `Request`. `requestContext(request)` lo vuelve a leer. El Context transporta AppInfo y, cuando la telemetría está instalada, el span `http.server`. Se cancela cuando la petición termina o se aborta.

```ts
import type { Context } from "@go-like/core/context"
import { contextHandler, type Handler } from "@go-like/core/web"

export const handler: Handler = contextHandler(async (ctx: Context, request: Request) => {
  if (ctx.err() !== null) return new Response(null, { status: 499 })
  const url = new URL(request.url)
  return Response.json({ path: url.pathname })
})
```

Para el trabajo que continúa después de que el handler devuelve un body, hay que observar también `request.signal`. `contextHandler` termina su Context cuando el handler devuelve la `Response`.

## Usar un framework Fetch existente

Los ejemplos de Hono, Elysia y H3 pasan la función Fetch del framework a `newNodeServer` y colocan ese host en `server(...)`. El framework conserva las rutas y el middleware.

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

Las copias ejecutables son `examples/hono`, `examples/elysia`, `examples/h3` y `examples/vanilla-web`.

## Aprender en orden

1. Esta página: un host, una App, una sonda de ready.
2. [Sistema de citas de una clínica](/es-Latn/guide/zero-to-one): una invariante de dominio y una llamada unary interna.
3. [Arquitectura](/es-Latn/guide/architecture): nivel de recursos, nivel de servidores y presupuestos.
4. [Llamadas de servicio](/es-Latn/guide/service-call) y, después, [Configuración, registro, almacenamiento y caché](/es-Latn/guide/config-registry-store).
5. [Salud y observabilidad](/es-Latn/guide/health-observability) cuando se añaden logs, métricas o trazas.

## Comandos del checkout

Desde la raíz del repositorio, después de `bun install --frozen-lockfile`:

```sh
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments test:unit
```

Esos comandos comprueban tipos y ejecutan las pruebas unitarias del ejemplo. No arrancan Docker ni demuestran la publicación en npm.

## Fallos del primer arranque

| Lo que se ve                                    | Lo que suele significar                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/readyz` devuelve 503                          | El registro no tiene una sonda de readiness que pase. Hay que registrar una, incluido `readyProbe(probes)` si la propia App debe contar.                     |
| El proceso sale con `SIGTERM` sin drenar        | Se omitió `signal()`.                                                                                                                                        |
| `TypeError: pass telemetry with telemetry(...)` | Se pasó un bundle `Telemetry` a `server(...)` o a `resources(...)`. Hay que usar `telemetry(tel)`.                                                           |
| El puerto ya está en uso                        | Otro proceso lo retiene. El error del host es el error de listen del runtime.                                                                                |
| `Cannot find package`                           | No se ha ejecutado la instalación del workspace, o el import sigue usando un specifier anterior a la migración. Véase [Migración](/es-Latn/guide/migration). |

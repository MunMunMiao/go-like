# go-like frente a otras herramientas

Una comparación justa empieza por la propiedad. NestJS, Fastify, Hono, Elysia, Koa y tRPC resuelven partes distintas de una aplicación TypeScript. go-micro y go-kratos son referencias de Go con transportes y generación de código distintos. go-like es un panel de sockets: niveles de ciclo de vida explícitos, llamadas internas y plugs para los backends que se eligen.

Etiquetas de evidencia en esta página:

- **Source** significa que el checkout actual expone la API.
- **Pinned external** significa una release, un commit o una página oficial registrados. No es un benchmark nuevo.
- **Declared** significa que existe un ejemplo o una prueba. No es un resultado aprobado.
- **Gap** significa que este repositorio no demuestra un compromiso de compatibilidad.

El baseline histórico de la documentación es el commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. El registro de investigación contiene dos commits de go-micro: `9d306dcfc1a912a8a9493f31fee0bb983475258d` y, para el memo de v6.9.0, `3c39d17fadaa9ec21b671be4afef3e63846406e6`. Hay que tratarlos como entradas que deben volver a comprobarse.

## Lugar en el stack

| Herramienta | Lo que suele poseer                                                        | Lo que go-like añade al lado                                                                   |
| ----------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| NestJS      | Modules, controllers, decorators, el application context                   | Un `Server` estructural solo si se escribe ese adaptador                                       |
| Fastify     | Rutas, hooks, plugins, el listener de Node                                 | Una frontera de ciclo de vida o de llamada alrededor de un recurso que Fastify sigue poseyendo |
| Hono        | Rutas, middleware, `app.fetch`                                             | Niveles de App, llamadas internas, plugs                                                       |
| Elysia      | Árbol de rutas, schema, hooks, su propio adaptador                         | Lo mismo, mientras `.listen()` sigue siendo de Elysia                                          |
| Koa         | Middleware y un router externo                                             | Ciclo de vida y llamadas internas, no otro router                                              |
| tRPC        | Procedimientos, parsers, adaptadores                                       | Descubrimiento, selección y ciclo de vida de la App                                            |
| go-micro    | Go Context, service, registry, broker y una superficie de agent más amplia | Solo vocabulario. No hay ABI de Go                                                             |
| go-kratos   | Ciclo de vida de App, HTTP/gRPC, registry, config, Protobuf                | Una composición de TypeScript. El camino gRPC es Connect-ES, no el runtime de Google           |
| go-like     | Sockets, niveles, llamadas Fetch y SSE, plugs                              | La aplicación sigue poseyendo rutas, policy, auth y los detalles del protocolo nativo          |

## Propiedad

| Preocupación              | go-like                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Rutas externas            | El framework o el `Handler` de la aplicación                                                             |
| Handler Web               | `(Request) => Response \| Promise<Response>`                                                             |
| Ciclo de vida del proceso | `newApp`, tres niveles, hooks                                                                            |
| Dependencias              | Constructores y opciones. No hay contenedor                                                              |
| Llamadas internas         | `Transport`, `Client`, `Server`, `defineService`, SSE `ServerStream`                                     |
| Descubrimiento            | `Registry`, `Discovery`, filtros, cinco selectores                                                       |
| Retry                     | Un intento, salvo que `withRetry` autorice más                                                           |
| Streaming                 | Web Streams en el borde; JSON o SSE por dentro; cuatro cardinalidades gRPC en `@go-like/connectrpc/node` |
| Instrumentación           | Core registra unidades de trabajo. Los plugs rellenan sockets de telemetría. No hay registro global      |

## Ciclo de vida y Context

```ts
import type { Server } from "@go-like/core/lifecycle"

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

type Lifecycle = Server
void null as unknown as Lifecycle
```

`Server` es estructural: `start(ctx)` y `stop(ctx)`. En el nivel de recursos, `start` se resuelve cuando el recurso se puede usar. En el nivel de servidores, `start` puede seguir pendiente, y las paradas de los hermanos corren a la vez. Las paradas de recursos corren en orden inverso de declaración. Un context de Nest, un grafo de plugins de Fastify o un hook de Elysia tienen su propio orden. Hay que comparar propietarios, no la palabra "graceful".

Context expone `deadline()`, `done()`, `err()` y `value(key)`, con `background`, `withCancel`, `withTimeout`, `withDeadline`, `withoutCancel` y `withValue`. Usa `AbortSignal` por dentro. No es un `context.Context` de Go y no es una API de gRPC.

## Llamadas, retry y streams

El camino interno es Client, Discovery opcional, filtros, selector, transporte, `POST /<service>/<endpoint>` y después el handler del servidor. Un endpoint tipado valida JSON con Struct. No es un IDL. `withEndpoint("discovery:///name")` selecciona un servicio. Una lista de direcciones directa no.

Las llamadas hacen un intento salvo que `withRetry` ponga `authorization` en `"idempotent"` o `"caller-approved"`, un `maxAttempts` positivo y `shouldRetry`. Esa autorización es una declaración. Una respuesta ya recibida no se repite cuando falla un feedback posterior.

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

El bucle de retry por defecto de go-micro y las formas de streaming HTTP de go-kratos dependen de la versión. Hay que volver a comprobar los commits fijados antes de publicar una comparación que dependa de ellos.

## Runtimes

Las entradas compartidas usan Fetch y `AbortSignal`, o una capacidad inyectada. TLS a medida, HTTP/2 y mTLS viven en `@go-like/core/transport/http/node` y `@go-like/connectrpc/node`. Los ejemplos de Hono, Elysia, H3 y Fetch plano pasan un handler Fetch a un host de core. En este repositorio no hay un puente de NestJS ni de Fastify. La versión de manifiesto `0.0.1` no establece la publicación en npm.

## Por herramienta

**NestJS.** Modules, providers y controllers siguen siendo de Nest. Una integración es un `Server` propiedad de la aplicación, alrededor de la aplicación de Nest, con una admisión y un cierre explícitos. Este repositorio no incluye ese adaptador.

**Fastify.** Las rutas, la encapsulación y el listener siguen siendo de Fastify. go-like no convierte `request` / `reply` en un `Handler` de Fetch.

**Hono.** `examples/hono` pasa `app.fetch` a `newNodeServer` y pone ese host en `server(...)`. Las rutas se quedan en Hono.

**Elysia.** Hay que conservar el árbol de rutas y el comportamiento específico de Bun. El ejemplo usa el handler Fetch con el host de Node. `.listen()` no es una API de go-like.

**Koa.** Hay que conservar el middleware y el router externo. Se añade una frontera de ciclo de vida o de llamada solo donde se puede nombrar al propietario.

**tRPC.** Los procedimientos siguen siendo de tRPC. Un endpoint de go-like es un Struct sobre JSON Fetch, no un router de procedimientos.

**go-micro y go-kratos.** Son referencias para llamadas con Context primero, ciclo de vida y vocabulario de descubrimiento. Los watchers de go-like producen instantáneas de reemplazo completo. La entrada de gRPC administrado es `@go-like/connectrpc/node`.

## Qué elegir

Hay que usar el framework dueño del problema que de verdad se tiene. Se añade un socket de go-like cuando la pieza que falta es la admisión, la cancelación, el descubrimiento o un contrato de backend con un propietario nombrado. Instalar todos los plugs en una aplicación de framework ya terminada quita el beneficio de los contratos pequeños.

## Anclas de evidencia

Árbol actual:

- `packages/core/src/app/app.ts` y `packages/core/src/app/tiers.ts` para niveles, presupuestos y orden de parada;
- `packages/core/src/lifecycle/index.ts` para `Server` y `Endpointer`;
- `packages/core/src/web/context.ts` para `Handler` y `contextHandler`;
- `packages/core/src/client/index.ts` para opciones de llamada, descubrimiento y retry;
- `packages/core/src/server/index.ts` para el despacho interno;
- `packages/core/src/transport/service.ts` para `defineService`;
- `packages/core/src/registry/selector.ts` para filtros, selectores y feedback;
- `packages/connectrpc/src/node.ts` para gRPC administrado.

Entradas externas fijadas, no revalidadas por esta edición de la documentación:

- [commit de comparación de go-micro](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d);
- [commit de go-micro v6.9.0](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6);
- [commit de go-kratos v3](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e);
- [commit de go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336);
- [ciclo de vida de NestJS](https://docs.nestjs.com/fundamentals/lifecycle-events), [servidor de Fastify](https://fastify.dev/docs/latest/Reference/Server/), [Hono](https://hono.dev/docs/api/hono), [ciclo de vida de Elysia](https://elysiajs.com/essential/life-cycle), [Koa](https://koajs.com/), [routers de tRPC](https://trpc.io/docs/server/routers).

Versiones de TypeScript de terceros registradas para la comparación, no como promesas de compatibilidad: NestJS `@nestjs/core@11.1.28`, Fastify `5.11.2`, Hono `4.12.34`, Elysia `1.4.29`, Koa `3.2.1`, tRPC `@trpc/server@11.18.0`. El manifiesto del ejemplo de Elysia es el pin de ese ejemplo; esta tabla es la instantánea de la investigación.

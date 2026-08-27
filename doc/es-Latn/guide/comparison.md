# go-like frente a otras herramientas

Una comparación justa empieza por la propiedad, no por una lista de casillas de funcionalidades. NestJS, Fastify, Hono, Elysia, Koa y tRPC resuelven partes distintas del stack de aplicaciones TypeScript. go-micro y go-kratos son referencias de frameworks Go con decisiones diferentes sobre transporte y generación de código. go-like es un conjunto de piezas para TypeScript que hace explícitos el ciclo de vida, las llamadas internas unary, los contratos de providers y la composición entre runtimes.

Esta página separa los niveles de evidencia:

- **Source** significa que el checkout actual de go-like expone la API o frontera indicada.
- **Pinned external** significa que la comparación usa la release, commit o documentación oficial registrada en el research ledger. No es un benchmark nuevo ni una afirmación de que una rama `main` no fijada siga igual.
- **Declared** significa que existe un ejemplo o una lane de pruebas en el repositorio. No es un resultado aprobado.
- **Gap** significa que el repositorio actual no demuestra un compromiso de compatibilidad.

El baseline de source actual de go-like para esta guía es el commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. El registro de investigación local contiene una discrepancia de commit para go-micro: un registro de comparación menciona `9d306dcfc1a912a8a9493f31fee0bb983475258d`, mientras que el memo detallado de versión fija inspeccionó go-micro `v6.9.0` en `3c39d17fadaa9ec21b671be4afef3e63846406e6`. Trátalos como entradas de comparación que deben volver a comprobarse, no como una garantía actual de upstream.

## Lugar en el stack

| Herramienta | Problema principal                                     | Qué suele controlar                                                                                                                                                                      | Qué complementaría go-like, sin reemplazarlo                                                                                                     |
| ----------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| NestJS      | Framework de aplicaciones Node guiado por convenciones | Modules, providers, controllers, decorators, application context, ciclo de vida del framework, adaptador HTTP o de microservicios                                                        | Una frontera estructural de ciclo de vida o un contrato de llamada interna alrededor de una aplicación nativa, si se escribe un bridge explícito |
| Fastify     | Servidor HTTP Node y pipeline de requests              | Tabla de rutas, hooks, plugins, encapsulation, listener de Node, objetos request/reply                                                                                                   | Un adaptador de ciclo de vida o de provider alrededor de un recurso que pertenece a Fastify                                                      |
| Hono        | Routing y middleware basados en Web Standards          | Routes, middleware, sub-apps, `app.fetch`, elección del adaptador de runtime                                                                                                             | Core App, ciclo de vida explícito de recursos, Client/Transport internos, discovery                                                              |
| Elysia      | Framework Web tipado, centrado en Bun                  | Route tree, schema composition, decorators, hooks, adaptador Bun o Web Standard                                                                                                          | Piezas de ciclo de vida de Core y servicios internos, conservando el comportamiento nativo de Elysia                                             |
| Koa         | Kernel mínimo de middleware Node                       | Stack de middleware y listener Node; el router normalmente es externo                                                                                                                    | Ciclo de vida y contratos de servicios internos sin introducir otro router                                                                       |
| tRPC        | Capa de procedimientos con tipos seguros               | Rutas de router/procedure, parsers de entrada/salida, context factory, adaptadores HTTP/Fetch/WS                                                                                         | Propiedad de providers, policy de discovery y ciclo de vida explícito de App                                                                     |
| go-micro    | Ecosistema Go orientado a microservicios y agentes     | Go Context, abstracciones de service/client/transport/registry/broker, ecosistema de providers y alcance adicional de agent/flow/MCP/A2A                                                 | go-like toma parte del vocabulario, no el ABI de Go, las goroutines ni la compatibilidad de transportes                                          |
| go-kratos   | Framework Go para servicios cloud-native               | Ciclo de vida de App, Go Context, transportes HTTP/gRPC, middleware, registry, config, generación de código Protobuf                                                                     | go-like comparte el vocabulario de ciclo de vida explícito, pero elige APIs TypeScript/Web y no reclama gRPC/IDL                                 |
| go-like     | Piezas explícitas para servicios TypeScript            | Context, ciclo de vida App/Server, borde Fetch estándar, transporte interno unary con Message, Client/Server, Registry/Discovery/Selector, Config/Store/Cache/Broker/Health, adaptadores | La aplicación sigue siendo responsable de las rutas del framework, planos de datos nativos, policy de negocio, auth y despliegue                 |

Por eso el proyecto no intenta ganar una comparación de “framework más grande”. La pregunta es si una aplicación necesita que estas fronteras sean explícitas y componibles.

## Matriz de propiedad

| Preocupación                   | NestJS                                                    | Fastify                                         | Hono / Elysia / Koa                                             | tRPC                                               | go-like                                                                               |
| ------------------------------ | --------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Tabla de rutas externas        | Controllers y decorators                                  | Instancia de Fastify                            | Instancia del framework o router externo                        | Router de procedures, no rutas REST ordinarias     | Framework externo o la aplicación                                                     |
| ABI del handler Web            | Abstracción request/reply propiedad del adaptador         | request/reply de Node                           | Fetch estándar como centro en Hono y adaptadores Web Standard   | Adaptadores Fetch/Node/Express/Fastify             | `(Request) => Response \| Promise<Response>` estándar                                 |
| Ciclo de vida de la aplicación | Application context y hooks                               | `ready`, `listen`, `close`, hooks               | El adaptador de runtime y el ciclo de vida del framework varían | Responsabilidad del host/adaptador                 | `newApp`, `App.run`, `App.stop`, hooks, Servers estructurales                         |
| Ciclo de vida de recursos      | Hooks del container/framework                             | Hooks de plugin y server                        | Responsabilidad de la aplicación/runtime                        | Responsabilidad de la aplicación/adaptador         | Contratos explícitos `Server.start(ctx)` / `stop(ctx)` y ownership del adaptador      |
| Composición de dependencias    | Container/providers de Nest                               | Decoration y encapsulation de plugins           | Context/env y composición; no hay un container DI general       | Context factory explícito y composición del router | Constructores explícitos y functional options; no hay container DI                    |
| Transporte interno             | Transportes de microservicios y adaptadores del framework | No es una abstracción de discovery de servicios | No es una abstracción de discovery de servicios                 | Adaptadores de procedures y WebSocket opcional     | `Transport`, `Client`, `Listener`, `Socket`, `Message` unary                          |
| Discovery y selección          | Específicos del transporte o externos                     | Externos                                        | Externos                                                        | Externos                                           | `Registry`, `Discovery`, `Watcher`, Filters, cinco policies de Selector               |
| Retry                          | Específico del framework o provider                       | Específico de la aplicación/plugin              | Específico de la aplicación                                     | Específico de middleware/adaptador                 | Una sola tentativa por defecto; `withRetry` requiere autorización y total de intentos |
| Streaming                      | Opciones de framework/provider                            | Opciones de streams Node/Web                    | Web Streams nativas y APIs del framework                        | Depende del adaptador HTTP/WS                      | El streaming Web público es nativo; el RPC interno sigue siendo unary                 |
| Instrumentación global         | Integración de framework/provider                         | Ecosistema de plugins                           | Ecosistema de middleware                                        | Middleware/adaptadores                             | Wrappers explícitos; no instala providers globales                                    |

Las etiquetas de las primeras cinco filas describen posiciones arquitectónicas, no una clasificación de calidad. Que un framework sea dueño de una tabla de rutas es útil cuando ese es el problema de composición. Simplemente es una decisión de propiedad distinta de la que toma go-like al dejar las rutas en la aplicación.

## Ciclo de vida y Context

El source actual de go-like define:

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

El contrato `Server` es estructural. Un worker nativo, listener, scheduler, suscripción a un broker, destino de logs o proveedor de telemetría puede entrar en Core si un adaptador puede describir honestamente la admisión y el comportamiento terminal.

go-like Context también es estructural y usa `AbortSignal` internamente. Expone `deadline()`, `done()`, `err()` y `value(key)`, con constructores como `background`, `withCancel`, `withCancelCause`, `withTimeout`, `withDeadline`, `withoutCancel` y `withValue`.

Esto se parece al estilo explícito de Context primero de Go, pero no es compatible a nivel de ABI con `context.Context`. No ofrece goroutines, channels ni gRPC. La pregunta correcta para migrar es “¿dónde cruza la cancelación y la propiedad esta frontera?”, no “¿qué nombre de tipo es idéntico?”.

Core no promete un apagado en orden inverso para Servers hermanos. Invoca de forma concurrente las llamadas `stop(ctx)` de los hermanos, después espera las Promises terminales de `start` y agrega los fallos. Un application context de Nest, un grafo de plugins de Fastify, el ciclo de vida de Elysia o un adaptador de host pueden tener otro orden y otra semántica terminal. Compara el responsable real, no la etiqueta “graceful”.

## Transporte y llamadas de servicio

La cadena de llamadas internas de go-like está separada de forma deliberada:

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

Un `Endpoint` tipado vincula la validación de request y response de `Struct` con la frontera `Message` existente. No es un IDL ni un protocolo generado. `withAddress(...)` evita Discovery y Selector, por lo que la ruta en proceso con Memory Transport es una buena primera prueba.

Las opciones de transporte de microservicios de NestJS, los adaptadores de procedures de tRPC y los transportes de frameworks Go no son intercambiables con este DAG. Pueden tener otra identidad de ruta, modelo de serialización, pool de conexiones o capa de retry. Una comparación debe registrar esas diferencias en lugar de marcar como iguales todas las casillas de “RPC”.

## Alcance de retry y streaming

La comparación negativa más importante tiene que ver con las semánticas:

- Las llamadas de go-like hacen exactamente una tentativa por defecto.
- `withRetry(...)` requiere `authorization: "idempotent" | "caller-approved"`, un `maxAttempts` positivo y `shouldRetry`.
- La autorización es una declaración del caller, no una prueba de idempotencia.
- Un retry puede seleccionar otro endpoint porque cada tentativa vuelve a entrar en discovery y selección.
- Una response que ya se recibió pero después queda seguida por un fallo de feedback o cleanup no se repite.

La investigación de comparación con Go registra defaults y capacidades diferentes: `DefaultRetries` de go-micro no es una afirmación simple de “cinco requests en total”, porque el límite de su loop puede producir seis iteraciones cuando la autorización del retry sigue siendo verdadera; su forma pública de stream y la implementación default de `CloseSend` también varían según el provider. go-kratos combina generación de Protobuf/gRPC con formas de streaming HTTP, donde SSE y WebSocket tienen direcciones y comportamientos de cierre distintos. Esas son decisiones del provider y de la arquitectura, no flags de go-like que falten.

Para go-like:

```text
Web framework or Fetch Handler
  -> Web Streams, SSE, or WebSocket behavior owned by the application/framework

go-like internal Client/Transport
  -> one unary Message request and one unary Message response
  -> no full-duplex RPC Stream SPI
```

Un `ReadableStream` Web no es un canal RPC interno. No compares un body HTTP en streaming con un transporte de varios frames `send`/`recv` como si fueran la misma funcionalidad.

## Comparación de runtimes

| Pregunta de runtime                                                                    | Evidencia de go-like                                                                                                        | Consecuencia para la comparación                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ¿El código compartido puede usar Fetch y `AbortSignal`?                                | Web root y los providers seleccionados de transport/config usan Web APIs estándar o Fetch inyectado                         | Se pueden tener objetivos de portabilidad parecidos, pero los tipos no hacen polyfill del comportamiento del runtime |
| ¿El mismo paquete puede enlazar un listener de Node y uno de Deno?                     | Los subpaths específicos del runtime son explícitos; `@go-like/web/node` y `@go-like/transport-http/node` son rutas de Node | No escribas que “todos los paquetes corren sin cambios en cualquier parte”                                           |
| ¿Fetch puede transportar PEM TLS personalizado, mTLS, ALPN y HTTP/2 de forma portable? | El subpath de transporte de Node controla el comportamiento nativo; la ruta Fetch root no expone todos los controles        | Compara capacidades del host y rutas de import, no solo nombres de paquetes                                          |
| ¿La aplicación conserva el router del framework?                                       | Los ejemplos de Hono, Elysia y H3 pasan handlers Fetch nativos                                                              | go-like complementa la propiedad de rutas del framework                                                              |
| ¿La versión del paquete demuestra que está publicado?                                  | Root y packages son privados/workspace `0.0.1`; la documentación del repositorio dice que todavía no se han publicado       | No hagas afirmaciones de disponibilidad en npm o madurez del ecosistema                                              |

El repositorio actual contiene ejemplos directos para Hono, Elysia, H3 y Fetch sin framework. No contiene un bridge actual de NestJS o Fastify ni una suite de compatibilidad. Son audiencias de migración, no integraciones directas soportadas.

## Comparación detallada por herramienta

### NestJS

NestJS es un framework de aplicaciones guiado por convenciones. Sus modules, providers, controllers, decorators, interceptors, pipes y hooks de aplicación forman un container y un modelo de requests coherentes. go-like no proporciona un container de modules compatible con Nest ni un bridge de controllers.

Una frontera de integración sensata es un adaptador propiedad de la aplicación que implemente el `Server` estructural de go-like alrededor de una aplicación o host Nest. El adaptador tendría que definir cuándo Nest admitió el listener, cómo se traduce `stop(ctx)` al cierre de Nest y qué ocurre después de un timeout. El repositorio actual no demuestra ese bridge, así que la documentación no debe mostrar una llamada directa como `newNodeServer(nestApp, ...)`.

### Fastify

Fastify controla una tabla de rutas, encapsulation de plugins, hooks y un listener Node. Su grafo de plugins sirve para comparar el scope de dependencias, pero `decorate` no es un container general de providers al estilo Nest. go-like no convierte automáticamente el ABI `request`/`reply` de Fastify en un Fetch Handler, y el repositorio actual no prueba ningún bridge de Fastify.

Conserva nativos las rutas y plugins de Fastify. Si adoptas go-like, escribe un `Server` estructural explícito alrededor del responsable Fastify o expón una frontera Fetch implementada por separado. No llames al request injection ni al shutdown nativo de Fastify un contrato go-like de Transport o Client.

### Hono

Hono es el complemento demostrado con mayor claridad. El ejemplo actual crea las rutas en Hono, pasa `app.fetch` a `newNodeServer` y pone ese host dentro de una Core App. Hono conserva la propiedad de las rutas y del middleware; go-like controla la frontera de ciclo de vida del host cuando la aplicación lo elige.

### Elysia

Elysia ofrece un modelo de composición de rutas y schemas centrado en Bun, y también expone un handler Web Standard en la ruta de adaptador correspondiente. Conserva nativos el route tree, decorators, derives, hooks, streams y el comportamiento específico de Bun de Elysia. go-like puede controlar la App y una frontera explícita de recursos, pero no convierte `.listen()` en una API de go-like para todos los runtimes.

### Koa

Koa es un kernel pequeño de middleware para Node y no incluye un router. Es un buen ejemplo de framework que deja intencionalmente una mayor parte de la composición de la aplicación fuera del core. go-like no debería llenar ese espacio añadiendo un router. Conserva nativos el middleware de Koa y cualquier router externo, y añade una frontera de ciclo de vida o de llamada interna solo donde haga falta.

### tRPC

tRPC controla un router de procedures tipado y su middleware de procedures. Puede usar adaptadores Fetch, Node, Express, Fastify o WebSocket, pero no es un Registry, Selector, pool de conexiones ni gestor del ciclo de vida de la aplicación. El `Endpoint` tipado de go-like es un binding runtime más pequeño de `Struct` sobre `Message` unary, no un DSL de procedures ni un IDL generado que compita con tRPC.

### go-micro y go-kratos

Estos proyectos Go son referencias arquitectónicas útiles para llamadas Context-first, ciclo de vida de servicios, Registry, Discovery, Selector y vocabulario de transportes. No son objetivos de compatibilidad:

- Go `context.Context` y go-like `Context` comparten la intención de cancelación explícita, pero tienen representaciones runtime distintas.
- El modelo de watchers de Registry de go-micro y los snapshots de reemplazo completo de go-like no deben enseñarse como streams de eventos idénticos.
- Protobuf/gRPC y el código generado de go-kratos son una decisión arquitectónica que go-like explícitamente no reclama.
- Los defaults de providers de go-micro y go-kratos, los loops de retry, el half-close de streams y los defaults de selectors dependen de la versión. Usa la tabla de commits upstream fijados en el registro de investigación y vuelve a comprobarla antes de publicar una nueva comparación.

## Qué elegir

| Si tu problema principal es...                    | Empieza con...       | Añade go-like cuando...                                                                                                            |
| ------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Controllers, modules, decorators y DI             | NestJS               | Necesitas una frontera explícita alrededor de un recurso existente o una llamada interna y estás dispuesto a escribir el adaptador |
| Rutas HTTP Node, hooks y encapsulation de plugins | Fastify              | Necesitas composición de ciclo de vida más allá del host o contratos internos de servicios unary                                   |
| Rutas Web Standards entre runtimes                | Hono                 | Necesitas ciclo de vida de App/Server, llamadas internas o propiedad de providers                                                  |
| Composición de schemas y rutas centrada en Bun    | Elysia               | Necesitas fronteras explícitas de ciclo de vida y transporte, conservando Elysia                                                   |
| Middleware Node mínimo                            | Koa más un router    | Necesitas el contrato de ciclo de vida o de llamadas internas que falta, no otro router                                            |
| Procedures con tipos seguros                      | tRPC                 | También necesitas discovery explícito de servicios, propiedad de providers o un ciclo de vida de Core                              |
| Stack de microservicios Go                        | go-micro o go-kratos | Estás construyendo una composición TypeScript separada, no un port compatible a nivel de source                                    |
| Piezas TypeScript para servicios entre runtimes   | go-like              | Usa solo los paquetes y providers que resuelven la frontera que necesitas                                                          |

La respuesta correcta puede ser usar ambos sistemas. go-like es más útil cuando su modelo de propiedad explícita elimina una ambigüedad real; añadir todos los paquetes a una aplicación que ya funciona con otro framework contradice el objetivo de piezas pequeñas.

## Anclas de evidencia

Las afirmaciones de go-like en esta página se pueden rastrear al árbol actual y a los entrypoints de los paquetes:

- `README.md` para el alcance del producto y sus exclusiones explícitas;
- `packages/core/src/app.ts` para `App`, `Server`, el arranque, stop y el comportamiento de timeout;
- `packages/web/src/context.ts` para el Handler estándar y el bridge de Context;
- `packages/client/src/index.ts` para las opciones de Client, pooling, retry y el pipeline de intentos;
- `packages/server/src/index.ts` para handlers internos unary y dispatch de rutas;
- `packages/transport/src/types.ts` y `packages/transport/src/endpoint.ts` para las fronteras de Message y Endpoint tipado;
- `packages/registry/src/types.ts` y `packages/registry/src/selector.ts` para snapshots, filters, selectors y feedback.

El registro de investigación también guarda estas entradas de comparación externas fijadas:

- [commit de comparación de go-micro registrado en el repositorio](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d);
- [commit de comparación de go-kratos v3](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e);
- [commit de comparación de go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336);
- [documentación del ciclo de vida de NestJS](https://docs.nestjs.com/fundamentals/lifecycle-events), [referencia del servidor Fastify](https://fastify.dev/docs/latest/Reference/Server/), [API de Hono](https://hono.dev/docs/api/hono), [ciclo de vida de Elysia](https://elysiajs.com/essential/life-cycle), [Koa](https://koajs.com/) y [routers de tRPC](https://trpc.io/docs/server/routers).

Las URLs son referencias de comparación, no una afirmación de que esta fase de documentación haya descargado o revalidado cada página upstream. Vuelve a comprobar releases tags o commits antes de cambiar una afirmación sensible a la versión.

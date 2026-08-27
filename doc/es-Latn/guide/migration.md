# Migración y adopción

La regla más segura para migrar es: **conserva el plano de datos y adopta la frontera que puedas explicar**.

Conserva el framework Web, worker, scheduler, broker, logger o proveedor de telemetría que ya tienes. Añade un contrato explícito de go-like alrededor de un problema real de ciclo de vida o de llamadas entre servicios. Verifica esa frontera antes de sumar otro provider.

## Una migración por etapas

1. Deja intactos el arranque existente y el código de rutas/plano de datos.
2. Identifica un responsable: listener, worker, scheduler, suscripción a un broker, destino de logs o proveedor de telemetría.
3. Añade un adaptador estructural `Server` o usa un adaptador existente de go-like. Define admisión, parada, timeout y observación terminal.
4. Añade `@go-like/context` en las fronteras reales de cancelación o deadline. Pásalo como primer argumento de la operación.
5. Añade liveness y readiness con `@go-like/health` y `@go-like/web/health`.
6. Añade una llamada interna unary tipada usando `@go-like/transport-memory` en las pruebas.
7. Mueve esa llamada a `@go-like/transport-http` o `@go-like/transport-http/node` solo cuando necesites un wire real o un host nativo de Node.
8. Añade Registry, Config, Store, Cache, Broker, logs, métricas o trazas, una capacidad a la vez.
9. Registra el provider, runtime, responsable y nivel de evidencia de cada frontera nueva.

No empieces reescribiendo todo el servicio. La idea de los contratos pequeños es que la unidad de migración pueda seguir siendo pequeña.

## Matriz de migración de frameworks

| Sistema existente | Conserva lo nativo                                                        | Adopta primero                                                                                                       | Frontera actual                                                                                                               |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| NestJS            | Modules, controllers, decorators, DI, interceptors, pipes, adapter        | Un `Server` estructural propio alrededor de la aplicación existente o una frontera interna separada de Client/Server | En este repositorio no existe un bridge de NestJS para go-like ni integración automática con DI                               |
| Fastify           | Routes, plugins, hooks, request/reply, native listener                    | Un wrapper de ciclo de vida propio o un bridge Fetch implementado de forma explícita                                 | No se ha demostrado una conversión actual de Fastify request/reply a go-like Handler                                          |
| Hono              | Routes, middleware, sub-apps, `app.fetch`                                 | `newNodeServer(app.fetch, ...)`, seguido de `newApp(...)`                                                            | La integración nativa con Fetch está demostrada en `examples/hono`                                                            |
| Elysia            | Route tree, schema, decorators, derives, hooks, Bun/Web Standard behavior | `app.fetch` nativo más el host/ciclo de vida de Core cuando corresponda                                              | Conserva la semántica Bun específica de `.listen()`; no lo llames una API de go-like para todos los runtimes                  |
| H3                | H3 router and native handler conversion                                   | La ruta de handler Fetch del ejemplo actual de H3                                                                    | `app.fetch` de H3 2.x es la forma demostrada actualmente; la guía antigua de `toWebHandler` necesita su propio ejemplo fijado |
| Koa               | Middleware and external router                                            | Un wrapper del responsable o una llamada interna al servicio                                                         | `@go-like/web` no acepta el objeto Node request/reply de Koa sin un bridge de aplicación                                      |
| tRPC              | Router, procedure middleware, input/output parsers, adapter               | El ciclo de vida de Core alrededor del host o una frontera de transporte interna separada                            | go-like Endpoint no es un router de procedimientos de tRPC                                                                    |

### Ejemplo con Hono

Esta es la forma de integración demostrada:

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/web/node"

const web = new Hono().get("/users/:id", (c) => c.json({ id: c.req.param("id") }))

const app = newApp(name("users"), server(newNodeServer(web.fetch, port(3000))), signal())

await app.run()
```

El ejemplo actual con Hono conserva el control de Hono sobre las rutas y pasa el handler Fetch nativo al host de Node. No añade una tabla de rutas de go-like ni un paquete bridge específico de Hono.

### Elysia y H3

Aplica la misma frontera a un framework que expone un handler Fetch estándar:

```text
framework route table
  -> framework native Fetch handler
  -> @go-like/web/node (when using the Node host)
  -> @go-like/core App
```

Revisa el adaptador de runtime del framework antes de importar un subpath de Node. El adaptador Bun de Elysia y su adaptador Web Standard no tienen un comportamiento de escucha idéntico. Las versiones de H3 y sus APIs para convertir handlers también necesitan un ejemplo fijado. No uses la existencia de un solo ejemplo para prometer cualquier combinación de versión de framework y runtime.

## Migrar un servicio de Go

Para quien viene de Go o Kratos, migra conceptos, no nombres:

| Concepto de Go    | Concepto de go-like                                                                                                | Diferencia importante                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `context.Context` | `@go-like/context` `Context`                                                                                       | `done()` es un `AbortSignal` o `null`, no un canal de Go                         |
| Server lifecycle  | `Server` estructural de Core                                                                                       | `start(ctx)` puede durar toda la vida del servicio y no significa readiness      |
| App runner        | `newApp`, `App.run`, `App.stop`                                                                                    | `App.stop()` no recibe Context del caller y devuelve una sola Promise compartida |
| RPC client        | `@go-like/client`                                                                                                  | Las llamadas internas son `Message` unary; el retry es opt-in                    |
| Transport         | `@go-like/transport`                                                                                               | Los providers y los headers de `Message` son contratos de TypeScript/Web         |
| Registry          | `@go-like/registry`                                                                                                | Los watchers devuelven snapshots de reemplazo completo                           |
| Selector          | `newRoundRobinSelector`, `newRandomSelector`, `newWeightedRoundRobinSelector`, `newP2CSelector`, `newEWMASelector` | El feedback es síncrono y depende de la policy                                   |
| Protobuf/IDL      | no hay equivalente en go-like                                                                                      | `Endpoint` + `Struct` es validación en runtime, no código de esquema generado    |
| gRPC stream       | no existe un equivalente actual en go-like                                                                         | El streaming Web público está separado del transporte interno unary              |

Un primer paso incremental es hacer una llamada tipada a una dirección directa sobre Memory Transport:

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

Solo después de probar esta frontera conviene introducir Discovery, un provider real de Registry o un transporte HTTP. Así conservas el contrato de dominio mientras sustituyes el destino y la configuración de ownership.

## Adoptar Kubernetes

Conserva Kubernetes como está:

- Deployments, Services, DNS, Ingress, RBAC, probes, estrategia de rollout, HPA y network policy siguen siendo responsabilidades de la plataforma;
- `@go-like/config-kubernetes` lee una clave de un solo ConfigMap o Secret dentro de un namespace mediante una capacidad Fetch inyectada;
- `@go-like/registry-kubernetes` usa registros de EndpointSlice cuando el discovery directo es realmente necesario;
- un EndpointSlice no es el DNS de un Kubernetes Service ni ofrece un TTL universal de registro;
- las referencias opcionales al owner del Pod y el deregistration explícito tienen semánticas de fallo distintas.

Empieza por health y configuración antes de seleccionar directamente desde EndpointSlice. Si la aplicación ya tiene un nombre DNS estable de Service, `withAddress(...)` más un transporte HTTP puede ser más sencillo y más honesto que añadir un provider de Registry.

## Adoptar brokers y jobs

Conserva nativos el settlement y la policy de jobs:

| Plano de datos existente | Conserva                                                         | Añade go-like para                                                                                  |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| NATS Core                | Connection, subscription, queue group, `Msg`, drain              | `newNatsCoreServer`, `newNatsCoreBroker`, ciclo de vida y frontera de bytes                         |
| NATS JetStream           | Stream, durable consumer, `JsMsg`, ack/nak/term, redelivery, DLQ | `newNatsJetStreamServer`, `newNatsJetStreamBroker`, ciclo de vida                                   |
| RabbitMQ                 | Connection, topology, confirm policy, channel                    | Ciclo de vida del subscriber borrowed o recovering y settlement nativo seguro frente a generaciones |
| BullMQ                   | Queue, Worker, processor, retry/backoff, Redis                   | `newBullMqWorkerServer` alrededor de un Worker oficial en pausa                                     |
| Croner                   | Cron expression, time zone, callback, overlap policy             | `newCronerServer` alrededor de jobs Cron nativos pausados                                           |
| Memory Broker            | Mapa de topics en proceso y semántica de pruebas                 | `newBrokerServer` y un codec de eventos opcional                                                    |

No migres ack/nak/term de NATS, el settlement durable de JetStream, las confirmaciones de RabbitMQ ni los retries de BullMQ a una abstracción genérica de go-like Broker. Esas semánticas son precisamente la razón por la que el objeto nativo del provider sigue visible.

## Migrar el estado

Elige un dominio de estado a la vez:

- Config para snapshots inmutables de configuración del proceso y reload;
- Registry para reachability efímera de servicios;
- Store para registros autoritativos, revisiones, CAS, TTL y páginas;
- Cache para valores desechables que se pueden recalcular.

Una prueba útil de migración es anotar qué sucede después de un reinicio del proceso, una lectura stale, una caída del provider, una compactación del watcher, un conflicto de CAS y un cache miss. Si la respuesta cambia, no deberían compartir una interfaz de repository genérica.

## Añadir observabilidad

Añade primero el provider nativo y después envuelve la frontera:

```text
application creates logger / Registry / MeterProvider / TracerProvider
  -> go-like wrapper records bounded operation facts
  -> application-owned exporter or destination
  -> explicit Core lifecycle adapter closes the admitted resource
```

`@go-like/prometheus` no usa el registro global. `@go-like/otel` no instala providers ni exporters globales. Los adaptadores de Pino y Winston no reemplazan la configuración nativa del logger. Mantén acotados los labels y attributes, y redacta por separado los logs que son responsabilidad de la aplicación.

## Checklist de aceptación de la migración

Antes de integrar una frontera, verifica:

- existe un responsable claramente nombrado;
- el responsable recibe el Context correcto y no lo reemplaza por `background()`;
- la admisión durante el arranque y readiness son cosas distintas;
- el comportamiento del timeout de stop está documentado como una frontera de espera;
- se conserva la observación terminal nativa cuando existe;
- no se mezclan handlers Web externos con handlers internos unary;
- la autorización del retry corresponde a la operación de negocio;
- credenciales, metadata, logs y atributos de trace tienen una policy de redacción;
- las semánticas específicas del provider siguen visibles;
- pasó el comando de unit/typecheck enfocado en el checkout objetivo;
- el comando E2E relevante de runtime, provider, published o example se ejecutó y quedó registrado, o se marcó explícitamente como no ejecutado.

## Frontera de soporte actual

El repositorio contiene ejemplos directos para Fetch sin framework, Hono, Elysia, H3, Memory Transport, llamadas internas tipadas, health, brokers, workers y adaptadores de observabilidad. No demuestra bridges automáticos para NestJS o Fastify, compatibilidad con gRPC/Protobuf/IDL, streams internos full-duplex, autenticación universal ni orquestación de despliegues. Todo eso requeriría adaptadores, pruebas y compromisos de producto separados.

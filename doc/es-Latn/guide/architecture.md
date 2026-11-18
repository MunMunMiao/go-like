# Arquitectura

go-like es una capa de composición. `@go-like/core` declara sockets e implementa los mecanismos que no necesitan un cliente de terceros. Un plug rellena un socket. La aplicación construye el objeto nativo, construye el plug y elige qué nivel de la App lo posee.

La pregunta útil es: quién admite este objeto, en qué nivel queda, quién observa su resultado terminal y qué runtime o backend da significado a ese resultado.

## Sockets y plugs

```text
Application composition root
  |
  +--> Context, metadata, struct, health, resilience     core mechanisms
  |
  +--> Lifecycle
  |      telemetry(tel) -> resources(...) -> server(...) -> registrar
  |
  +--> External Web
  |      Handler on @go-like/core/web
  |      host on @go-like/core/web/node or @go-like/core/web/bun
  |
  +--> Internal calls
  |      Client, Server, Transport
  |      memory and Fetch transports in core; gRPC on @go-like/connectrpc
  |
  +--> State
  |      Config, Registry, Store, Cache sockets
  |      memory references in core; Consul, etcd, Vault, Kubernetes,
  |      ZooKeeper, mDNS, YAML, Redis, and file plugs
  |
  +--> Messages and jobs
  |      Broker and Job sockets
  |      memory broker in core; NATS, RabbitMQ, BullMQ, and Croner plugs
  |
  +--> Telemetry sockets
         LogHandler, TracerProvider, MeterProvider, Propagator
         filled by @go-like/otel, @go-like/pino/log, @go-like/winston/log,
         @go-like/prometheus/metric
```

Core registra cada unidad de trabajo en un punto de llamada fijo. Un plug no envuelve `newClient` ni un handler Web para añadir un span. La dirección de los imports dentro de core la impone `test/portable-lane.test.ts`: las capas inferiores no importan la entrada raíz.

## Tres niveles

`newApp(...options)` aplica las opciones en el orden de los argumentos. El mismo objeto no puede aparecer a la vez en `resources(...)` y en `server(...)`. Pasar un bundle `Telemetry` a cualquiera de las dos listas es un error de tipos y un `TypeError` en runtime.

| Nivel      | Opción                                        | Arranque                                                                                                                                                                          | Parada                                                                                                                                                        |
| ---------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telemetría | `telemetry(tel)` sustituye el bundle anterior | Primero. Handlers de log, después el tracer y después los meters. Cada `lifecycle.start` se comprueba por un fallo inmediato. Un fallo revierte los que ya arrancaron.            | Al final, después de `afterStop`, en su propio presupuesto `stopTimeout`. Tracer y meters drenan juntos y después los handlers de log.                        |
| Recursos   | `resources(...)` sustituye la lista anterior  | Después de `beforeStart`, antes de cualquier servidor. Orden de declaración. Cada `start(ctx)` se espera y debe resolverse cuando el recurso se puede usar.                       | Después de que cada servidor lanzado se ha detenido, en orden inverso de declaración. Un fallo de parada se registra y el recurso siguiente igual se detiene. |
| Servidores | `server(...)` sustituye la lista anterior     | Se emiten todas las llamadas `start` y después hay una comprobación de fallo inmediato. `start` puede seguir pendiente hasta que el objeto nativo termina. `Endpointer` opcional. | `stop` concurrente y después se une cada promesa de `start`.                                                                                                  |

Hooks: `beforeStart` corre antes del nivel de recursos. `afterStart` corre después del registro. `beforeStop` corre antes de la baja del registro. `afterStop` corre después del nivel de recursos y antes del drain de telemetría. Los hooks de arranque fallan de inmediato. Los hooks de parada corren como limpieza.

El registro usa solo el nivel de servidores. Un recurso es una dependencia, no una dirección que anunciar.

```text
run()
  1  install signal() or another runtime option
  2  phase = starting
  3  admit telemetry
  4  open the start budget, if startTimeout is set
  5  beforeStart
  6  admit each resource and wait
  7  launch every server, then check for an immediate failure
  8  prepare endpoints and register, server tier only
  9  afterStart
 10  phase = ready; go_like.app.ready flips with the ready probe
 11  wait for stop or the first participant failure

stop()
  1  phase = stopping; the ready probe fails from this moment
  2  open the shared stop budget, if stopTimeout is set
  3  cancel the application Context
  4  join startup inside that budget
  5  beforeStop
  6  deregister
  7  cancel the server Context and stop launched servers concurrently
  8  join server start promises
  9  cancel the resource Context and stop owned resources in reverse order
 10  join resource start promises inside the same budget
 11  afterStop
 12  cancel the telemetry Context and stop the bundle on a fresh budget of the same length
```

`run()` es de una sola vez. `stop()` es idempotente y comparte una promesa. `App.stop()` no recibe Context. Gana el primer motivo de parada: `requested` para `App.stop()` y `signal()`, `context_canceled` cuando termina el Context padre, `start_failed` cuando falla el arranque, `server_failed` cuando un participante admitido falla después de ready. Un fallo se lanza tal cual. Varios fallos se convierten en un `AggregateError` en orden de fase, con la telemetría al final.

Los servidores hermanos no tienen garantía de orden inverso. Si un worker debe parar antes que su cola, la cola va en `resources(...)` y el worker en `server(...)`. El nivel de recursos existe para que esa combinación espere la admisión. Un `Server` escrito a mano cuyo `start` nunca se resuelve atasca la admisión de recursos; para un objeto nativo hay que usar `newResourceServer`, o poner un participante de larga duración en `server(...)`.

## Ámbitos de Context

```text
parent
  -> appContext          canceled at the start of stop
       -> telemetryContext    canceled just before Telemetry.stop
       -> resourceContext     canceled just before the resource tier stops
       -> serverContext       canceled just before Server.stop
       -> startContext        appContext, plus startTimeout when configured
       -> stopContext         withoutCancel(appContext), plus the shared stopTimeout
       -> telemetryStop       a second stopTimeout, opened when the drain begins
```

Un `start(ctx)` de larga duración recibe el Context de su propio nivel. Ese Context sigue vivo hasta que se pide parar ese nivel, así que un recurso no ve la cancelación mientras los servidores todavía drenan. La telemetría usa su propio Context por la misma razón: cancelar `appContext` al principio de la parada no debe drenar la telemetría antes que los servidores que observa.

## Presupuestos y propiedad

`startTimeout` cubre los hooks, la admisión de recursos, la preparación de endpoints, el registro y `afterStart`. No cubre la admisión de telemetría, y no convierte el `start` de un servidor en una promesa de readiness. El valor por defecto `0` significa que no hay límite. `registrarTimeout` vale 10 segundos por defecto y acota las llamadas de registro y de baja.

`stopTimeout` es el presupuesto de espera del llamador que comparten los hooks, la baja del registro, el nivel de servidores y el nivel de recursos. El drain de telemetría abre un segundo presupuesto de la misma duración cuando empieza esa fase, así que un export todavía puede terminar después de que se agote el presupuesto compartido. Un drain que nunca se resuelve hace que `App.run()` espere aproximadamente el doble de `stopTimeout`. El valor por defecto `0` significa que no hay límite para ninguno de los dos. Cuando el presupuesto compartido ya se ha agotado, las llamadas `stop` posteriores se emiten igual. Core no sigue esperando, y un timeout no es un estado terminal nativo. Los timeouts que posee el plug se quedan en el plug: el apagado por defecto de OpenTelemetry es de 25 segundos, el drain por defecto de Pino es de 25 segundos y el handler de Winston no tiene un timeout de drain propio.

Después de que `start` se resuelve, la App posee el participante. `newResourceServer({ open, terminal, close })` resuelve `start` cuando `open` termina, o de inmediato cuando se omite `open`. `close` es el único drain del propietario y se llama con `withoutCancel` del primer Context de parada. Si `open` falla, no se llama a `close`. Un segundo `start` se rechaza con `GO_LIKE_RESOURCE_ALREADY_STARTED`. Un cierre limpio de `terminal` antes de la parada hace fallar la App con `GO_LIKE_RESOURCE_CLOSED`. Una resolución con `Error` o un rechazo hace fallar la App con ese error. La promesa terminal se observa en privado; no es un campo público del socket.

## Readiness

`readyProbe(registry, name?)` registra una sonda síncrona, con el nombre por defecto `"app"`. Pasa solo mientras `run()` está en la fase ready, y cambia en el mismo momento que el gauge `go_like.app.ready`. Fuera de esa ventana lanza `AppNotReadyError` (`GO_LIKE_APP_NOT_READY`) con `phase` `created`, `starting`, `stopping` o `stopped`. Después de que `run()` se resuelve, la sonda se retira. Una App que nunca corrió permanece en `created`.

`createHealthHandler(probes)` expone `/livez` y `/readyz`. El liveness vacío pasa. El readiness vacío falla cerrado, así que un handler sin `readyProbe` ni otra sonda de ready devuelve 503 para `/readyz`. Toda sonda de ready registrada debe pasar. Core no registra una sonda de liveness.

Un listener interno de `newServer` sigue respondiendo `GET` y `HEAD` `/healthz` con un 200 vacío. Esa respuesta significa que el listener unary aceptó la petición. No es el registro de sondas.

## Listeners y puertos publicados

Los ejemplos que enlazan `127.0.0.1` y después llaman a esa dirección son la forma local correcta. Un puerto publicado de Docker puede aceptar TCP a través del proxy antes de que el contenedor sirva el protocolo. Hay que alcanzar Redis, AMQP, etcd y el HTTP de la aplicación en la red de Compose por el DNS del servicio cuando esa es la topología que se arrancó.

`Server.start(ctx)` en el nivel de servidores no significa ready. `Endpointer.endpoint(ctx)` devuelve una dirección que se puede anunciar. `afterStart` significa que Core llegó a ese hook.

`startRecoveringRabbitMqBroker` puede admitir un handle de broker antes de que termine la configuración del conector, así que HTTP puede enlazar sin esperar a AMQP. La publicación permanece cerrada hasta que existe una generación. Eso es la admisión del handle, no una ruta de salud.

## Camino de la petición

```text
External Web
  Request -> framework or Handler -> Response -> host writes the body

Internal unary
  Context + operation
    -> Client middleware
    -> direct address or Discovery snapshot
    -> Filters, then Selector
    -> Transport
    -> POST /<service>/<endpoint>
    -> Server middleware, Struct decode, handler, Struct encode
```

La identidad de la operación es `service/endpoint`, por ejemplo `appointment-policy.v1/check`. Un endpoint de `ServiceInstance` es una dirección de transporte opaca, por ejemplo `memory://orders` o `https://orders.example`.

## Portabilidad de runtime

Las entradas portables usan JavaScript estándar y las Web APIs, o capacidades que inyecta quien llama. Una entrada portable no promete un listener TCP, señales de proceso, watches de archivos, multicast UDP ni un cliente de un proveedor.

| Entrada                                                                                           | Dónde corre                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Entradas de concepto de `@go-like/core`, incluidas `/web`, `/transport/http`, `/transport/memory` | Portable. `/transport/http` abre la conexión con Fetch. Escuchar necesita un host inyectado.                 |
| `@go-like/core/node`, `/transport/http/node`, `/web/node`, `/config/node`                         | APIs de Node. `/web/node` también puede correr donde esas APIs existan.                                      |
| `@go-like/core/web/bun`                                                                           | Host de Bun.                                                                                                 |
| `@go-like/mdns/registry/node`, `@go-like/zookeeper/registry/node`, `@go-like/file/store/node`     | Host de Node para ese plug. La entrada hermana sigue siendo portable sobre un host o una factory inyectados. |
| `@go-like/connectrpc`                                                                             | Handler Fetch portable.                                                                                      |
| `@go-like/connectrpc/node`                                                                        | Servidor y cliente gRPC de Node.                                                                             |
| NATS, RabbitMQ, Redis, BullMQ                                                                     | Node y Bun, según el cliente nativo.                                                                         |

Los exports de los paquetes no usan condiciones `bun` ni `node`. Hay que importar el subpath que se quiere. La biblioteca TypeScript `DOM` aporta tipos. No es un polyfill de runtime.

## Composición

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { newNodeServer, port } from "@go-like/core/web/node"

const policy = defineService("policy", {
  check: {
    request: struct.object({ ok: struct.boolean() }),
    response: struct.object({ ok: struct.boolean() })
  }
})

const transport = newMemoryTransport()
const policyServer = newServer(serverTransport(transport), address("memory://policy"))
policy.registerHandler(policyServer, {
  check() {
    return { ok: true }
  }
})
const policyClient = newClient(withTransport(transport), withEndpoint("memory://policy"))
const webServer = newNodeServer((_request: Request) => new Response("ok"), port(3000))

const app = newApp(
  name("appointments"),
  server(policyServer, webServer),
  afterStop(async (ctx) => {
    await policyClient.close(ctx)
  }),
  signal()
)
void app
```

`newApp` no se convierte en un contenedor, y un transporte en memoria no se convierte en una red. Credenciales, factories y el apagado de objetos que no se entregaron a la App se quedan en la raíz de composición.

Las notas de diseño anteriores usan nombres como `ServerHandle` y `AppHandle`. Las firmas de esta página son las que se exportan hoy. `Server` y `Endpointer` se exportan desde `@go-like/core/lifecycle`, no desde la entrada raíz.

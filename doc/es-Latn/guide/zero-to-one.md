# Sistema de citas de una clínica: de 0 a 1

Este recorrido sigue una invariante de negocio a través de una llamada interna de policy, un handler Fetch, la salud y una App. El árbol ejecutable es `examples/healthcare-appointments`. Los fragmentos de abajo usan los nombres de ese ejemplo. Una caché desechable de disponibilidad es un hito extra que se añade en la misma raíz de composición. No es una segunda fuente de verdad.

## La invariante

1. Un doctor no puede tener citas activas que se superpongan.
2. La cancelación libera el horario.
3. Repetir el mismo id de cita con el mismo contenido es idempotente.
4. Reutilizar un id de cita con contenido distinto se rechaza.
5. Una proyección de disponibilidad en caché, si se añade, nunca autoriza una reserva por sí sola.

El ejemplo implementa las cuatro primeras reglas con un repository en memoria y comprueba una duración máxima mediante `appointment-policy.v1/check`. No afirma tener base de datos, lock distribuido, autenticación ni un workflow de clínica para producción.

## Disposición

```text
examples/healthcare-appointments/
  src/contract.ts    defineService and Structs
  src/service.ts     repository and booking rules
  src/transport.ts   memory Server and Client
  src/http.ts        Fetch handler
  src/main.ts        Node host and App
  test/main.test.ts
```

Desde la raíz del repositorio:

```sh
bun install --frozen-lockfile
bun run --cwd examples/healthcare-appointments test:unit
```

La versión de paquete `0.0.1` no establece disponibilidad en npm. Dentro de este checkout, la única dependencia de go-like que el ejemplo necesita es `@go-like/core`.

## M0: reglas de dominio

`src/service.ts` posee `BookAppointmentCommand`, el repository y la comprobación de solapamiento. Context es el primer argumento aunque el repository en memoria no bloquee. Un store o una caché posteriores pueden usar la misma firma.

El ejemplo rechaza un id incorrecto, una ventana no positiva, un solapamiento y un id reutilizado con contenido distinto. Las pruebas de esos casos van junto al repository, sin App y sin HTTP.

## M1: el servicio de policy

`src/contract.ts` enlaza la operación:

```ts
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"

const command = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: command,
    response: struct.object({ allowed: struct.literal(true) })
  }
})
```

`src/transport.ts` pone los dos extremos en un transporte en memoria. La dirección `memory://appointment-policy.v1` no es el nombre de la operación.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { appointmentPolicy } from "./contract"

const transport = newMemoryTransport()
const server = newServer(serverTransport(transport), address("memory://appointment-policy.v1"))
appointmentPolicy.registerHandler(server, {
  check(_ctx, command) {
    if (command.endsAt - command.startsAt > 7_200_000) {
      throw serviceError("appointment_policy_rejected", "appointment duration exceeds policy", 409)
    }
    return { allowed: true as const }
  }
})
const caller = appointmentPolicy.newClient(
  newClient(withTransport(transport), withEndpoint("memory://appointment-policy.v1"))
)
```

`src/http.ts` es un `contextHandler`. Reenvía el Context de la petición a la reserva y a la cancelación. HTTP 400 es un body mal formado. HTTP 409 es una reserva rechazada. Esos estados son la elección del handler Web. El fallo de policy es un `ServiceError` con estado 409 en la llamada interna.

## M2: caché de disponibilidad

Una caché en memoria es opcional y local al proceso. Las claves y los valores son bytes. El repository sigue siendo autoritativo: un acierto se salta una lectura, un fallo o una expiración vuelven a leer, y una reserva o una cancelación borran la clave. Un error de caché no debe convertirse en una reserva correcta.

```ts
import { expiresIn } from "@go-like/core/cache"
import { newMemoryCache } from "@go-like/core/cache/memory"

const cache = newMemoryCache()
await cache.put(ctx, key, bytes, expiresIn(5_000))
const hit = await cache.get(ctx, key)
```

`newMemoryCache` no es un `Server`. `@go-like/redis/cache` sí es un `Server`; ese va en `resources(...)`.

## M3: liveness y readiness

Hay que crear un registro, apuntar la App hacia él y despachar `/livez` y `/readyz` en el propio código. Sin `readyProbe`, `/readyz` permanece en 503.

```ts
import { newApp, readyProbe, server } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler, type Handler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policyServer.endpoint(ctx)
})
const health = createHealthHandler(probes)

const handler: Handler = async (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return appointmentHandler(request)
}

const app = newApp(readyProbe(probes), server(policyServer, web))
void handler
void app
```

## M4: un propietario del ciclo de vida

`src/main.ts` del ejemplo es la raíz de composición: repository, servicio de policy, handler, `newNodeServer`, `signal()` y `afterStart`, que espera `endpoint(ctx)` antes de escribir `GO_LIKE_EXAMPLE_READY`. Hay que añadir `readyProbe` cuando se expone `/readyz`. Hay que cerrar el cliente de policy en `afterStop` si sobrevive al servidor en memoria.

```ts
import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"

const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
  })
)
await app.run()
```

`server(...)` lanza los dos participantes juntos. El servidor de policy está en proceso, así que no necesita el nivel de recursos. Una caché de Redis o un store de archivos sí.

## M5: lo que establecen las pruebas

`test/main.test.ts` ejercita las reglas en memoria y la llamada interna. Una prueba unitaria que pasa no establece Docker, un tarball publicado ni un sistema de reservas de producción. Hay que registrar el comando si se afirma un resultado. Véase [Verificación](/es-Latn/reference/verification).

## Diagnóstico

| Síntoma                           | Comprobación                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `Cannot find package`             | Ejecutar `bun install --frozen-lockfile`. Los imports son `@go-like/core/...`. |
| HTTP 404                          | El handler no conoce esa ruta. Las rutas de salud no se montan solas.          |
| HTTP 400                          | El body JSON no pasó la comprobación propia del handler.                       |
| HTTP 409                          | El repository o la policy rechazaron el comando.                               |
| La llamada tipada no valida       | La petición o la respuesta no coinciden con el Struct.                         |
| El cliente no alcanza al servidor | Cliente y servidor deben compartir una instancia de `newMemoryTransport()`.    |
| `app.run()` no vuelve             | Espera hasta la parada. `signal()` o `app.stop()` la terminan.                 |
| `EADDRINUSE`                      | El puerto está ocupado.                                                        |
| El valor de la caché desapareció  | La caché en memoria es local al proceso. El TTL y `delete` también lo quitan.  |
| `/readyz` es 503                  | Hay que registrar una sonda de ready, incluido `readyProbe(probes)`.           |

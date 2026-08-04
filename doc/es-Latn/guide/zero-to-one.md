# Sistema de citas de una clínica: de 0 a 1

Esta es una ruta guiada de 0 a 1 para aprender go-like a partir de una invariante de negocio concreta, no de un Todo genérico. Describe un objetivo y checkpoints ejecutables; no afirma que el árbol objetivo ya exista como una aplicación completa para copiar y ejecutar. El proyecto es un servicio de citas para una clínica con un servicio de policy en proceso, un repository canónico de citas, un Cache desechable de disponibilidad, endpoints de health y un ciclo de vida de aplicación explícito.

El repositorio ya contiene `examples/healthcare-appointments`, que es la implementación inicial de esta guía. Su código actual usa manejo de `Message` JSON sin tipos para el servicio de policy. La versión con `Endpoint` y `Struct` tipados que aparece abajo es una ruta de mejora documentada basada en exports públicos actuales; no se añadió al ejemplo durante esta fase de documentación. Conserva esa diferencia al reportar la verificación.

## La invariante

El servicio debe conservar cinco reglas:

1. Un doctor no puede tener citas activas que se superpongan.
2. Cancelar libera el horario.
3. Repetir la misma solicitud de cita con el mismo ID de cita es idempotente.
4. Reutilizar un ID de cita con contenido diferente se rechaza.
5. La disponibilidad se cachea solo como aceleración; el repository sigue siendo la fuente autoritativa.

El ejemplo actual del repositorio implementa las primeras cuatro reglas con un repository en memoria y valida una duración máxima de la cita mediante un servicio interno de policy. No afirma tener base de datos, lock distribuido, cache durable, autenticación ni un workflow de reservas para producción.

## Lo que vas a construir

```text
clinic-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- contract.ts       # typed policy Endpoint and Structs
|   |-- service.ts        # domain invariant and canonical repository
|   |-- transport.ts      # policy Server and Client over Memory Transport
|   |-- cache.ts          # availability cache and invalidation policy
|   |-- http.ts           # Fetch routes and health delegation
|   `-- main.ts           # one composition root and one Core App
`-- test/
    |-- main.test.ts      # domain, typed call, HTTP, cache, health, cancellation
    `-- node-e2e.ts       # real bind, request, stop, and port release
```

El ejemplo actual del workspace tiene este árbol más pequeño:

```text
examples/healthcare-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- service.ts
|   |-- transport.ts      # current raw JSON policy boundary
|   |-- http.ts
|   `-- main.ts
`-- test/main.test.ts
```

El segundo árbol es la fuente de verdad de lo que ya está en el checkout. El primero es la forma objetivo para los milestones del tutorial.

## Prerrequisitos y comandos

Desde la raíz del repositorio:

```sh
bun install --frozen-lockfile
```

Los paquetes son dependencias del workspace en este checkout. El repositorio raíz registra Bun `1.3.14`, Node.js `26.x`, Deno `2.9.4`, TypeScript `7.0.2` y k6 `2.1.0` como matriz de validación; cualquier patch de Node.js 26.x es válido. La documentación actual de los paquetes dice que todavía no se han publicado en npm.

Ejecuta el ejemplo baseline existente:

```sh
HOST=127.0.0.1 PORT=3000 bun run --cwd examples/healthcare-appointments start
```

El script `start` construye los paquetes raíz, crea un bundle preparado para Node y lo ejecuta. Espera la línea `GO_LIKE_EXAMPLE_READY` antes de enviar tráfico. En otra terminal:

```sh
NOW=$(($(date +%s) * 1000))
curl -i -sS http://127.0.0.1:3000/v1/appointments \
  -H 'content-type: application/json' \
  -d "{\"appointmentId\":\"appointment-1\",\"doctorId\":\"doctor-1\",\"patientId\":\"patient-1\",\"startsAt\":$((NOW + 3600000)),\"endsAt\":$((NOW + 5400000))}"

curl -i -sS -X DELETE \
  http://127.0.0.1:3000/v1/appointments/appointment-1
```

Detén el proceso en primer plano con `Ctrl-C`. No arranques una segunda App oculta para el servicio de policy; el ejemplo actual coloca el Server de policy y el Web Server en la misma Core App.

Las comprobaciones enfocadas del ejemplo actual son:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
```

El ejemplo también declara un wrapper E2E:

```sh
bun run --cwd examples/healthcare-appointments test:e2e
```

Ese comando construye y ejecuta la tarea E2E del ejemplo. Es un comando para ejecutar, no una afirmación de que el checkout actual ya lo haya pasado.

## M0: primero las reglas de dominio

El módulo de dominio es Context-first aunque la sección crítica del repository en memoria sea síncrona. Así la cancelación y el reemplazo futuro del provider quedan visibles en la frontera:

```ts
import type { Context } from "@go-like/context"

export interface BookAppointmentCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

export type AppointmentStatus = "booked" | "cancelled"

export interface Appointment extends BookAppointmentCommand {
  readonly status: AppointmentStatus
}

export interface AppointmentRepository {
  book(ctx: Context, command: BookAppointmentCommand): Appointment
  cancel(ctx: Context, appointmentId: string): Appointment
  get(ctx: Context, appointmentId: string): Appointment | undefined
}
```

El repository debe comprobar `ctx.err()` antes de mutar el estado. El ejemplo actual hace esto en `newMemoryAppointmentRepository()` y guarda un fingerprint con cada cita. Su predicado de solapamiento es:

```ts
function overlaps(
  leftStartsAt: number,
  leftEndsAt: number,
  rightStartsAt: number,
  rightEndsAt: number
): boolean {
  return leftStartsAt < rightEndsAt && rightStartsAt < leftEndsAt
}
```

Ese predicado hace válidas las citas adyacentes, mientras que las citas activas que se superponen para un doctor fallan. Cancelar cambia el status guardado a `cancelled`; una segunda cancelación devuelve el mismo registro cancelado.

### Pruebas de M0

Escribe estas pruebas antes de añadir HTTP o transporte:

```ts
import { background } from "@go-like/context"
import { expect, test } from "bun:test"

// The concrete repository factory is the one in src/service.ts.
test("rejects an overlapping active slot", () => {
  const repository = newMemoryAppointmentRepository()
  const book = newBookAppointment(repository, () => 1_000)
  book(background(), {
    appointmentId: "a-1",
    doctorId: "doctor-1",
    patientId: "patient-1",
    startsAt: 2_000,
    endsAt: 3_000
  })

  expect(() =>
    book(background(), {
      appointmentId: "a-2",
      doctorId: "doctor-1",
      patientId: "patient-2",
      startsAt: 2_500,
      endsAt: 3_500
    })
  ).toThrow("doctor time conflict")
})
```

El `test/main.test.ts` actual contiene este caso, además de la reutilización tras cancelar, la cancelación idempotente y una comprobación del handler HTTP. Esas pruebas son evidencia inspeccionada del repositorio hasta que el comando anterior se ejecute en tu entorno.

## M1: un servicio interno de policy tipado

El contrato interno tipado usa `@go-like/struct` y `@go-like/transport`. Es validación en runtime sobre una frontera unary de `Message`, no un IDL ni un servicio RPC generado.

### `src/contract.ts`

```ts
import { struct, type Infer } from "@go-like/struct"
import { endpoint } from "@go-like/transport"

const CheckRequest = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const CheckResponse = struct.object({
  allowed: struct.boolean()
})

export type CheckRequest = Infer<typeof CheckRequest>
export type CheckResponse = Infer<typeof CheckResponse>

export const checkAppointment = endpoint(
  "appointment-policy",
  "AppointmentPolicy.Check",
  CheckRequest,
  CheckResponse
)
```

Los tokens de ruta son ASCII visible y no pueden contener `/` ni `*`. El `Endpoint` contiene instancias de Struct para request y response y los dos tokens de ruta. No describe una dirección de red ni un client generado.

### `src/transport.ts`

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"

import { checkAppointment, type CheckRequest, type CheckResponse } from "./contract"

const policyAddress = "memory://appointment-policy"

export interface AppointmentPolicy {
  readonly server: Server
  validate(ctx: Context, request: CheckRequest): Promise<CheckResponse>
  close(ctx: Context): Promise<void>
}

export function newAppointmentPolicy(maximumDurationMs = 7_200_000): AppointmentPolicy {
  const transport = newMemoryTransport()
  const client = newClient(withTransport(transport))
  const server = newServer(
    serverTransport(transport),
    address(policyAddress),
    handler(checkAppointment, (_ctx, request) => {
      if (request.endsAt - request.startsAt > maximumDurationMs) {
        throw new Error("appointment duration exceeds policy")
      }
      return { allowed: true }
    })
  )

  return Object.freeze({
    server,
    async validate(ctx: Context, request: CheckRequest): Promise<CheckResponse> {
      return await client.call(ctx, checkAppointment, request, withAddress(policyAddress))
    },
    close(ctx: Context): Promise<void> {
      return client.close(ctx)
    }
  })
}
```

El ejemplo comprometido actual usa un handler de policy con `Message` sin tipos y un `serviceError(...)` con status `409`. Esa es una frontera válida de menor nivel. La versión tipada de arriba cambia el codec de request y response, pero no cambia el modelo central de propiedad: una instancia de Memory Transport, un Server interno, un Client y un cierre explícito.

### Reenvía el Context

El caso de uso de reserva debe pasar el mismo Context de la request al Client de policy y al repository:

```ts
async function validatedBook(ctx: Context, command: CheckRequest): Promise<Appointment> {
  await policy.validate(ctx, command)
  return repository.book(ctx, command)
}
```

Reemplazar `ctx` por `background()` descartaría el deadline, la cancelación y la ascendencia de Context de la request. Es una regresión de corrección, no una simplificación inofensiva.

### Pruebas de M1

Prueba todo lo siguiente:

| Prueba                     | Resultado esperado                                        |
| -------------------------- | --------------------------------------------------------- |
| request tipada válida      | `allowed: true` y una cita reservada                      |
| request demasiado larga    | fallo de policy antes de mutar el repository              |
| tipo de campo inválido     | fallo de decode de la request tipada                      |
| forma de response inválida | fallo de encode de la response en la frontera del Server  |
| Context cancelado          | policy y repository observan la misma cancelación         |
| cierre del client          | el cleanup del Client residente de Transport es explícito |

La prueba de policy del ejemplo actual ya verifica el rechazo antes de mutar el repository y el éxito a través de `Client -> Memory Transport -> Server`. La prueba tipada es una extensión propuesta.

## M2: Cache de disponibilidad

Cache sirve para una proyección de lectura, no para la autoridad de las reservas. El paquete Cache expone `get`, `put` y `delete` Context-first; `@go-like/cache-memory` proporciona `newMemoryCache()` y `@go-like/cache` proporciona `expiresIn(...)`:

```ts
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"

const availabilityCache = newMemoryCache()

async function readAvailability(ctx: Context, doctorId: string) {
  const key = `availability/${doctorId}`
  const cached = await availabilityCache.get(ctx, key)
  if (cached !== null) {
    return JSON.parse(new TextDecoder().decode(cached)) as Availability
  }

  const authoritative = repository.readAvailability(ctx, doctorId)
  await availabilityCache.put(
    ctx,
    key,
    new TextEncoder().encode(JSON.stringify(authoritative)),
    expiresIn(30_000)
  )
  return authoritative
}

async function invalidateAvailability(ctx: Context, doctorId: string): Promise<void> {
  await availabilityCache.delete(ctx, `availability/${doctorId}`)
}
```

`repository.readAvailability(...)` es un método propiedad de la aplicación en este tutorial, no un export de go-like. Booking y cancelación deben invalidar la key después de la mutación autoritativa. Si la invalidación falla, repórtalo y elige una policy de consistencia explícita; no trates en silencio el Cache como fuente de verdad de las reservas.

### Pruebas de M2

- un miss lee el repository y llena el Cache;
- un hit no vuelve a leer el repository;
- reservar o cancelar elimina la proyección;
- un valor expirado vuelve al repository;
- un fallo del Cache no convierte una lectura autoritativa correcta en un resultado falso de reserva;
- reiniciar el proceso pierde por diseño el estado de Memory Cache.

## M3: liveness y readiness

Crea el registry en el composition root y delega dos paths a `createHealthHandler(...)`:

```ts
import { createHealthHandler } from "@go-like/web/health"
import { newProbeRegistry } from "@go-like/health"
import type { Handler } from "@go-like/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policy.server.endpoint(ctx)
})

const healthHandler = createHealthHandler(probes)
const appointmentHandler: Handler = newAppointmentHandler(book, cancel)

const webHandler: Handler = (request) => {
  const path = new URL(request.url).pathname
  if (path === "/livez" || path === "/readyz") return healthHandler(request)
  return appointmentHandler(request)
}
```

Las rutas default son `/livez` y `/readyz`. Un liveness vacío está sano; un readiness vacío falla cerrado. El probe `policy` de arriba hace que readiness dependa de la admisión del listener interno sin fingir que una base de datos externa define siempre el liveness del proceso.

Un servicio de producción debería añadir solo las dependencias de readiness que realmente sean necesarias para recibir tráfico. Los nombres de probes son identificadores públicos y los payloads de health están sanitizados de forma deliberada.

## M4: un solo responsable del ciclo de vida

El composition root debe construir los recursos una sola vez y colocarlos bajo una App:

```ts
import process from "node:process"
import { afterStart, afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

const policy = newAppointmentPolicy()
const httpServer = newNodeServer(webHandler, hostname("127.0.0.1"), port(3000))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=healthcare-appointments\n")
  }),
  afterStop((ctx) => policy.close(ctx))
)

await app.run()
```

El hook `afterStop` es una frontera explícita de orden para el Client de policy. Core detiene los Servers hermanos de forma concurrente. Si necesitas un orden de dependencias más complejo, compón los recursos dependientes en un solo Server o en un hook explícito, en lugar de depender del orden de declaración.

`signal()` es el adaptador de proceso para Node/Bun. El dominio, el contrato tipado, Memory Transport y los módulos de health pueden seguir siendo portables; el import de `@go-like/core/node` es una decisión deliberada de runtime.

## M5: plan de pruebas y evidencia

| Capa           | Prueba                                                                   | Objetivo de evidencia                                                |
| -------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Dominio        | solapamiento, reutilización tras cancelar, idempotencia, ID en conflicto | comportamiento de `src/service.ts` y resultado de la prueba unitaria |
| Context        | una reserva cancelada no muta el repository ni llama a policy            | prueba enfocada de Context                                           |
| Llamada tipada | decode/encode de Struct, rechazo de policy, validación de response       | frontera de `@go-like/client` y `@go-like/server`                    |
| Cache          | miss, hit, TTL, invalidación, fallback tras fallo                        | pruebas de `newMemoryCache()`                                        |
| Health         | liveness vacío, readiness vacío, probe fallido, 405/404                  | `newProbeRegistry()` y `createHealthHandler()`                       |
| HTTP           | `POST`, `DELETE`, JSON inválido, status de conflicto                     | prueba de Handler Fetch estándar                                     |
| Ciclo de vida  | policy y Web Server admitidos bajo una App; cierre explícito del Client  | comportamiento de Core App y Server terminal                         |
| Node E2E       | bind real, request, signal, stop, liberación del puerto                  | wrapper E2E del ejemplo y comprobaciones residuales                  |

Para el ejemplo actual del repositorio, los comandos enfocados son:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
bun run --cwd examples/healthcare-appointments test:e2e
```

Para la lane completa de examples:

```sh
bun run test:e2e:examples
```

La lane E2E completa construye los paquetes y usa el runner del repositorio. Los providers Docker y los consumers de varios runtimes son scopes separados. Registra el commit candidato, las versiones de runtime, el status de salida, el resumen y los procesos o containers residuales; que exista un script no demuestra que haya pasado.

## Hitos

| Milestone | Entregable                                       | Avanza cuando                                                                         |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| M0        | Repository de dominio y pruebas de invariantes   | El comportamiento de solapamiento y cancelación es determinista                       |
| M1        | Endpoint tipado de policy sobre Memory Transport | La llamada es realmente Client/Server/Transport, no una llamada directa a una función |
| M2        | Proyección de Cache con invalidación             | Un fallo del Cache no puede reemplazar la autoridad                                   |
| M3        | `/livez` y `/readyz`                             | Se entienden el readiness vacío y los probes fallidos                                 |
| M4        | Una App, signal, cleanup explícito del Client    | Cada recurso admitido tiene un responsable                                            |
| M5        | Evidencia de unit y Node E2E                     | Los resultados quedan registrados con comando y status de salida                      |

No añadas Registry, Redis, Vault, un broker real, autenticación ni retries antes de tener claros estos milestones. Cada uno agrega un modelo nuevo de propiedad o de fallos que conviene introducir deliberadamente.

## Solución de problemas

### `Cannot find package "@go-like/..."`

Probablemente estás ejecutando fuera del workspace o dependiendo de un paquete no publicado. Ejecuta `bun install --frozen-lockfile` desde la raíz del repositorio y usa un script del workspace como `bun run --cwd examples/healthcare-appointments start`.

### La request devuelve `404`

El ejemplo actual solo expone `POST /v1/appointments` y `DELETE /v1/appointments/{appointmentId}`. Revisa el método, el path y la línea `GO_LIKE_EXAMPLE_READY`. Las rutas de health pertenecen a la extensión tutorial M3, no al ejemplo actual comprometido.

### La request devuelve `400`

El ejemplo requiere IDs de tipo string y valores numéricos para `startsAt`/`endsAt`. `startsAt` debe estar en el futuro respecto al clock inyectado y `endsAt` debe ser mayor que `startsAt`. Revisa que la aritmética del shell haya producido números y no strings entre comillas.

### La request devuelve `409`

Un horario del doctor se superpone con una cita activa, se reutilizó un ID de cita con contenido diferente o el servicio de policy rechazó la duración. La policy se llama antes de mutar el repository, así que un rechazo de policy no debería crear un registro.

### Una llamada tipada informa que el body de request o response es inválido

Comprueba que client y server usan los mismos `Endpoint` Structs y que el Content-Type de la request es exactamente `application/json`. `handler(contract, fn)` hace la validación JSON y Struct en la frontera del Server.

### Memory Client no puede alcanzar el Server

`newMemoryTransport()` crea un mapa de direcciones privado de cada instancia. Client y Server deben compartir la misma instancia de Transport y la dirección `memory:` exacta a la que se hizo bind. Una URL igual en dos instancias de Memory Transport construidas por separado no conecta.

### Parece que `app.run()` se queda colgado

Un `Server.start(ctx)` de larga duración puede permanecer pendiente durante toda la vida del servicio. Es lo esperado. `app.run()` resuelve después del stop y el cleanup terminal, no inmediatamente después de enlazar un listener. Usa `afterStart` o `server.endpoint(ctx)` como señal de admisión.

### Stop devuelve un timeout o un error agregado

El timeout limita la espera de cleanup del caller. No demuestra que el recurso nativo se haya detenido, y los Servers hermanos se detienen de forma concurrente. Inspecciona el error principal, la barrera terminal del adaptador y la evidencia de procesos o sockets residuales antes de considerar limpio el shutdown.

### Desaparecieron los datos del Cache

`@go-like/cache-memory` es local al proceso y desechable. Usa un provider explícito de Store para registros autoritativos y documenta su durabilidad y propiedad reales, en lugar de tratar un Cache como una base de datos.

## Resumen de la frontera

Este proyecto enseña un camino real por go-like sin dejar de ser pequeño:

```text
Request
  -> standard Fetch Handler
  -> Context-first appointment use case
  -> typed Client call
  -> Memory Transport
  -> unary Server policy handler
  -> canonical appointment repository
  -> disposable availability Cache
  -> Response

App.stop()
  -> deregistration if configured
  -> concurrent Server stop
  -> explicit Client / provider cleanup
  -> terminal result
```

No enseña gRPC, Protobuf, generación de IDL, streams internos full-duplex, locks distribuidos, mensajería durable ni autenticación de producción. Son decisiones de diseño separadas, fuera de este proyecto pequeño.

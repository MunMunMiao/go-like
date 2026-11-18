# Llamadas de servicio

Una llamada de servicio interna es un intercambio Fetch. El nombre de la operación y la dirección de transporte son valores distintos. Una llamada tipada añade validación Struct sobre el body JSON. El RPC Protobuf generado es un camino aparte; véase [Streaming](/es-Latn/guide/streaming).

## Identidad de la operación y dirección

`defineService("appointment-policy.v1", { check })` nombra la operación `appointment-policy.v1/check`. `withEndpoint("memory://appointment-policy.v1")` y `address("memory://appointment-policy.v1")` nombran adónde van los bytes. Un `ServiceInstance` del registro guarda URLs de transporte en `endpoints`. Los filtros y los selectores eligen entre esas URLs. No eligen la operación.

## Memory Transport tipado

Hay que usar un mismo `newMemoryTransport()` en los dos lados. Es local al proceso y privado de la instancia. Esta es la forma de `examples/healthcare-appointments`:

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { name, newApp, server } from "@go-like/core"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService, serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const math = defineService("math", {
  add: {
    request: struct.object({ left: struct.number(), right: struct.number() }),
    response: struct.object({ sum: struct.number() })
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://math"))
math.registerHandler(rpc, {
  add(_ctx, request) {
    if (!Number.isFinite(request.left) || !Number.isFinite(request.right)) {
      throw serviceError("math_rejected", "operands must be finite", 400)
    }
    return { sum: request.left + request.right }
  }
})

const client = newClient(withTransport(transport), withEndpoint("memory://math"))
const api = math.newClient(client)
const app = newApp(name("math"), server(rpc))
const running = app.run()
await rpc.endpoint(background())
try {
  const result = await api.add(background(), { left: 2, right: 3 })
  console.log(result.sum)
} finally {
  await client.close(background())
  await app.stop()
  await running
}
```

`service.registerHandler` enlaza cada handler tipado antes del arranque. `service.newClient(client).add(ctx, value)` valida la petición y la respuesta. `client.close(ctx)` es limpieza de la aplicación. En un proceso real, hay que cerrar el cliente desde `afterStop` y dejar que `app.run()` posea el tiempo de vida.

`newHTTPTransport()` es el cliente Fetch portable. No escucha. Un listener de Node usa `newNodeHTTPTransport()` de `@go-like/core/transport/http/node` tanto en el servidor como en el cliente de Node. Pasar `newHTTPTransport()` a `newServer` pasa el typecheck y después falla al escuchar con `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY`.

`@go-like/core/server` y `@go-like/core/client` exportan ambos `middleware` y `use`. Hay que importar uno de ellos como namespace cuando un archivo necesita los dos.

## Un intento

La llamada por defecto hace un intento. El cliente construye un `POST` con `content-type: application/json`, abre la conexión o reutiliza un transporte y lee la respuesta. Un body JSON que no es 2xx y coincide con el sobre de error de servicio se convierte en un `ServiceError`. Hay que reconocerlo con `isServiceError` de `@go-like/core/transport` antes de leer `code`, `status` o `metadata`. `ServiceError.code` pertenece a la aplicación. No es un código `GO_LIKE_*`.

Un `client.call` crudo recibe `{ service, endpoint, headers, body }` y devuelve una `Response` de Fetch. Quien llama lee el body o lo cancela.

La metadata viaja en el Context. `@go-like/core/metadata` ofrece `newClientContext`, `fromServerContext` y `propagateToClientContext`. La propagación es explícita. La metadata entrante no se copia al salto siguiente salvo que el handler lo haga.

## Descubrimiento, filtros y selección

`newDiscoveryResolver` de `@go-like/core/registry` observa un servicio y conserva una instantánea de reemplazo completo. Una instantánea vacía es autoritativa: la selección falla con `GO_LIKE_NO_AVAILABLE_ENDPOINT` en lugar de reutilizar las instancias anteriores.

```ts
import { newClient, withDiscovery, withEndpoint, withSelector } from "@go-like/core/client"
import { newP2CSelector } from "@go-like/core/registry"

const client = newClient(
  withDiscovery(registry),
  withEndpoint("discovery:///pricing"),
  withSelector(newP2CSelector())
)
void client
```

`withDiscovery` recibe el `Discovery`. El cliente construye un resolver privado. Hay que llamar a `newDiscoveryResolver(discovery)` solo cuando el código de la aplicación necesita instantáneas fuera de un cliente. Dos resolvers sobre un mismo Discovery no comparten watchers.

Los filtros son puros y ordenados. `filterVersion` y `filterLabel` son los que vienen incluidos, y se pasan en cada llamada con `withFilter`. Los selectores son `newRoundRobinSelector`, `newWeightedRoundRobinSelector`, `newRandomSelector`, `newP2CSelector` y `newEWMASelector`. P2C y EWMA reciben feedback síncrono después del intento. Ese estado es distinto de `circuitBreakerMiddleware`, que asocia un breaker a una operación.

`withBlock()` espera la primera instantánea no vacía. Una lista de direcciones directa de `withEndpoint` es una instantánea estática y aun así pasa por el selector. `withEndpoint("discovery:///name")` nombra el servicio que hay que observar.

## El retry es autorización de repetición

`withRetry` de `@go-like/core/client` exige:

- `authorization`: `"idempotent"` o `"caller-approved"`;
- `maxAttempts`: un entero positivo, que cuenta el primer intento;
- `shouldRetry(ctx, error, attempt)`, que devuelve un booleano.

La autorización es una declaración de quien llama. Core no inspecciona efectos secundarios. Cada intento vuelve a entrar en descubrimiento y selección. Una respuesta que ya se recibió, seguida de un fallo de feedback o de limpieza, no se repite.

`retry` y `exponentialBackoff` en `@go-like/core/resilience` son la misma idea para código de aplicación fuera del cliente. `newCircuitBreaker` y `circuitBreakerMiddleware` se abren ante fallos definidos por quien llama. `circuitOpen` es el centinela que se lanza mientras el breaker está abierto. `newTokenBucketLimiter` y `rateLimitMiddleware` rechazan las llamadas que exceden el límite.

## Limpieza

- Hay que cerrar clientes y watchers de configuración en `afterStop`, o admitir una conexión nativa con `newResourceServer`.
- Hay que conservar el Context de la petición para la llamada. Sustituirlo por `background()` pierde la cancelación y el span actual.
- Hay que casar los fallos por centinela, `isServiceError` o un `code` documentado. El mensaje queda para el diagnóstico. El catálogo es [Manejo de errores](/reference/errors).

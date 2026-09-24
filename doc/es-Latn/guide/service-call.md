# Llamadas de servicio

Una llamada unary interna combina piezas pequeñas. `@go-like/client` entrega una instantánea de `Discovery` a un `Selector` y después completa un intercambio `send`/`recv` a través de un `Transport`. La construcción usa opciones funcionales:

```ts
import {
  newClient,
  withDiscovery,
  withFilter,
  withSelector,
  withService,
  withTransport
} from "@go-like/client"
import { filterLabel, filterVersion, type Filter } from "@go-like/registry"

const client = newClient(
  withDiscovery(discovery),
  withService("orders"),
  withSelector(selector),
  withTransport(serviceTransport)
)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
const reply = await client.call(
  ctx,
  {
    service: "orders",
    endpoint: "Orders.Get",
    message: { header: {}, body: requestBytes }
  },
  withFilter(...filters)
)
```

`Filter`, `filterVersion(...)` y `filterLabel(...)` pertenecen a la API raíz de Registry. Los filtros se ejecutan en el orden declarado antes de `Selector.select`. Para un destino directo, construye `newClient(withTransport(serviceTransport), withAddress(serviceAddress))`; `withAddress(...)` evita Discovery, pero pasa por el mismo Selector que las instantáneas descubiertas. Un cliente con Discovery usa `withService(serviceName)` y `withDiscovery(discovery)` juntos, abre de forma diferida un watcher por servicio y selecciona desde la última instantánea completa. Solo cuando la repetición sea idempotente o se haya aprobado expresamente, `withRetry(...)` configura intentos acotados, clasificación de fallos y backoff opcional; cada reintento admitido vuelve a seleccionar desde la instantánea más reciente. De forma predeterminada hay un solo intento. Al dejar de usar el cliente, llama a `client.close(ctx)`. `closeTimeout(...)` limita únicamente la limpieza lógica del Client de Transport; la reutilización de conexiones físicas pertenece al Transport y al runtime.

`@go-like/server` asocia handlers al Transport y expone la dirección enlazada real. Construye el Server con `transport(...)`, `address(...)`, `middleware(...)` y `listenOption(...)`; antes de iniciarlo registra la ruta con `server.registerHandler(...)`. `listenOption(...)` entrega los valores `ListenOption` específicos del proveedor a `Transport.listen`. `endpoint(ctx)` comparte el bind real que usa `start(ctx)`. Una Core App configurada como `newApp(registrar(registry), server(serviceServer))` publica y retira ese endpoint como `ServiceInstance` de la aplicación.

Cada intento unary inyecta en el Context del Transport un `TransportInfo` del lado cliente con el destino real, la operación estable `service/endpoint` y los headers del wire. El Server inyecta el valor correspondiente antes de llamar al handler de negocio. Client y Server codifican metadata multivalor del Context en el sobre canónico y acotado `Go-Like-Metadata`; los proveedores de Transport lo trasladan como un header opaco de Message. `propagateToClientContext(...)` solo copia metadata del servidor hacia abajo mediante una allowlist explícita `exact` o `prefix`.

La llamada espera el feedback y la devolución del Client lógico de Transport al pool, o su cierre cuando corresponda. Por defecto se conserva el cliente que terminó correctamente; `poolSize(0)` desactiva esa retención. Un fallo de limpieza posterior a la respuesta conserva esta en `AggregateError.cause` y los errores ordenados en `errors`; no se reintenta la operación. Al terminar, cierra el propietario con `client.close(ctx)`.

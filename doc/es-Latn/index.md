# go-like

go-like es un conjunto de piezas explícitas de TypeScript para servicios backend en Bun y Node.js. `@go-like/core` es el panel de sockets sin dependencias de runtime: Context, ciclo de vida de la aplicación, llamadas internas, configuración, descubrimiento, registros de datos, caché, mensajería, jobs, salud y la base de telemetría. Los otros diecinueve paquetes son plugs. Un plug rellena uno o más sockets con un cliente del ecosistema que crea la aplicación. `@go-like/protoc-gen-like` es el generador de Protobuf en tiempo de compilación y no depende de core.

La aplicación sigue siendo la raíz de composición. Construye los objetos nativos, los pasa a los constructores de los plugs e instala los resultados en `newApp`. No hay un registro global de servidores, loggers ni proveedores de telemetría.

> [!IMPORTANT]
> Este checkout es un workspace privado `0.0.1`. La versión del manifiesto no establece disponibilidad en npm. Los ejemplos usan paquetes del workspace y están pensados para ejecutarse desde un checkout, salvo que una release publicada se confirme por separado.

> [!NOTE]
> El árbol inglés `doc/` es la fuente canónica de esta pista de documentación. El código fuente de los paquetes, los manifiestos y las pruebas enfocadas son la autoridad de la API. Un test o un script E2E que existe en el repositorio es cobertura declarada; no es un resultado aprobado hasta que un comando se haya ejecutado y se haya registrado su estado de salida.

## Elige un recorrido

| Lector                                  | Empieza aquí                                        | Después                                                                                       | Listo cuando                                                                                          |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Quien empieza con go-like               | [Primeros pasos](/es-Latn/guide/getting-started)    | [Arquitectura](/es-Latn/guide/architecture), [Sistema de citas](/es-Latn/guide/zero-to-one)   | Se puede arrancar un servicio Web, pasar un Context, exponer la salud y pararlo                       |
| Ingeniero de TypeScript con experiencia | [Arquitectura](/es-Latn/guide/architecture)         | [Llamadas de servicio](/es-Latn/guide/service-call), [Comparación](/es-Latn/guide/comparison) | Se puede nombrar el propietario, el nivel y la frontera terminal de cada recurso                      |
| Lector de Go o Kratos                   | [Primeros pasos](/es-Latn/guide/getting-started)    | [Terminología](/reference/terminology), [Llamadas de servicio](/es-Latn/guide/service-call)   | Se pueden relacionar Context y Server sin suponer compatibilidad con gRPC ni con el ABI de Go         |
| Usuario de un framework                 | [Comparación](/es-Latn/guide/comparison)            | [Migración](/es-Latn/guide/migration), [Arquitectura](/es-Latn/guide/architecture)            | Se puede conservar el router nativo y añadir solo la frontera de ciclo de vida o de llamada necesaria |
| Autor de un plug                        | [Índice de providers](/es-Latn/reference/providers) | [Verificación](/es-Latn/reference/verification), [Afirmaciones](/reference/claims)            | Se puede indicar el socket, el runtime, la propiedad y los límites de evidencia de un plug            |

## Recorrido de aprendizaje canónico

El recorrido canónico de cuatro páginas bajo `doc/guide/` es progresivo a propósito:

1. [Primeros pasos](/es-Latn/guide/getting-started) ejecuta un Fetch Handler estándar, un host de Node, una señal de admisión y una App.
2. [Sistema de citas de una clínica](/es-Latn/guide/zero-to-one) convierte el ciclo de vida en un dominio concreto, una llamada unary interna, caché, salud, una prueba y el apagado.
3. [Comparación](/es-Latn/guide/comparison) explica dónde go-like se aparta a propósito de NestJS, Fastify, Hono, Elysia, Koa, tRPC, go-micro y go-kratos.
4. [Migración](/es-Latn/guide/migration) hace corresponder los paquetes anteriores a la migración con la disposición de 20 paquetes.

[Paquetes](/es-Latn/reference/packages) es el inventario de 20 paquetes y 75 entradas públicas. [Providers](/es-Latn/reference/providers) apunta al README de cada plug del ecosistema.

## El modelo mental

Tres reglas recorren la biblioteca:

1. **Context primero.** Toda operación de E/S recibe `ctx: Context` como primer argumento. Context transporta la cancelación, un deadline, AppInfo, la metadata de la petición y el estado de telemetría actual.
2. **Composición explícita.** La aplicación construye cada implementación y la pasa. Los plugs no se registran de forma global.
3. **Un camino para cada trabajo.** Hay que suscribirse con `newBrokerServer`, programar con `newScheduleServer`, consumir una cola con `JobQueue.worker`, adjuntar un recurso nativo con `newResourceServer` y publicar readiness con `readyProbe` más `createHealthHandler`.

```text
Application main.ts
  construct plugs from native objects the application created
  newTelemetry({...})  newConfig(...)  newServer(...)  newClient(...)
        |
        v
@go-like/core  newApp(...)
  telemetry(tel)     admitted first, drained last
  resources(...)     started in order, each start awaited, stopped in reverse
  server(...)        started together, stopped together
  registrar(r)       after the server tier is admitted
  readyProbe(...)    ready only between startup completion and stop
```

Cinco nombres bastan para leer el resto del sitio:

- **Socket** es un contrato estructural que declara core (`Server`, `LogHandler`, `Registry`, `Broker`, `Store` y los demás). Un plug implementa el socket. No envuelve un punto de llamada de core.
- **Context** es el ámbito explícito del trabajo cancelable.
- **Server** es `start(ctx)` y `stop(ctx)`. En `resources(...)`, `start` se resuelve cuando el recurso se puede usar. En `server(...)`, `start` puede seguir pendiente hasta que el objeto nativo termina.
- **App** admite esos niveles, los hooks, el registro y el apagado. No es un contenedor de inyección de dependencias.
- **Handler** es la función Web estándar `(Request) => Response | Promise<Response>`. Un Handler no es, por sí solo, un servidor a la escucha.

Las llamadas Web externas y las llamadas de servicio internas permanecen separadas. El RPC Protobuf generado es un camino opcional adicional: `@go-like/protoc-gen-like` emite el pegamento con `ctx` primero, `@go-like/connectrpc` adapta Connect y gRPC-Web a Fetch, y `@go-like/connectrpc/node` aloja gRPC estándar. Véase [Streaming](/es-Latn/guide/streaming).

## Lo que la aplicación sigue poseyendo

La frontera actual del producto deja esto en la aplicación o en la biblioteca nativa:

- rutas, middleware del framework, Web Streams y upgrades de WebSocket;
- policy de negocio, credenciales y autorización;
- acuse de recibo nativo, leases, reintentos y detalles de protocolo;
- construcción del SDK de OpenTelemetry, configuración del logger y elección del exporter;
- durabilidad, transacciones y cualquier significado entre procesos de una implementación de referencia en memoria;
- publicación en npm, estado de CI alojada o una afirmación de preparación para producción inferida de un manifiesto.

## Inventario público

El workspace publica **20** paquetes `@go-like/*`, todos en la versión `0.0.1` en este checkout, y **75** entradas públicas. `@go-like/core` aporta 41 entradas. Las otras 34 pertenecen a los plugs y al generador. Los exports de metadata `dist/package.json` generados no son APIs de código adicionales.

Usa la [referencia de paquetes](/es-Latn/reference/packages) para elegir una entrada y el [índice de providers](/es-Latn/reference/providers) para abrir el README de un plug. El [registro de afirmaciones](/reference/claims) anota el nivel de evidencia que hay detrás del texto público.

## Frontera de verificación

Una auditoría histórica del contrato del repositorio informó resultados locales en el commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`: `bun run typecheck`, `bun run test:unit` y `bun run fmt:check` pasaron. Ese informe contó 2,736 pruebas unitarias, 1,514 archivos formateados y una auditoría de imports correcta para 66 entradas de export de código. Ese recuento describe el árbol anterior a la migración. El inventario actual es de 75 entradas. La auditoría no estableció `build`, `doc:build`, el E2E de proveedores con Docker, consumidores de tarballs publicados, la publicación en npm, la CI alojada ni el soak de 60 minutos.

Lee [Verificación](/es-Latn/reference/verification) antes de convertir una afirmación de código o de script en una afirmación de release.

## Siguientes pasos

- [Primeros pasos](/es-Latn/guide/getting-started): ejecutar un handler Web y el primer punto de control del ciclo de vida.
- [Arquitectura](/es-Latn/guide/architecture): niveles, ámbitos de Context, orden de arranque y parada, readiness y presupuestos.
- [Sistema de citas de una clínica](/es-Latn/guide/zero-to-one): una invariante de negocio, desde HTTP hasta una llamada interna de policy, la salud y el apagado.
- [Llamadas de servicio](/es-Latn/guide/service-call): Memory Transport tipado y, después, descubrimiento, selección y retry.
- [Configuración, registro, almacenamiento y caché](/es-Latn/guide/config-registry-store): cuatro contratos, un cliente compartido por ecosistema.
- [Broker, eventos y jobs](/es-Latn/guide/broker-events): bytes, codecs, programaciones y colas.
- [Salud y observabilidad](/es-Latn/guide/health-observability): sondas, `newTelemetry` y los cuatro plugs de telemetría.
- [Comparación](/es-Latn/guide/comparison) y [Migración](/es-Latn/guide/migration): propiedad frente a otras herramientas, y el codemod de imports.
- [Paquetes](/es-Latn/reference/packages), [Providers](/es-Latn/reference/providers), [Errores](/reference/errors), [Terminología](/reference/terminology) y [Verificación](/es-Latn/reference/verification).

El drain de gRPC administrado con un consumidor lento en Node 26.12.1 y Bun 1.4.4 está registrado en la [matriz de drain de gRPC nativo](/reference/claims#native-grpc-drain-status). Las observaciones anteriores de cancelación de Connect 2.1.2 y Bun 1.4.2 Fetch siguen en el [registro de afirmaciones](/reference/claims#stream-cancellation-limits).

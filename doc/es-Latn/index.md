# go-like

go-like es un conjunto de piezas con estilo Go para crear servicios backend en TypeScript. Separa el ciclo de vida, el contexto, las llamadas entre servicios, el descubrimiento, la mensajería, la configuración, el almacenamiento, la salud y la observabilidad en paquetes pequeños. No te obliga a cambiar de framework ni a casarte con un runtime concreto.

El código portable se queda en las Web API estándar: `Request`, `Response`, `Headers`, `AbortSignal`, Web Streams y un `fetch` inyectado. Lo que depende de Node.js, Bun o Deno vive en una entrada aparte. Los frameworks que ya exponen Fetch no necesitan un adaptador de go-like: pasa `app.fetch` de Hono, Elysia o H3 2.x directamente a `@go-like/web`; H3 1.x usa `toWebHandler(app)`. Los adaptadores de ciclo de vida se reservan para recursos como Croner, BullMQ, NATS, Pino y Winston.

Empieza por [Primeros pasos](/es-Latn/guide/getting-started) y continúa con [Clínica: de 0 a 1](/es-Latn/guide/zero-to-one) para recorrer una ruta guiada por milestones. Si ya tienes un servicio, consulta [Migración y adopción](/es-Latn/guide/migration); para comparar responsabilidades entre herramientas, lee [go-like frente a otras herramientas](/es-Latn/guide/comparison).

La [referencia de paquetes](/es-Latn/reference/packages) y la [referencia de paquetes y providers](/es-Latn/reference/providers) aclaran quién hace qué, y [Verificación](/es-Latn/reference/verification) distingue lo que se ha probado de verdad de lo que solo sonaría razonable sobre el papel.

## Elige tu recorrido

- **Principiante:** empieza por [Primeros pasos](/es-Latn/guide/getting-started) y sigue [Clínica: de 0 a 1](/es-Latn/guide/zero-to-one) hasta ver Handler, señal de ready y parada.
- **Experto de TypeScript o Go:** lee [Arquitectura](/es-Latn/guide/architecture), después [Llamadas de servicio](/es-Latn/guide/service-call) y la [referencia de providers](/es-Latn/reference/providers); comprueba ownership y estado terminal.
- **Usuario de framework:** lee [Comparación](/es-Latn/guide/comparison) y [Migración y adopción](/es-Latn/guide/migration) para conservar tu router y añadir solo la frontera necesaria.

## Qué significa aquí «estilo Go»

El `Context` va primero en las operaciones que pueden bloquear, la propiedad de los recursos queda a la vista y cada parada tiene un resultado terminal observable. No copiamos las mayúsculas de Go ni fingimos que JavaScript tiene canales o goroutines: TypeScript conserva sus exports normales y cada proveedor mantiene sus objetos nativos.

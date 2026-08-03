# LikeGo

LikeGo es un conjunto de piezas con estilo Go para crear servicios backend en TypeScript. Separa el ciclo de vida, el contexto, las llamadas entre servicios, el descubrimiento, la mensajería, la configuración, el almacenamiento, la salud y la observabilidad en paquetes pequeños. No te obliga a cambiar de framework ni a casarte con un runtime concreto.

El código portable se queda en las Web API estándar: `Request`, `Response`, `Headers`, `AbortSignal`, Web Streams y un `fetch` inyectado. Lo que depende de Node.js, Bun o Deno vive en una entrada aparte. Los frameworks que ya exponen Fetch no necesitan un adaptador de LikeGo: pasa `app.fetch` de Hono, Elysia o H3 2.x directamente a `@likego/web`; H3 1.x usa `toWebHandler(app)`. Los adaptadores de ciclo de vida se reservan para recursos como Croner, BullMQ, NATS, Pino y Winston.

Empieza por [Primeros pasos](/es-Latn/guide/getting-started) y continúa con [Arquitectura](/es-Latn/guide/architecture). La [referencia de paquetes](/es-Latn/reference/packages) aclara quién hace qué, y [Verificación](/es-Latn/reference/verification) distingue lo que se ha probado de verdad de lo que solo sonaría razonable sobre el papel.

## Qué significa aquí «estilo Go»

El `Context` va primero en las operaciones que pueden bloquear, la propiedad de los recursos queda a la vista y cada parada tiene un resultado terminal observable. No copiamos las mayúsculas de Go ni fingimos que JavaScript tiene canales o goroutines: TypeScript conserva sus exports normales y cada proveedor mantiene sus objetos nativos.

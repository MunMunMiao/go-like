# LikeGo

LikeGo es un conjunto de piezas con estilo Go para crear servicios backend en TypeScript. Separa el ciclo de vida, el contexto, las llamadas entre servicios, el descubrimiento, la mensajería, la configuración, el almacenamiento, la salud y la observabilidad en paquetes pequeños. No te obliga a cambiar de framework ni a casarte con un runtime concreto.

El código portable se queda en las Web API estándar: `Request`, `Response`, `Headers`, `AbortSignal`, Web Streams y un `fetch` inyectado. Lo que depende de Node.js, Bun o Deno vive en una entrada aparte. Puedes seguir usando Hono, Elysia, H3, Croner, BullMQ, NATS, Pino o Winston; LikeGo se limita a encajar sus recursos en un ciclo de vida común.

Empieza por [Primeros pasos](/es-Latn/guide/getting-started) y continúa con [Arquitectura](/es-Latn/guide/architecture). La [referencia de paquetes](/es-Latn/reference/packages) aclara quién hace qué, y [Verificación](/es-Latn/reference/verification) distingue lo que se ha probado de verdad de lo que solo sonaría razonable sobre el papel.

## Qué significa aquí «estilo Go»

El `Context` va primero en las operaciones que pueden bloquear, la propiedad de los recursos queda a la vista y cada parada tiene un resultado terminal observable. No copiamos las mayúsculas de Go ni fingimos que JavaScript tiene canales o goroutines: TypeScript conserva sus exports normales y cada proveedor mantiene sus objetos nativos.

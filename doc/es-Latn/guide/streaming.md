# Streaming

LikeGo usa el modelo de streaming que ya trae la plataforma Web. La petición es un `Request` estándar y la respuesta un `Response` cuyo body puede ser un `ReadableStream<Uint8Array>`. No añade otra clase Stream, un DSL de frames ni una supuesta conexión bidireccional encima de un cuerpo de un solo uso.

El streaming HTTP público pertenece a `@likego/web` y al Handler nativo del framework. Los internos `@likego/client` y `@likego/transport` solo publican llamadas unary con `Message`; no existe otro Fetch Transport ni Stream Client.

Los cuerpos Web solo se consumen una vez. Un middleware no debería leerlos salvo que vaya a reemplazarlos de forma consciente. La cancelación viaja por el primer `Context` y por la señal del request. Además, el transporte comprueba que cada chunk sea `Uint8Array`; un chunk inválido produce un error de protocolo y no datos vacíos misteriosos.

Para HTTP público usa `@likego/web` con Hono, Elysia, H3 o tu propio handler. SSE, respuestas en flujo y upgrades WebSocket específicos del runtime siguen en el framework original; LikeGo conserva los objetos y errores nativos.

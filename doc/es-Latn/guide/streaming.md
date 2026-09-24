# Streaming

go-like usa el modelo de streaming que ya trae la plataforma Web. La petición es un `Request` estándar y la respuesta un `Response` cuyo body puede ser un `ReadableStream<Uint8Array>`. No añade otra clase Stream, un DSL de frames ni una supuesta conexión bidireccional encima de un cuerpo de un solo uso.

El streaming HTTP público pertenece a `@go-like/web` y al Handler nativo del framework. Los internos `@go-like/client` y `@go-like/transport` solo publican llamadas unary con `Message`; no existe otro Fetch Transport ni Stream Client.

Los cuerpos Web solo se consumen una vez. Un middleware no debería leerlos salvo que vaya a reemplazarlos de forma consciente. La cancelación viaja por el primer `Context` y por la señal del request. Además, el transporte comprueba que cada chunk sea `Uint8Array`; un chunk inválido produce un error de protocolo y no datos vacíos misteriosos.

Para HTTP público usa `@go-like/web` con Hono, Elysia, H3 o tu propio handler. SSE, respuestas en flujo y upgrades WebSocket específicos del runtime siguen en el framework original; go-like conserva los objetos y errores nativos.

`contextHandler` limpia su Context privado cuando el Handler devuelve la Response, no al terminar el body. Un productor de larga duración debe observar `request.signal` o un ámbito de cancelación propio.

`@go-like/protoc-gen-like` genera código Protobuf RPC con `Context` como primer argumento sobre Protobuf-ES. `@go-like/transport-grpc-buf` ofrece unary y server-streaming de Connect/gRPC-Web mediante Fetch; `/native` añade gRPC estándar con las cuatro cardinalidades, incluidas client-streaming y bidi. Es una vía independiente del Transport SPI unary.

La interoperabilidad no demuestra fiabilidad en producción: se observaron fallos de drain con un consumidor lento en Deno 2.9.5/2.9.7, retención del temporizador deadline de Connect 2.1.2 al cancelar una respuesta pausada y cancelación Fetch de Bun 1.4.2 que no llega a un servidor silencioso tras el primer chunk. Consulta las [pruebas y limitaciones](/reference/claims#stream-cancellation-limits); go-like no ha corregido estos fallos.

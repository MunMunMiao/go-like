# Streaming

go-like tiene tres fronteras de streaming.

1. **El streaming Web público** usa el body de `Request` y `Response` de Fetch y la API de Web Streams.
2. **Las llamadas de servicio internas** usan una petición Fetch y una respuesta Fetch. Una llamada unary lleva un body JSON. Un server stream pone `stream: true` y devuelve `text/event-stream`. En este camino no hay un SPI de client-stream ni bidireccional.
3. **El RPC Protobuf generado** usa `@go-like/connectrpc` para Connect y gRPC-Web sobre Fetch, y `@go-like/connectrpc/node` para gRPC estándar administrado. Fetch portable cubre unary y server-streaming. La entrada de Node cubre unary, server-streaming, client-streaming y bidi. `@go-like/protoc-gen-like` genera el pegamento de cliente y handler con `ctx` primero.

Un `ReadableStream`, una respuesta SSE del framework o un upgrade de WebSocket es streaming Web. Un server stream interno es SSE en `POST /<service>/<endpoint>` con `accept: text/event-stream`.

El drain de gRPC administrado con un consumidor lento en Node 26.12.1 y Bun 1.4.4 está registrado en la [matriz de drain de gRPC nativo](/reference/claims#native-grpc-drain-status). Las observaciones anteriores de cancelación de Connect 2.1.2 y Bun 1.4.2 Fetch siguen en el [registro de afirmaciones](/reference/claims#stream-cancellation-limits). El RPC generado no añade repetición de streams.

## Streaming Web público

```ts
import { contextHandler, type Handler } from "@go-like/core/web"

export const streamHandler: Handler = contextHandler(async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("first\n"))
      controller.enqueue(encoder.encode("second\n"))
      controller.close()
    }
  })
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" }
  })
})
```

La aplicación o el framework poseen el formato del stream, el flush, las convenciones SSE, el upgrade de WebSocket y la policy de desconexión. `contextHandler` termina su Context cuando el handler devuelve la `Response`. Un body de larga duración también debe observar `request.signal`. Un Context de RPC interno vive hasta que termina el body de la respuesta.

Hono, Elysia y H3 conservan sus propias APIs de stream y WebSocket. Hay que pasar `app.fetch` a `@go-like/core/web/node` o a `@go-like/core/web/bun` cuando se quiere el ciclo de vida de la App.

## Server streams internos

Hay que declarar `stream: true`. El handler es un generador asíncrono. El cliente lee un `ServerStream` con `for await`. `close()`, `await using`, `break` y la cancelación de quien llama abortan la petición.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const orders = defineService("orders", {
  watch: {
    request: struct.object({ after: struct.string() }),
    response: struct.object({ id: struct.string() }),
    stream: true
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://orders"))
orders.registerHandler(rpc, {
  async *watch(_ctx, request) {
    yield { id: request.after }
  }
})

const api = orders.newClient(newClient(withTransport(transport), withEndpoint("memory://orders")))
const stream = await api.watch(background(), { after: "0" })
for await (const event of stream) {
  console.log(event.id)
  break
}
await stream.close()
```

`streamKeepAlive` y `maxSendMessageBytes` en `@go-like/core/server` acotan el intervalo del comentario SSE y el tamaño del frame. No cambian la cardinalidad. Sigue habiendo un body de petición y una secuencia de eventos de respuesta.

## RPC generado

`@go-like/connectrpc` exporta `newHandler`, `callOptions` y `fromHandlerContext`. El handler es un `Handler` de Fetch para Connect y gRPC-Web. Se monta en un host Web de core igual que cualquier otro handler.

`@go-like/connectrpc/node` exporta `newServer`, `newClient` y las opciones de dirección, anuncio y TLS. Ese servidor es un `Server` de ciclo de vida y un `Endpointer` para el nivel de servidores. El cliente de Node consume `Discovery` y `Selector` cuando se le pasan. El gRPC estándar de esta entrada es el camino que cubre client-streaming y bidi.

`@go-like/protoc-gen-like` es el plugin de Buf. El código generado importa `@go-like/core/context` y `@go-like/connectrpc`. El generador no tiene socket de runtime.

gRPC estándar en el navegador, health y reflection oficiales de gRPC, y una garantía sobre runtimes futuros quedan fuera de esta matriz. El drain administrado que se ha probado es el [registro de afirmaciones](/reference/claims#native-grpc-drain-status).

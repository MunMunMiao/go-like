# Потоки

У go-like три границы потоков.

1. **Публичный Web-поток** использует тело Fetch `Request` и `Response` и Web Streams API.
2. **Внутренние вызовы сервисов** используют один Fetch-запрос и один Fetch-ответ. Унарный вызов несёт одно JSON-тело. Серверный поток задаёт `stream: true` и возвращает `text/event-stream`. На этом пути нет SPI клиентского потока и двунаправленного вызова.
3. **Сгенерированный Protobuf RPC** использует `@go-like/connectrpc` для Connect и gRPC-Web на Fetch и `@go-like/connectrpc/node` для управляемого стандартного gRPC. Переносимый Fetch покрывает унарные вызовы и server-streaming. Точка входа Node покрывает унарные вызовы, server-streaming, client-streaming и bidi. `@go-like/protoc-gen-like` генерирует связку клиента и Handler с Context первым аргументом.

`ReadableStream`, SSE-ответ фреймворка или апгрейд WebSocket — это Web-поток. Внутренний серверный поток — это SSE на `POST /<service>/<endpoint>` с `accept: text/event-stream`.

Управляемый drain gRPC при медленном потребителе на Node 26.12.1 и Bun 1.4.4 записан в [матрице drain нативного gRPC](/reference/claims#native-grpc-drain-status). Более ранние наблюдения отмены Fetch в Connect 2.1.2 и Bun 1.4.2 остаются в [журнале утверждений](/reference/claims#stream-cancellation-limits). Сгенерированный RPC не добавляет повтор потока.

## Публичный Web-поток

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

Приложение или фреймворк владеет форматом потока, flush, соглашениями SSE, апгрейдом WebSocket и политикой разрыва. `contextHandler` завершает свой Context, когда Handler возвращает `Response`. Долгоживущее тело должно также наблюдать `request.signal`. Context внутреннего RPC живёт, пока не закончится тело ответа.

Hono, Elysia и H3 сохраняют собственные API потоков и WebSocket. Передайте `app.fetch` в `@go-like/core/web/node` или `@go-like/core/web/bun`, когда нужен жизненный цикл App.

## Внутренние серверные потоки

Объявите `stream: true`. Handler — асинхронный генератор. Клиент читает `ServerStream` через `for await`. `close()`, `await using`, `break` и отмена со стороны вызывающего прерывают запрос.

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

`streamKeepAlive` и `maxSendMessageBytes` в `@go-like/core/server` ограничивают интервал SSE-комментария и размер кадра. Они не меняют вид вызова. По-прежнему одно тело запроса и последовательность событий ответа.

## Сгенерированный RPC

`@go-like/connectrpc` экспортирует `newHandler`, `callOptions` и `fromHandlerContext`. Handler — это Fetch `Handler` для Connect и gRPC-Web. Смонтируйте его на Web-host core так же, как любой другой Handler.

`@go-like/connectrpc/node` экспортирует `newServer`, `newClient` и параметры адреса, advertise и TLS. Этот сервер — `Server` жизненного цикла и `Endpointer` для яруса серверов. Node-клиент потребляет `Discovery` и `Selector`, когда вы их передаёте. Стандартный gRPC на этой точке входа — путь, который покрывает client-streaming и bidi.

`@go-like/protoc-gen-like` — плагин Buf. Сгенерированный код импортирует `@go-like/core/context` и `@go-like/connectrpc`. У генератора нет runtime-socket.

Стандартный gRPC в браузере, официальные gRPC health и reflection, а также гарантия будущих runtime находятся вне этой матрицы. Проверенный управляемый drain — это [запись утверждений](/reference/claims#native-grpc-drain-status).

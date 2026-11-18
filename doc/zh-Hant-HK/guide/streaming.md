# 串流

go-like 有三條串流邊界。

1. **公開 Web 串流**用 Fetch `Request` 同 `Response` body，以及 Web Streams API。
2. **內部服務呼叫**用一個 Fetch 請求同一個 Fetch 回應。Unary 呼叫帶一個 JSON body。伺服器串流設 `stream: true` 並返回 `text/event-stream`。呢條路徑冇 client-stream 或雙向 SPI。
3. **產生出嚟嘅 Protobuf RPC** 用 `@go-like/connectrpc` 做 Fetch 上嘅 Connect 同 gRPC-Web，用 `@go-like/connectrpc/node` 做託管標準 gRPC。可攜 Fetch 覆蓋 unary 同 server-streaming。Node 入口覆蓋 unary、server-streaming、client-streaming 同 bidi。`@go-like/protoc-gen-like` 產生 ctx-first client 同 handler 膠水。

`ReadableStream`、框架 SSE 回應或 WebSocket upgrade 係 Web 串流。內部伺服器串流係 `POST /<service>/<endpoint>` 上、帶 `accept: text/event-stream` 嘅 SSE。

Node 26.12.1 同 Bun 1.4.4 嘅託管 gRPC 慢消費者 drain 記錄喺[原生 gRPC drain 矩陣](/reference/claims#native-grpc-drain-status)。較早嘅 Connect 2.1.2 同 Bun 1.4.2 Fetch 取消觀察仍然留喺[聲明帳](/reference/claims#stream-cancellation-limits)。產生出嚟嘅 RPC 唔加串流重播。

## 公開 Web 串流

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

應用或框架擁有串流格式、flush、SSE 慣例、WebSocket upgrade 同斷線政策。`contextHandler` 喺 Handler 返回 `Response` 時結束自己嘅 Context。長命 body 亦應觀察 `request.signal`。內部 RPC Context 活到回應 body 結束。

Hono、Elysia 同 H3 保留自己嘅串流同 WebSocket API。你想要 App 生命週期時，將 `app.fetch` 傳畀 `@go-like/core/web/node` 或 `@go-like/core/web/bun`。

## 內部伺服器串流

宣告 `stream: true`。Handler 係 async generator。Client 用 `for await` 讀 `ServerStream`。`close()`、`await using`、`break` 同呼叫方取消都會中止請求。

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

`@go-like/core/server` 上嘅 `streamKeepAlive` 同 `maxSendMessageBytes` 限制 SSE 註解間隔同 frame 大小。佢哋唔改變基數。仍然係一個請求 body 同一串回應事件。

## 產生出嚟嘅 RPC

`@go-like/connectrpc` 匯出 `newHandler`、`callOptions` 同 `fromHandlerContext`。Handler 係 Connect 同 gRPC-Web 嘅 Fetch `Handler`。將佢掛上 core Web host，同任何其他 Handler 一樣。

`@go-like/connectrpc/node` 匯出 `newServer`、`newClient`，以及位址、advertise 同 TLS option。該 server 係生命週期 `Server`，亦係 Server 層嘅 `Endpointer`。你傳入時，Node client 會消費 `Discovery` 同 `Selector`。呢個入口上嘅標準 gRPC 先係覆蓋 client-streaming 同 bidi 嘅路徑。

`@go-like/protoc-gen-like` 係 Buf plugin。產生出嚟嘅程式碼 import `@go-like/core/context` 同 `@go-like/connectrpc`。產生器冇 runtime 插座。

瀏覽器標準 gRPC、官方 gRPC health 同 reflection，以及對未來 runtime 嘅保證，都喺呢個矩陣之外。測過嘅託管 drain 係[聲明記錄](/reference/claims#native-grpc-drain-status)。

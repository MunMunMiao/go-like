# 串流處理

go-like 有三條串流邊界。

1. **公開 Web 串流**使用 Fetch 的 `Request` 與 `Response` body，以及 Web Streams API。
2. **內部服務呼叫**使用一個 Fetch 請求與一個 Fetch 回應。Unary 呼叫帶一份 JSON body。Server stream 設定 `stream: true`，並回傳 `text/event-stream`。這條路徑沒有 client-stream 或雙向 SPI。
3. **產生的 Protobuf RPC**用 `@go-like/connectrpc` 在 Fetch 上做 Connect 與 gRPC-Web，用 `@go-like/connectrpc/node` 做託管的標準 gRPC。可攜式 Fetch 涵蓋 unary 與 server-streaming。Node 入口涵蓋 unary、server-streaming、client-streaming 與 bidi。`@go-like/protoc-gen-like` 產生 ctx-first 的用戶端與 handler 接線程式碼。

`ReadableStream`、框架的 SSE 回應，或 WebSocket upgrade，都是 Web 串流。內部的 server stream 是 `POST /<service>/<endpoint>` 上的 SSE，並帶 `accept: text/event-stream`。

Node 26.12.1 與 Bun 1.4.4 的託管 gRPC 慢速消費者 drain，記錄在[原生 gRPC drain 矩陣](/reference/claims#native-grpc-drain-status)。較早的 Connect 2.1.2 與 Bun 1.4.2 Fetch 取消觀察，仍留在[聲明與證據](/reference/claims#stream-cancellation-limits)。產生的 RPC 不會加上串流重送。

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

串流格式、flush、SSE 慣例、WebSocket upgrade 與斷線政策，由應用程式或框架擁有。`contextHandler` 在 handler 回傳 `Response` 時結束它的 Context。長時間存活的 body 也應該觀察 `request.signal`。內部 RPC 的 Context 會活到回應 body 結束。

Hono、Elysia 與 H3 保留自己的串流與 WebSocket API。想要 App 生命週期時，把 `app.fetch` 傳給 `@go-like/core/web/node` 或 `@go-like/core/web/bun`。

## 內部 server stream

宣告 `stream: true`。Handler 是 async generator。用戶端用 `for await` 讀 `ServerStream`。`close()`、`await using`、`break` 與呼叫端取消都會中止請求。

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

`@go-like/core/server` 上的 `streamKeepAlive` 與 `maxSendMessageBytes` 限制 SSE comment 的間隔與 frame 大小。它們不改變呼叫形態。仍然是一份請求 body，以及一連串回應事件。

## 產生的 RPC

`@go-like/connectrpc` 匯出 `newHandler`、`callOptions` 與 `fromHandlerContext`。這個 handler 是給 Connect 與 gRPC-Web 用的 Fetch `Handler`。把它掛到 core 的 Web host 上，方式與其他 handler 相同。

`@go-like/connectrpc/node` 匯出 `newServer`、`newClient`，以及位址、advertise 與 TLS 選項。那個 server 是生命週期上的 `Server`，也是 server 層級的 `Endpointer`。把 `Discovery` 與 `Selector` 傳進去時，Node 用戶端會使用它們。這個入口上的標準 gRPC，是涵蓋 client-streaming 與 bidi 的那條路徑。

`@go-like/protoc-gen-like` 是 Buf 外掛。產生的程式碼 import `@go-like/core/context` 與 `@go-like/connectrpc`。產生器沒有 runtime 插座。

瀏覽器標準 gRPC、官方 gRPC health 與 reflection，以及對未來 runtime 的保證，都不在這個矩陣裡。已測試的託管 drain 是[聲明記錄](/reference/claims#native-grpc-drain-status)。

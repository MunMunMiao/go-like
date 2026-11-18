# 流式传输

go-like 有三条流式边界。

1. **对外 Web 流**使用 Fetch 的 `Request` 和 `Response` body，以及 Web Streams API。
2. **内部服务调用**使用一个 Fetch 请求和一个 Fetch 响应。Unary 调用携带一个 JSON body。服务端流设置 `stream: true` 并返回 `text/event-stream`。这条路径上没有客户端流或双向 SPI。
3. **生成的 Protobuf RPC**用 `@go-like/connectrpc` 在 Fetch 上做 Connect 和 gRPC-Web，用 `@go-like/connectrpc/node` 做托管的标准 gRPC。可移植 Fetch 覆盖 unary 和 server-streaming。Node 入口覆盖 unary、server-streaming、client-streaming 和 bidi。`@go-like/protoc-gen-like` 生成 ctx 在前的客户端和 handler 粘合代码。

`ReadableStream`、框架 SSE 响应或 WebSocket 升级是 Web 流。内部服务端流是 `POST /<service>/<endpoint>` 上、带 `accept: text/event-stream` 的 SSE。

Node 26.12.1 与 Bun 1.4.4 上的托管 gRPC 慢消费者排空记录在[原生 gRPC 排空矩阵](/reference/claims#native-grpc-drain-status)。更早的 Connect 2.1.2 与 Bun 1.4.2 Fetch 取消观察仍留在[声明与证据](/reference/claims#stream-cancellation-limits)。生成的 RPC 不增加流重放。

## 对外 Web 流

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

应用或框架拥有流格式、flush、SSE 约定、WebSocket 升级和断开策略。`contextHandler` 在 handler 返回 `Response` 时结束它的 Context。长期存活的 body 还应观察 `request.signal`。内部 RPC 的 Context 一直活到响应 body 结束。

Hono、Elysia 和 H3 保留自己的流和 WebSocket API。需要 App 生命周期时，把 `app.fetch` 传给 `@go-like/core/web/node` 或 `@go-like/core/web/bun`。

## 内部服务端流

声明 `stream: true`。Handler 是异步生成器。客户端用 `for await` 读取 `ServerStream`。`close()`、`await using`、`break` 和调用方取消都会中止请求。

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

`@go-like/core/server` 上的 `streamKeepAlive` 和 `maxSendMessageBytes` 限制 SSE 注释间隔和帧大小。它们不改变调用形态。仍然是一个请求 body，加上一串响应事件。

## 生成的 RPC

`@go-like/connectrpc` 导出 `newHandler`、`callOptions` 和 `fromHandlerContext`。该 handler 是给 Connect 和 gRPC-Web 用的 Fetch `Handler`。把它挂到 core Web 宿主上的方式，与任何其他 handler 相同。

`@go-like/connectrpc/node` 导出 `newServer`、`newClient`，以及地址、对外公布和 TLS 选项。该 server 是生命周期 `Server`，也是 server 层的 `Endpointer`。传入时，Node 客户端会使用 `Discovery` 和 `Selector`。这个入口上的标准 gRPC 才是覆盖 client-streaming 和 bidi 的路径。

`@go-like/protoc-gen-like` 是 Buf 插件。生成的代码导入 `@go-like/core/context` 和 `@go-like/connectrpc`。生成器没有运行时插座。

浏览器标准 gRPC、官方 gRPC 健康检查与反射，以及面向未来 runtime 的保证，都在这张矩阵之外。已测试的托管排空是[声明记录](/reference/claims#native-grpc-drain-status)。

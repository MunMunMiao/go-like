# `@go-like/transport-memory`

`@go-like/transport-memory` 是进程内的 Fetch Transport。同一个 `Request` / `Response` 对象从 Client `fetch` 交到 Listener `serve` 的 handler。它不注册全局 handler，不绕过 Discovery、Selector 或 Client middleware，也不提供 Registry provider。

## 显式所有权

每次 `newMemoryTransport()` 都创建一个私有 address namespace。Listener 与 Client 必须共享同一个 Transport 实例；不同实例即使使用相同 URL 也完全隔离。应用应在 composition root 显式持有该实例：

```ts
import { background } from "@go-like/context"
import { newMemoryTransport } from "@go-like/transport-memory"

const transport = newMemoryTransport()
const listener = await transport.listen(background(), "memory://orders")
const serving = listener.serve(background(), (_ctx, request) => {
  return new Response(request.body, {
    headers: { "content-type": "application/json" }
  })
})
const client = await transport.dial(background(), listener.addr())
const response = await client.fetch(
  background(),
  new Request("memory://orders/orders/get", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  })
)
await response.body?.cancel()
await client.close(background())
void serving
```

地址必须是无凭据、无 fragment 的绝对 `memory:` URL，并按标准 `URL.href` 规范化。供 `@go-like/client` 选择的节点地址还必须是根 URL。同一实例重复 listen 会 fail closed；dial 未绑定地址不会跨实例或回退网络。Listener close 开始时只释放自己持有的 map entry，因此其他 Listener 不受影响，原地址可以在旧 handler 排空期间重新绑定给新的 Listener。

`serve(ctx, handler)` 是 one-shot owner。handler 是 `(ctx, request) => Response | Promise<Response>`。请求 Context 活到 response body 结束、出错、客户端取消、deadline 或关闭，而不是 handler 返回的那一刻；body 结束后取消该 Context 并释放 deadline timer。客户端 abort 会取消服务端请求 Context。

## 并发与背压

一个 Client 可以发起多个并发 `fetch`。Memory 把客户端的下一次读取映射为服务端的一次 pull，生产最多领先消费一条。provider 没有额外后台 work queue。

每个 I/O 首先检查调用方 Context，已启动后的取消只终止当前等待或 exchange，不会关闭共享 Client 或无关 Listener。common `timeout` 与 dial `withTimeout` 取最早的非零值。`withConnClose` 在响应 body 结束后关闭逻辑 Client。TLS 与自定义 codec 在 memory provider 中没有真实语义，因此显式请求时返回 `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY`；不支持的选项不会被静默忽略。

该 provider 适合单进程服务组合、确定性集成测试和无需网络序列化的内部调用。跨进程通信应选择 `@go-like/transport-http`。

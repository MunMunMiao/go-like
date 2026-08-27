# `@go-like/transport-memory`

`@go-like/transport-memory` 是 go-like 内部 unary `Message` 的进程内 Transport provider。它完整实现
`@go-like/transport` 的 `Transport`、`Client`、`Listener` 与 `Socket` SPI，但不会注册全局 handler、不会绕过
Discovery/Selector/Client middleware，也不会提供 Registry provider。

## 显式所有权

每次 `newMemoryTransport()` 都创建一个私有 address namespace。Listener 与 Client 必须共享同一个 Transport
实例；不同实例即使使用相同 URL 也完全隔离。应用应在 composition root 显式持有该实例：

```ts
import { background } from "@go-like/context"
import { newMemoryTransport } from "@go-like/transport-memory"

const transport = newMemoryTransport()
const listener = await transport.listen(background(), "memory://orders")
const accepting = listener.accept(background(), async (ctx, socket) => {
  const request = await socket.recv(ctx)
  await socket.send(ctx, request)
})
const client = await transport.dial(background(), listener.addr())
```

地址必须是无凭据、无 fragment 的绝对 `memory:` URL，并按标准 `URL.href` 规范化。同一实例重复 listen 会
fail closed；dial 未绑定地址不会跨实例或回退网络。Listener close 开始时只释放自己持有的 map entry，因此其他
Listener 不受影响，原地址可以在旧 handler 排空期间重新绑定给新的 Listener。

Listener 的 `accept(ctx, handler)` 是 one-shot owner。每个 handler 获得从 accept Context 派生的 Context，并携带
server-side `TransportInfo(kind = "memory")`。accept 取消、Listener close、Client close 或 Socket close 都只取消
各自拥有的子资源；正常 close 在全部已接纳 handler 结束后才结算 accept。被动 provider failure 原样结算 accept，
普通 handler failure 只失败自己的 exchange。

## Message、并发与背压

Message 在 Client、Listener 和 Socket 的每个边界都使用 `snapshotMessage` 防御复制。一个 Client 可以发起多个并发
unary exchange；响应始终按 `send()` 调用顺序由 `recv()` 取得，即使 handler 的完成顺序不同。每个并发 `send()`
只保留自己的一份请求和响应，并等待该响应产生后才结算。FIFO response slot 在 `recv()` 时移除，但已接纳 exchange
会保留到 handler 终止，因此 Client close 即使发生在响应消费之后仍会取消对应 handler。provider 没有额外后台
work queue；总并发和内存上限由尚未 `recv()` 的 response slot 与尚未终止的 handler 共同决定。

每个 I/O 首先检查调用方 Context，已启动后的取消只终止当前等待或 exchange，不会关闭共享 Client 或无关
Listener。common `timeout` 与 dial `withTimeout` 取最早的非零值。`withConnClose` 在首个 `recv()` 后关闭逻辑
Client。TLS 与自定义 Message codec 在 memory provider 中没有真实语义，因此显式请求时返回
`GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY`；不支持的选项不会被静默忽略。

该 provider 适合单进程服务组合、确定性集成测试和无需网络序列化的内部调用。跨进程通信应选择
`@go-like/transport-http` 或其他真实 wire provider。

# 流式传输

go-like 直接采用 Web 平台已经有的流模型：请求就是标准 `Request`，响应就是标准 `Response`，body 可以是 `ReadableStream<Uint8Array>`。不会再造一套私有 Stream 类、帧协议 DSL，或者拿一次性 HTTP body 假装成可反复读写的双向 channel。

公开 HTTP streaming 归 `@go-like/web` 和原生框架 Handler。内部 `@go-like/client`、`@go-like/transport`
当前只提供 unary `Message` 调用，不再发布单独的 Fetch Transport 或 Stream Client API。

Web body 只能消费一次，所以中间件不要随便把 body 读掉；真要读取，就必须明确创建替代 body。取消通过第一个 `Context` 参数和请求 signal 传播。传输层会逐块检查数据是不是 `Uint8Array`，坏 chunk 会得到协议错误，而不是莫名其妙变成空数据。

对外 HTTP 请把框架的原生 Fetch Handler 交给 `@go-like/web`。Hono、Elysia、H3 的 SSE、流响应或 runtime 专属 WebSocket 升级仍由原框架处理，go-like 只保证 `Request`、`Response`、stream 和错误 identity 不被破坏。

`contextHandler` 在 Handler 返回 Response 时清理自己的 Context，而不是等 body 流结束。长时间运行的 producer 应观察 `request.signal`，或显式拥有独立取消作用域。

`@go-like/protoc-gen-like` 基于 Protobuf-ES 生成 Context-first Protobuf RPC 代码。`@go-like/transport-grpc-buf` 的 Fetch 入口支持 Connect/gRPC-Web 的 unary 和 server-streaming；`/native` 提供标准 gRPC 的四种调用形态，包括 client-streaming 和 bidi。这是独立于 unary Transport SPI 的调用路径。

互通测试不等于生产可靠性：Deno 2.9.5/2.9.7 的慢消费者流在 drain 时失败；Connect 2.1.2 在外部取消暂停读取的响应流后保留 deadline 定时器；Bun 1.4.2 的 Fetch 取消未传到首个 chunk 后保持静默的服务端。详见[证据与限制](/reference/claims#stream-cancellation-limits)，go-like 尚未修复这些外部问题。

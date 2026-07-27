# 流式传输

LikeGo 直接采用 Web 平台已经有的流模型：请求就是标准 `Request`，响应就是标准 `Response`，body 可以是 `ReadableStream<Uint8Array>`。不会再造一套私有 Stream 类、帧协议 DSL，或者拿一次性 HTTP body 假装成可反复读写的双向 channel。

公开 HTTP streaming 归 `@likego/web` 和原生框架 Handler。内部 `@likego/client`、`@likego/transport`
当前只提供 unary `Message` 调用，不再发布单独的 Fetch Transport 或 Stream Client API。

Web body 只能消费一次，所以中间件不要随便把 body 读掉；真要读取，就必须明确创建替代 body。取消通过第一个 `Context` 参数和请求 signal 传播。传输层会逐块检查数据是不是 `Uint8Array`，坏 chunk 会得到协议错误，而不是莫名其妙变成空数据。

对外 HTTP 请走 `@likego/web` 和你选的框架适配。Hono、Elysia、H3 的 SSE、流响应或 runtime 专属 WebSocket 升级仍由原框架处理，LikeGo 只保证 `Request`、`Response`、stream 和错误 identity 不被破坏。

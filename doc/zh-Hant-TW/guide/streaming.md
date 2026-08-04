# 串流處理

go-like 直接採用 Web 平台現成的串流模型：請求是標準 `Request`，回應是標準 `Response`，body 可以使用 `ReadableStream<Uint8Array>`。不會另做一套私有 Stream 類別、frame DSL，或把一次性 body 包裝成看似能重複讀寫的雙向通道。

公開 HTTP streaming 歸 `@go-like/web` 與原生框架 Handler。內部 `@go-like/client`、`@go-like/transport`
目前只提供 unary `Message` 呼叫，不再發布另一套 Fetch Transport 或 Stream Client。

Web body 只能消耗一次，中介層若要讀取，就必須清楚提供替代 body。取消透過第一個 `Context` 參數及 request signal 傳遞；傳輸層逐段確認 chunk 是 `Uint8Array`，不合法資料會變成協定錯誤，不會被吞成空內容。

面向外部的 HTTP 請用 `@go-like/web` 搭配原本的框架。Hono、Elysia、H3 的 SSE、串流回應或 runtime 專屬 WebSocket 升級仍交給原生框架，go-like 只維持 `Request`、`Response`、stream 與錯誤 identity。

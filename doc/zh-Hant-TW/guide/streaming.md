# 串流處理

go-like 直接採用 Web 平台現成的串流模型：請求是標準 `Request`，回應是標準 `Response`，body 可以使用 `ReadableStream<Uint8Array>`。不會另做一套私有 Stream 類別、frame DSL，或把一次性 body 包裝成看似能重複讀寫的雙向通道。

公開 HTTP streaming 歸 `@go-like/web` 與原生框架 Handler。內部 `@go-like/client`、`@go-like/transport`
目前只提供 unary `Message` 呼叫，不再發布另一套 Fetch Transport 或 Stream Client。

Web body 只能消耗一次，中介層若要讀取，就必須清楚提供替代 body。取消透過第一個 `Context` 參數及 request signal 傳遞；傳輸層逐段確認 chunk 是 `Uint8Array`，不合法資料會變成協定錯誤，不會被吞成空內容。

面向外部的 HTTP 請用 `@go-like/web` 搭配原本的框架。Hono、Elysia、H3 的 SSE、串流回應或 runtime 專屬 WebSocket 升級仍交給原生框架，go-like 只維持 `Request`、`Response`、stream 與錯誤 identity。

`contextHandler` 在 Handler 回傳 Response 時清理自己的 Context，不會等 body 串流結束。長時間執行的 producer 應觀察 `request.signal`，或明確擁有獨立取消範圍。

`@go-like/protoc-gen-like` 基於 Protobuf-ES 產生 Context-first Protobuf RPC 程式碼。`@go-like/transport-grpc-buf` 的 Fetch 入口支援 Connect/gRPC-Web unary 與 server-streaming；`/native` 提供標準 gRPC 的四種呼叫形態，包含 client-streaming 與 bidi。這是獨立於 unary Transport SPI 的路徑。

互通測試不等於正式環境可靠性：Deno 2.9.5/2.9.7 的慢速消費者串流在 drain 時失敗；Connect 2.1.2 在外部取消暫停讀取的回應串流後保留 deadline 計時器；Bun 1.4.2 的 Fetch 取消未傳到首個 chunk 後保持靜默的伺服器。詳見[證據與限制](/reference/claims#stream-cancellation-limits)，go-like 尚未修復這些外部問題。

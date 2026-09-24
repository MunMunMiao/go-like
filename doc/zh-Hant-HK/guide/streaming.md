# 串流傳輸

go-like 直接用 Web 平台本身嘅串流模型：請求係標準 `Request`，回應係標準 `Response`，body 可以係 `ReadableStream<Uint8Array>`。唔會另造私有 Stream class、frame DSL，亦唔會將一次性 body 包成好似可以重複讀寫嘅雙向 channel。

公開 HTTP streaming 歸 `@go-like/web` 同原生框架 Handler。內部 `@go-like/client`、`@go-like/transport`
而家只提供 unary `Message` 呼叫，唔再發布另一套 Fetch Transport 或 Stream Client。

Web body 只可以消費一次，中介層如果要讀，就要明確提供替代 body。取消透過第一個 `Context` 參數同 request signal 傳播；transport 逐段確認 chunk 係 `Uint8Array`，壞資料會變成協議錯誤，唔會靜靜雞變成空內容。

對外 HTTP 請用 `@go-like/web` 配合原本框架。Hono、Elysia、H3 嘅 SSE、串流回應或者 runtime 專屬 WebSocket upgrade 繼續由原生框架處理，go-like 只保持 `Request`、`Response`、stream 同 error identity。

`contextHandler` 喺 Handler 返回 Response 時就會清理自己嘅 Context，唔會等 body stream 結束。長時間運行嘅 producer 應監察 `request.signal`，或者明確擁有獨立取消範圍。

`@go-like/protoc-gen-like` 基於 Protobuf-ES 產生 Context-first Protobuf RPC 程式碼。`@go-like/transport-grpc-buf` 嘅 Fetch 入口支援 Connect/gRPC-Web unary 同 server-streaming；`/native` 提供標準 gRPC 四種呼叫方式，包括 client-streaming 同 bidi。呢條路徑獨立於 unary Transport SPI。

互通測試唔等於 production 可靠性：Deno 2.9.5/2.9.7 慢消費者流喺 drain 時失敗；Connect 2.1.2 喺外部取消暫停讀取嘅回應流後保留 deadline timer；Bun 1.4.2 嘅 Fetch 取消未傳到首個 chunk 後保持靜默嘅 server。詳見[證據同限制](/reference/claims#stream-cancellation-limits)，go-like 未修復呢啲外部問題。

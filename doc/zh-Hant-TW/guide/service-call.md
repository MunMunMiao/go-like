# 服務呼叫

一次內部 unary 呼叫是幾個小元件的組合。`@likego/client` 把 `Discovery` 快照交給 `Selector`，再透過 `Transport` 完成一次 `send` 與 `recv`。建立 Client 時使用 functional options：

```ts
import { newClient, withDiscovery, withFilter, withSelector, withTransport } from "@likego/client"
import { filterLabel, filterVersion, type Filter } from "@likego/registry"

const client = newClient(
  withDiscovery(discovery),
  withSelector(selector),
  withTransport(serviceTransport)
)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
const reply = await client.call(
  ctx,
  {
    service: "orders",
    endpoint: "Orders.Get",
    message: { header: {}, body: requestBytes }
  },
  withFilter(...filters)
)
```

`Filter`、`filterVersion(...)` 與 `filterLabel(...)` 都屬於 Registry 根入口；Filter 會在 `Selector.select` 前依宣告順序執行。純直連只需要 `newClient(withTransport(serviceTransport))`，`withAddress(...)` 會略過 Discovery 與 Selector。設定 Discovery 的 Client 會依服務名稱延遲建立 watcher，並從最新完整快照選擇節點。只有確認操作可安全重播，或已經明確核准後，才以 `withRetry(...)` 設定有限 attempts、失敗分類與可選 backoff；每次獲准的 retry 都會從最新快照重新選擇，預設每次 call 只嘗試一次。不再使用 Client 時呼叫 `client.close(ctx)`。`closeTimeout(...)` 只限制邏輯 Transport Client 的清理時間，實體連線重用由 Transport 與 runtime 負責。

`@likego/server` 把業務 handler 對應到 Transport，並公開實際 bind 位址。建立 options 包含 `transport(...)`、`address(...)`、`handler(service, endpoint, fn)`、`middleware(...)` 與 `listenOption(...)`；最後一項會把 provider 專屬 `ListenOption` 傳給 `Transport.listen`。`endpoint(ctx)` 與 `start(ctx)` 共用同一次真實 bind。設定為 `newApp(registrar(registry), server(serviceServer))` 的 Core App，會把這個 endpoint 當成應用程式的 `ServiceInstance` 統一發布與撤銷。

每次 unary attempt 都會把 client-side `TransportInfo` 注入交給 Transport 的 Context，內容包含實際 target、穩定的 `service/endpoint` operation 與真實 wire headers。Server 會在呼叫業務 handler 前注入對應的 server-side 值。Client 與 Server 透過有界且規範的 `Likego-Metadata` envelope 編碼多值 Context metadata；Transport provider 只需將它當成不透明的 Message header。`propagateToClientContext(...)` 只會依照明確的 `exact` 或 `prefix` allowlist，把 server metadata 傳到下游。

Transport SPI 的角色與 go-micro 一致：`Transport`、`Client`、`Listener`、`Socket`。`@likego/transport-http` 同時實作 client 與 server，並以標準 Fetch 表達 wire。只有 owned feedback 與邏輯 Transport Client close 都完成，response 才會直接回傳。如果業務交換完成，但其中一個後置步驟失敗，原生 `AggregateError` 會把 response 保留在 `cause`，再依序把 feedback 或 close 錯誤放入 `errors`；這類清理錯誤不會重試。

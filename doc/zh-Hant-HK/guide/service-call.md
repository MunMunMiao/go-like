# 服務呼叫

一次內部 unary 呼叫由幾個小元件砌成。`@likego/client` 將 `Discovery` 快照交畀 `Selector`，再經 `Transport` 完成一次 `send` 同 `recv`。建立 Client 時使用 functional options：

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

`Filter`、`filterVersion(...)` 同 `filterLabel(...)` 都屬於 Registry 根入口；Filter 會喺 `Selector.select` 之前按聲明次序執行。純直連只需要 `newClient(withTransport(serviceTransport))`，`withAddress(...)` 會繞過 Discovery 同 Selector。配置 Discovery 嘅 Client 會按服務名懶建立 watcher，並由最新完整快照揀節點。只有確認操作可以安全重播，或者已經明確批准之後，先用 `withRetry(...)` 設定有限 attempts、失敗分類同可選 backoff；每次獲准嘅 retry 都會由最新快照重新選擇，預設每次 call 只試一次。唔再使用 Client 時要呼叫 `client.close(ctx)`。`closeTimeout(...)` 只限制邏輯 Transport Client 嘅清理時間，實體連線重用由 Transport 同 runtime 負責。

`@likego/server` 將業務 handler 配對到 Transport，並提供實際 bind 地址。建立 options 包括 `transport(...)`、`address(...)`、`handler(service, endpoint, fn)`、`middleware(...)` 同 `listenOption(...)`；最後一項會將 provider 專屬 `ListenOption` 交畀 `Transport.listen`。`endpoint(ctx)` 同 `start(ctx)` 共用同一次真實 bind。配置為 `newApp(registrar(registry), server(serviceServer))` 嘅 Core App，會將呢個 endpoint 當成應用嘅 `ServiceInstance` 統一發布同撤銷。

每次 unary attempt 都會將 client-side `TransportInfo` 注入交畀 Transport 嘅 Context，內容包括實際 target、穩定嘅 `service/endpoint` operation 同真實 wire headers。Server 會喺呼叫業務 handler 之前注入對應嘅 server-side 值。Client 同 Server 透過有界而規範嘅 `Likego-Metadata` envelope 編碼多值 Context metadata；Transport provider 只需當佢係不透明嘅 Message header。`propagateToClientContext(...)` 只會按照顯式 `exact` 或 `prefix` allowlist 將 server metadata 傳落下游。

Transport SPI 角色同 go-micro 一致：`Transport`、`Client`、`Listener`、`Socket`。`@likego/transport-http` 同時支援 client 同 server，以標準 Fetch 表達 wire。只有 owned feedback 同邏輯 Transport Client close 都完成，response 先會直接返回。如果業務交換完成，但其中一個後置步驟失敗，原生 `AggregateError` 會將 response 保留喺 `cause`，再按次序將 feedback 或 close 錯誤放入 `errors`；呢類清理錯誤唔會重試。

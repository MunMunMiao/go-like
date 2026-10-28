# 服務呼叫

一次內部 unary 呼叫由幾個小元件砌成。`@go-like/client` 將 `Discovery` 快照交畀 `Selector`，再經 `Transport` 完成一次 `fetch`。建立 Client 時使用 functional options：

```ts
import type { Context } from "@go-like/context"
import {
  newClient,
  withDiscovery,
  withEndpoint,
  withFilter,
  withSelector,
  withTransport,
  type CallRequest
} from "@go-like/client"
import {
  filterLabel,
  filterVersion,
  newRoundRobinSelector,
  type Discovery,
  type Filter
} from "@go-like/registry"
import type { Transport } from "@go-like/transport"

declare const ctx: Context
declare const discovery: Discovery
declare const serviceTransport: Transport
declare const requestBytes: Uint8Array

const client = newClient(
  withDiscovery(discovery),
  withEndpoint("discovery:///orders"),
  withSelector(newRoundRobinSelector()),
  withTransport(serviceTransport)
)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
const request: CallRequest = {
  service: "orders",
  endpoint: "get",
  headers: { "content-type": "application/json" },
  body: requestBytes
}
const reply = await client.call(ctx, request, withFilter(...filters))
void reply
```

`Filter`、`filterVersion(...)` 同 `filterLabel(...)` 都屬於 Registry 根入口；Filter 會喺 `Selector.select` 之前按宣告順序執行。直連目標要喺構造時用 `newClient(withTransport(serviceTransport), withEndpoint(serviceAddress))`；`withEndpoint(...)` 會繞過 Discovery，但仍然經過同發現快照相同嘅 Selector。配置 Discovery 嘅 Client 要同時用 `withEndpoint("discovery:///<name>")` 同 `withDiscovery(discovery)`，再按服務名懶建立 watcher，並由最新完整快照揀節點。go-like 預設每次 call 只試一次；只有操作可以安全重播，或者呼叫方已提供明確 replay authorization，先可以用 `withRetry(...)`。呢個 option 必須保留 `authorization: "idempotent" | "caller-approved"`、正數嘅總 `maxAttempts` 同 `shouldRetry` failure predicate。`authorization` 係呼叫方嘅宣告，唔係 go-like 證明業務操作具冪等性；收到 response 後嘅 feedback 或 cleanup failure 亦唔會重播。唔再使用 Client 時要呼叫 `client.close(ctx)`。`closeTimeout(...)` 只限制邏輯 Transport Client 嘅清理時間，實體連線重用由 Transport 同 runtime 負責。

`@go-like/server` 將業務 handler 配對到 Transport，並提供實際 bind 地址。用 `transport(...)`、`address(...)`、`middleware(...)` 同 `listenOption(...)` 建立 Server，再喺啟動之前透過 `server.registerHandler(...)` 註冊 route；`listenOption(...)` 會將 provider 專屬 `ListenOption` 交畀 `Transport.listen`。`endpoint(ctx)` 同 `start(ctx)` 共用同一次真實 bind。配置為 `newApp(registrar(registry), server(serviceServer))` 嘅 Core App，會將呢個 endpoint 當成應用嘅 `ServiceInstance` 統一發布同撤銷。

每次 unary attempt 都會將 client-side `TransportInfo` 注入交畀 Transport 嘅 Context，內容包括實際 target、穩定嘅 `service/endpoint` operation 同真實 wire headers。Server 會喺呼叫業務 handler 之前注入對應嘅 server-side 值。Client 同 Server 透過有界而規範嘅 `Go-Like-Metadata` envelope 編碼多值 Context metadata；Transport provider 只需當佢係不透明嘅 Fetch header。`propagateToClientContext(...)` 只會按照顯式 `exact` 或 `prefix` allowlist 將 server metadata 傳落下游。

呼叫會等 feedback，同邏輯 Transport Client 歸還 pool 或按需要關閉。成功 client 預設可以重用，`poolSize(0)` 先會停用保留。收到 response 後清理失敗，`AggregateError.cause` 會保留 response，`errors` 按次序保存清理錯誤，唔會因此重播業務呼叫。唔再用 owner 時呼叫 `client.close(ctx)`。

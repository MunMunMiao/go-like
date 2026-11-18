# 服務呼叫

一次內部服務呼叫係一次 Fetch 交換。操作名稱同傳輸位址係兩個唔同嘅值。有型別呼叫喺 JSON body 上加 Struct 驗證。產生出嚟嘅 Protobuf RPC 係另一條路徑；見[串流](/zh-Hant-HK/guide/streaming)。

## 操作身份同位址

`defineService("appointment-policy.v1", { check })` 將操作命名為 `appointment-policy.v1/check`。`withEndpoint("memory://appointment-policy.v1")` 同 `address("memory://appointment-policy.v1")` 講 bytes 去邊。Registry 嘅 `ServiceInstance` 將傳輸 URL 存放喺 `endpoints`。Filter 同 selector 喺呢啲 URL 之間揀。佢哋唔揀操作。

## 有型別嘅 Memory Transport

兩邊用同一個 `newMemoryTransport()`。佢係程序內而且實例私有。呢個係 `examples/healthcare-appointments` 嘅形狀：

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { name, newApp, server } from "@go-like/core"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService, serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const math = defineService("math", {
  add: {
    request: struct.object({ left: struct.number(), right: struct.number() }),
    response: struct.object({ sum: struct.number() })
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://math"))
math.registerHandler(rpc, {
  add(_ctx, request) {
    if (!Number.isFinite(request.left) || !Number.isFinite(request.right)) {
      throw serviceError("math_rejected", "operands must be finite", 400)
    }
    return { sum: request.left + request.right }
  }
})

const client = newClient(withTransport(transport), withEndpoint("memory://math"))
const api = math.newClient(client)
const app = newApp(name("math"), server(rpc))
const running = app.run()
await rpc.endpoint(background())
try {
  const result = await api.add(background(), { left: 2, right: 3 })
  console.log(result.sum)
} finally {
  await client.close(background())
  await app.stop()
  await running
}
```

`service.registerHandler` 喺啟動之前綁定每個有型別 handler。`service.newClient(client).add(ctx, value)` 驗證請求同回應。`client.close(ctx)` 係應用清理。喺真實程序，由 `afterStop` 關閉 client，並由 `app.run()` 擁有壽命。

`newHTTPTransport()` 係可攜 Fetch client。佢唔監聽。Node listener 喺 server 同 Node client 兩邊都用 `@go-like/core/transport/http/node` 嘅 `newNodeHTTPTransport()`。將 `newHTTPTransport()` 傳畀 `newServer` 可以通過型別檢查，然後喺 listen 時以 `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY` 失敗。

`@go-like/core/server` 同 `@go-like/core/client` 都匯出 `middleware` 同 `use`。一個檔案兩邊都要時，將其中一個當 namespace import。

## 一次嘗試

預設呼叫只做一次嘗試。Client 建立 `content-type: application/json` 嘅 `POST`，撥出或重用一個 transport，然後讀回應。符合服務錯誤信封嘅非 2xx JSON body 會變成 `ServiceError`。讀 `code`、`status` 或 `metadata` 之前，用 `@go-like/core/transport` 嘅 `isServiceError` 認出佢。`ServiceError.code` 由應用擁有。佢唔係 `GO_LIKE_*` 代碼。

原始 `client.call` 接收 `{ service, endpoint, headers, body }`，返回 Fetch `Response`。呼叫方讀 body 或者取消佢。

Metadata 行喺 Context 上。`@go-like/core/metadata` 提供 `newClientContext`、`fromServerContext` 同 `propagateToClientContext`。傳遞係明確嘅。除非 handler 自己做，傳入 metadata 唔會抄去下一跳。

## 服務探索、filter 同選擇

`@go-like/core/registry` 嘅 `newDiscoveryResolver` 監看一個服務，並保持一份完整替換快照。空快照係權威嘅：選擇以 `GO_LIKE_NO_AVAILABLE_ENDPOINT` 失敗，而唔會重用之前嘅實例。

```ts
import { newClient, withDiscovery, withEndpoint, withSelector } from "@go-like/core/client"
import { newP2CSelector } from "@go-like/core/registry"

const client = newClient(
  withDiscovery(registry),
  withEndpoint("discovery:///pricing"),
  withSelector(newP2CSelector())
)
void client
```

`withDiscovery` 接收 `Discovery`。Client 建立私人 resolver。只有應用程式碼要喺 client 之外攞快照時，先呼叫 `newDiscoveryResolver(discovery)`。同一個 Discovery 上兩個 resolver 唔共用 watcher。

Filter 係純函數而且有次序。`filterVersion` 同 `filterLabel` 係內建，每次呼叫用 `withFilter` 傳入。Selector 係 `newRoundRobinSelector`、`newWeightedRoundRobinSelector`、`newRandomSelector`、`newP2CSelector` 同 `newEWMASelector`。P2C 同 EWMA 喺嘗試之後接收同步 feedback。呢個狀態同 `circuitBreakerMiddleware` 分開；後者將 breaker 鍵到一個操作。

`withBlock()` 等到第一個非空快照。直接 `withEndpoint` 位址清單係靜態快照，仍然經過 selector。`withEndpoint("discovery:///name")` 命名要監看嘅服務。

## 重試係重播授權

`@go-like/core/client` 嘅 `withRetry` 要求：

- `authorization`：`"idempotent"` 或 `"caller-approved"`；
- `maxAttempts`：正整數，計埋第一次嘗試；
- `shouldRetry(ctx, error, attempt)` 返回 boolean。

授權係呼叫方嘅宣告。Core 唔檢查副作用。每次嘗試都重新進入服務探索同選擇。已經收到回應，之後先出現 feedback 或清理失敗，唔會重播。

`@go-like/core/resilience` 嘅 `retry` 同 `exponentialBackoff` 係同一個想法，畀 client 之外嘅應用程式碼用。`newCircuitBreaker` 同 `circuitBreakerMiddleware` 喺呼叫方定義嘅失敗上打開。`circuitOpen` 係 breaker 打開期間拋出嘅 sentinel。`newTokenBucketLimiter` 同 `rateLimitMiddleware` 拒絕超出嘅呼叫。

## 清理

- 喺 `afterStop` 關閉 client 同設定 watcher，或者用 `newResourceServer` 接納原生連線。
- 呼叫保留請求 Context。用 `background()` 換走佢會掉取消同而家嘅 span。
- 用 sentinel、`isServiceError` 或有文件嘅 `code` 對失敗。訊息留畀診斷。目錄係[錯誤處理](/reference/errors)。

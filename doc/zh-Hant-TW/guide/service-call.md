# 服務呼叫

一次內部服務呼叫就是一次 Fetch 交換。操作名稱與傳輸位址是不同的值。帶型別的呼叫會在 JSON body 上加上 Struct 驗證。產生的 Protobuf RPC 是另一條路徑；見[串流處理](/zh-Hant-TW/guide/streaming)。

## 操作身分與位址

`defineService("appointment-policy.v1", { check })` 把操作命名為 `appointment-policy.v1/check`。`withEndpoint("memory://appointment-policy.v1")` 與 `address("memory://appointment-policy.v1")` 指出位元組要送到哪裡。Registry 的 `ServiceInstance` 把傳輸 URL 放在 `endpoints`。篩選與 selector 在那些 URL 之中選擇。它們不選擇操作。

## 帶型別的 Memory Transport

兩邊使用同一個 `newMemoryTransport()`。它只在這個程序裡，而且每個實例私有。這是 `examples/healthcare-appointments` 裡的形狀：

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

`service.registerHandler` 在啟動前綁定每個帶型別的 handler。`service.newClient(client).add(ctx, value)` 驗證請求與回應。`client.close(ctx)` 是應用程式的清理。在真實程序裡，從 `afterStop` 關閉用戶端，並讓 `app.run()` 擁有生命週期。

`newHTTPTransport()` 是可攜的 Fetch 用戶端。它不監聽。Node listener 在 server 與 Node 用戶端兩邊都使用 `@go-like/core/transport/http/node` 的 `newNodeHTTPTransport()`。把 `newHTTPTransport()` 傳給 `newServer` 可以通過型別檢查，然後在 listen 時以 `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY` 失敗。

`@go-like/core/server` 與 `@go-like/core/client` 都匯出 `middleware` 與 `use`。同一個檔案兩邊都需要時，把其中一個當成 namespace import。

## 一次嘗試

預設呼叫只做一次嘗試。用戶端建立一個 `content-type: application/json` 的 `POST`，撥出或重用一個 transport，然後讀取回應。符合服務錯誤信封的非 2xx JSON body 會變成 `ServiceError`。讀取 `code`、`status` 或 `metadata` 之前，先用 `@go-like/core/transport` 的 `isServiceError` 辨認它。`ServiceError.code` 由應用程式擁有。它不是 `GO_LIKE_*` code。

原始的 `client.call` 接受 `{ service, endpoint, headers, body }`，並回傳 Fetch `Response`。呼叫端讀取 body，或取消它。

Metadata 走在 Context 上。`@go-like/core/metadata` 提供 `newClientContext`、`fromServerContext` 與 `propagateToClientContext`。傳遞是明確的。進來的 metadata 不會複製到下一跳，除非 handler 自己這樣做。

## 服務探索、篩選與選擇

`@go-like/core/registry` 的 `newDiscoveryResolver` 監看一個服務，並保留一份完整替換快照。空快照具有權威：選擇會以 `GO_LIKE_NO_AVAILABLE_ENDPOINT` 失敗，而不是重用先前的實例。

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

`withDiscovery` 接受 `Discovery`。用戶端會建立一個私有的 resolver。只有當應用程式的程式碼需要用戶端之外的快照時，才呼叫 `newDiscoveryResolver(discovery)`。同一個 Discovery 上的兩個 resolver 不共用 watcher。

篩選是純的，而且有順序。內建的是 `filterVersion` 與 `filterLabel`，用 `withFilter` 按次呼叫傳入。Selector 是 `newRoundRobinSelector`、`newWeightedRoundRobinSelector`、`newRandomSelector`、`newP2CSelector` 與 `newEWMASelector`。P2C 與 EWMA 在嘗試之後接受同步 feedback。那個狀態與 `circuitBreakerMiddleware` 分開；後者把斷路器鍵在一個操作上。

`withBlock()` 等待第一份非空快照。直接的 `withEndpoint` 位址清單是一份靜態快照，仍然會經過 selector。`withEndpoint("discovery:///name")` 指出要監看的服務名稱。

## 重試是重送授權

`@go-like/core/client` 的 `withRetry` 要求：

- `authorization`：`"idempotent"` 或 `"caller-approved"`；
- `maxAttempts`：正整數，把第一次嘗試算進去；
- `shouldRetry(ctx, error, attempt)` 回傳布林值。

這份授權是呼叫端的宣告。Core 不檢查副作用。每一次嘗試都會重新進入服務探索與選擇。已經收到回應，其後的 feedback 或清理失敗，不會被重送。

`@go-like/core/resilience` 裡的 `retry` 與 `exponentialBackoff` 是同一種想法，給用戶端之外的應用程式使用。`newCircuitBreaker` 與 `circuitBreakerMiddleware` 在呼叫端定義的失敗上打開。`circuitOpen` 是斷路器打開時丟出的 sentinel。`newTokenBucketLimiter` 與 `rateLimitMiddleware` 拒絕超量的呼叫。

## 清理

- 在 `afterStop` 關閉用戶端與設定 watcher，或用 `newResourceServer` 接納一條原生連線。
- 呼叫時保留請求 Context。把它換成 `background()` 會丟掉取消與目前的 span。
- 用 sentinel、`isServiceError` 或文件中的 `code` 對上失敗。訊息留給診斷。目錄是[錯誤處理](/reference/errors)。

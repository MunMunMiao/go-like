# go-like 與其他工具的比較

公平的比較應該從所有權開始，而不是從功能數量清單開始。這裡的所有權，是指誰建立資源、誰負責停止它，以及誰觀察它的終態。NestJS、Fastify、Hono、Elysia、Koa 與 tRPC 解決的是 TypeScript 應用程式堆疊的不同部分。go-micro 與 go-kratos 是 Go 生態的框架參考，它們在 transport 和程式碼產生上也有不同選擇。go-like 則是一組面向 TypeScript 的建構元件，強調明確的生命週期、內部 unary 呼叫、provider 契約與跨 runtime 組合。

本頁把證據分成幾個層級：

- **Source**：目前 go-like checkout 暴露了所述 API 或邊界。
- **Pinned external**：比較使用研究記錄中固定的 release、commit 或官方文件。這不是新跑的 benchmark，也不表示未固定版本的 `main` 分支沒有變動。
- **Declared**：repository 中有範例或測試 lane。這不等於該 lane 已通過。
- **Gap**：目前 repository 沒有證明相容性承諾。

本軌道使用的 go-like source baseline 是 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`。本地研究記錄中存在一個 go-micro commit 不一致：一筆比較記錄寫的是 `9d306dcfc1a912a8a9493f31fee0bb983475258d`，而詳細的固定版本備忘錄檢查的是 `v6.9.0` 的 `3c39d17fadaa9ec21b671be4afef3e63846406e6`。請把它們視為需要重新核對的比較輸入，不要把它們當成目前 upstream 的保證。

## 在技術堆疊中的位置

| 工具      | 主要解決的問題                       | 通常由它擁有的部分                                                                                                                                                       | go-like 可以補充、但不取代的部分                                                           |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| NestJS    | 依慣例驅動的 Node 應用程式框架       | Modules、providers、controllers、decorators、application context、framework lifecycle、HTTP 或 microservice adapter                                                      | 圍繞原生應用增加結構式 lifecycle boundary 或 internal call contract，前提是自行撰寫 bridge |
| Fastify   | Node HTTP server 與請求處理 pipeline | Route table、hooks、plugins、encapsulation、Node listener、request/reply objects                                                                                         | 圍繞 Fastify 擁有的資源增加 lifecycle 或 provider adapter                                  |
| Hono      | Web Standards 路由與 middleware      | Routes、middleware、sub-apps、`app.fetch`、runtime adapter 選擇                                                                                                          | Core App、明確的資源生命週期、內部 Client/Transport、服務探索                              |
| Elysia    | Bun 優先的 typed Web framework       | Route tree、schema 組合、decorators、hooks、Bun 或 Web Standard adapter                                                                                                  | 保留原生 Elysia 行為的同時增加 Core lifecycle 和內部 service building blocks               |
| Koa       | 精簡的 Node middleware kernel        | Middleware stack 與 Node listener；router 通常由外部提供                                                                                                                 | 不再引入另一套路由器的前提下補上 lifecycle 和內部 service contract                         |
| tRPC      | 型別安全的 procedure layer           | Router/procedure paths、input/output parsers、context factory、HTTP/Fetch/WS adapters                                                                                    | Provider ownership、service discovery、selector policy、明確的 App lifecycle               |
| go-micro  | Go 微服務與 agent-oriented 生態      | Go Context、service/client/transport/registry/broker 抽象，以及額外的 agent/flow/MCP/A2A 範圍                                                                            | go-like 借用部分詞彙，不借用 Go ABI、goroutine 或 transport 相容性                         |
| go-kratos | Go 雲原生服務框架                    | App lifecycle、Go Context、HTTP/gRPC transports、middleware、registry、config、Protobuf/code generation                                                                  | go-like 共用明確的生命週期詞彙，但刻意選擇 TypeScript/Web API，不提供 gRPC/IDL             |
| go-like   | 明確的 TypeScript 服務建構元件       | Context、App/Server lifecycle、standard Fetch edge、內部 unary Message transport、Client/Server、Registry/Discovery/Selector、Config/Store/Cache/Broker/Health、adapters | 應用程式仍擁有框架路由、原生資料面、業務策略、auth（身分驗證與授權）與部署                 |

因此，go-like 並不是要贏一場「誰的框架最大」的比較。真正的問題是：應用程式是否需要這些邊界保持明確，而且可以組合。

## 所有權矩陣

| 關注點                 | NestJS                                        | Fastify                            | Hono / Elysia / Koa                                         | tRPC                                         | go-like                                                         |
| ---------------------- | --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| 外部 route table       | Controllers 與 decorators                     | Fastify instance                   | Framework instance 或外部 router                            | Procedure router，不是一般 REST routes       | 外部 framework 或 application                                   |
| Web handler ABI        | Adapter 擁有的 request/reply abstraction      | Node request/reply                 | 對 Hono 與 Web Standard adapter 而言，Standard Fetch 是核心 | Fetch/Node/Express/Fastify adapters          | 標準的 `(Request) => Response \| Promise<Response>`             |
| Application lifecycle  | Application context 與 hooks                  | `ready`、`listen`、`close`、hooks  | Runtime adapter 與 framework lifecycle 各不相同             | 由 host/adapter 負責                         | `newApp`、`App.run`、`App.stop`、hooks、結構式 Servers          |
| Resource lifecycle     | Container/framework hooks                     | Plugin 與 server hooks             | 由 application/runtime 負責                                 | 由 application/adapter 負責                  | 明確的 `Server.start(ctx)` / `stop(ctx)` 契約與 adapter 所有權  |
| Dependency composition | Nest container/providers                      | Plugin decoration 與 encapsulation | Context/env 與組合；沒有通用 DI container                   | 明確的 context factory 與 router composition | 明確的 constructors 與 functional options；沒有 DI container    |
| Internal transport     | Microservice transports 與 framework adapters | 不是 service discovery 抽象        | 不是 service discovery 抽象                                 | Procedure adapters 與可選 WebSocket          | `Transport`、`Client`、`Listener`、`Socket`、unary `Message`    |
| Discovery 與 selection | Transport-specific 或外部提供                 | 外部提供                           | 外部提供                                                    | 外部提供                                     | `Registry`、`Discovery`、`Watcher`、Filters、五種 Selector 策略 |
| Retry                  | Framework 或 provider-specific                | Application/plugin-specific        | Application-specific                                        | Middleware/adapter-specific                  | 預設一次；`withRetry` 需要授權與總嘗試次數                      |
| Streaming              | Framework/provider 選擇                       | Node/Web stream 選擇               | 原生 Web Streams 與 framework API                           | 取決於 adapter 的 HTTP/WS                    | 對外 Web streaming 是原生能力；內部 RPC 仍為 unary              |
| Global instrumentation | Framework/provider integration                | Plugin ecosystem                   | Middleware ecosystem                                        | Middleware/adapters                          | 明確的 wrapper；不安裝 global provider                          |

前五列的標籤描述的是架構位置，不是品質排名。框架擁有 route table，在路由組合是主要問題時很有用；這只是和 go-like 把路由留給應用程式所做的不同所有權選擇。

## Lifecycle 與 Context

目前 go-like source 定義了：

```ts
interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}
```

`Server` 契約是結構式的。只要 adapter 能誠實說明資源如何被接納、終態如何產生，原生 worker、listener、scheduler、訊息代理 subscription、logger destination 或 telemetry provider 都可以加入 Core。

go-like Context 同樣是結構式的，內部使用 `AbortSignal`。它暴露 `deadline()`、`done()`、`err()` 和 `value(key)`，並提供 `background`、`withCancel`、`withCancelCause`、`withTimeout`、`withDeadline`、`withoutCancel` 與 `withValue` 等建構函式。

這和 Go 的明確 Context-first 風格相似，但與 `context.Context` 並不 ABI-compatible。它不提供 goroutines、channels 或 gRPC。正確的遷移問題應該是「取消和所有權在哪裡跨過這個邊界？」，而不是「哪個型別名稱完全一樣？」

Core 不承諾 sibling Servers 按宣告的反向順序關閉。它會並行呼叫 sibling `stop(ctx)`，接著等待 terminal `start` Promises 並彙整失敗。Nest application context、Fastify plugin graph、Elysia lifecycle 或 host adapter 可能有不同的順序與終態語意。比較時要看真正的擁有者，不要只看「graceful」這個標籤。

## Transport 與服務呼叫

go-like 的內部呼叫鏈是刻意拆開的：

```text
Client
  -> Discovery snapshot, optional
  -> ordered Filter callbacks, optional
  -> Selector.select
  -> opaque ServiceEndpoint URL
  -> Transport.dial or resident logical owner
  -> send(Message)
  -> @go-like/server route and unary handler
  -> recv(Message)
  -> feedback and owner release
```

typed `Endpoint` 把 `Struct` request/response validation 綁到既有的 `Message` 邊界。它不是 IDL，也不是產生式 protocol。`withAddress(...)` 會繞過 Discovery 與 Selector，因此程序內 Memory Transport 路徑很適合作為第一個測試。

NestJS 的 microservice transport 選項、tRPC procedure adapter 與 Go framework transport，都不能直接和這張 DAG 互換。它們可能擁有不同的 route identity、serialization model、connection pool 或 retry layer。比較時應記錄這些差異，不要把所有名字裡有「RPC」的方框都當成同一種能力。

## Retry 與 streaming 範圍

最重要的反向比較是語意：

- go-like 預設每次呼叫只嘗試一次。
- `withRetry(...)` 要求提供 `authorization: "idempotent" | "caller-approved"`、正數的 `maxAttempts` 與 `shouldRetry`。
- 這個 authorization 是呼叫方的宣告，不是系統證明操作具有冪等性。
- 每次重試都會重新進入 discovery 與 selection，因此可能選到新的 endpoint。
- 如果已經收到 response，但後續 feedback 或 cleanup 失敗，不會重新 replay 這次 response。

Go 比較研究記錄了不同的預設值與能力：go-micro 的 `DefaultRetries` 不能簡單說成「總共五次請求」，因為當 retry approval 仍為 true 時，它的 loop boundary 可能產生六次迭代；它的 public stream 形式與預設 `CloseSend` 實作也會隨 provider 改變。go-kratos 把 Protobuf/gRPC generation 與 HTTP streaming 形式結合，而 SSE 與 WebSocket 的方向和關閉行為並不相同。這些是 provider 與架構選擇，不是 go-like 少了幾個 flag。

對 go-like 來說：

```text
Web framework or Fetch Handler
  -> Web Streams, SSE, or WebSocket behavior owned by the application/framework

go-like internal Client/Transport
  -> one unary Message request and one unary Message response
  -> no full-duplex RPC Stream SPI
```

Web `ReadableStream` 不是內部 RPC channel。不要把 streamed HTTP body 和多幀的 `send`／`recv` transport 當成同一個 feature。

## Runtime 比較

| Runtime 問題                                             | go-like 證據                                                                                        | 比較時的結論                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 共用程式碼能否使用 Fetch 與 `AbortSignal`？              | Root Web 與選定的 transport/config provider 使用標準 Web API 或注入的 Fetch                         | 可以有相近的可攜性目標，但型別不會替 runtime 實作行為 |
| 同一個 package 能否綁定 Node listener 與 Deno listener？ | Runtime-specific 子路徑是明確的；`@go-like/web/node` 與 `@go-like/transport-http/node` 是 Node 路徑 | 不要寫「所有套件到處都能原樣執行」                    |
| 自訂 PEM TLS、mTLS、ALPN 與 HTTP/2 能否透過 Fetch 可攜？ | Node transport 子路徑擁有原生能力；root Fetch path 不暴露所有控制項                                 | 應比較 host 能力與 import path，而不只是 package 名稱 |
| 應用程式是否保留 framework router？                      | Hono、Elysia 與 H3 範例都傳入原生 Fetch handler                                                     | go-like 是 framework route ownership 的補充           |
| package version 是否證明已經發布？                       | Root 與 packages 都是 private/workspace `0.0.1`；repository 文件說明尚未發布                        | 不能據此聲稱 npm 可用或生態成熟                       |

目前 repository 有 Hono、Elysia、H3 與 vanilla Fetch 的直接 source 範例。沒有目前的 NestJS 或 Fastify bridge，也沒有對應的 compatibility suite。這些框架是遷移讀者的對象，不是已支援的直接整合。

## 按工具詳細比較

### NestJS

NestJS 是依慣例驅動的應用程式框架。它的 modules、providers、controllers、decorators、interceptors、pipes 與 application hooks 共同組成完整的 container 與 request model。go-like 沒有提供 Nest-compatible module container 或 controller bridge。

合理的整合邊界，是由應用程式自行圍繞 Nest application 或 host 實作一個結構式 `Server` adapter。這個 adapter 需要定義 Nest 何時已接納 listener、`stop(ctx)` 如何對應 Nest close，以及 timeout 後會發生什麼。目前 repository 沒有證明這類 bridge，因此文件不應展示直接呼叫 `newNodeServer(nestApp, ...)`。

### Fastify

Fastify 擁有 route table、plugin encapsulation、hooks 與 Node listener。它的 plugin graph 很適合拿來比較 dependency scope，但 `decorate` 不是 Nest 風格的通用 provider container。go-like 不會自動把 Fastify 的 `request`／`reply` ABI 轉成 Fetch Handler，repository 目前也沒有測試 Fastify bridge。

保留 Fastify 的 routes 與 plugins。如果導入 go-like，就圍繞 Fastify owner 撰寫明確的結構式 Server，或自行實作獨立的 Fetch boundary。不要把 Fastify 自己的 request injection 或原生 shutdown 稱為 go-like Transport 或 Client 契約。

### Hono

Hono 是目前已展示最清楚的互補關係。現有範例在 Hono 中建立 routes，把 `app.fetch` 傳給 `newNodeServer`，再把這個 host 放進 Core App。路由與 middleware 仍由 Hono 擁有；在應用程式選擇這樣做時，go-like 負責 host lifecycle boundary。

### Elysia

Elysia 提供 Bun-first 的 route 與 schema composition，也在相關 adapter path 暴露 Web Standard handler。保留 Elysia 的 route tree、decorators、derives、hooks、streams 與 Bun-specific behavior。go-like 可以擁有 App 與明確的資源邊界，但不會把 `.listen()` 變成跨 runtime 的 go-like API。

### Koa

Koa 是小型的 Node middleware kernel，不內建 router。這正好說明有些框架會刻意把更多 application composition 留在核心之外。go-like 不應該透過增加 router 來填補這個空缺。保留 Koa middleware 與外部 router，只在需要的地方增加 lifecycle 或內部呼叫邊界。

### tRPC

tRPC 擁有型別安全的 procedure router 與 procedure middleware。它可以使用 Fetch、Node、Express、Fastify 或 WebSocket adapter，但它不是 Registry、Selector、connection pool 或 application lifecycle manager。go-like 的 typed Endpoint 是對 unary Message 做的較小 runtime Struct binding，不是另一個 procedure DSL，也不是產生式 IDL。

### go-micro 與 go-kratos

這兩個 Go 專案可以作為 Context-first 呼叫、service lifecycle、Registry、Discovery、Selector 與 transport 詞彙的架構參考，但不是相容性目標：

- Go `context.Context` 與 go-like `Context` 都強調明確取消，但 runtime 表示不同。
- go-micro 的 Registry watcher model 與 go-like 的完整替換 snapshot，不應該被教成相同的 event stream。
- go-kratos 的 Protobuf/gRPC 與 generated code 是一種架構選擇，go-like 明確不做這項承諾。
- go-micro 與 go-kratos 的 provider 預設值、retry loop、stream half-close 行為與 selector 預設值都與版本有關。發布新的比較版本前，應使用研究記錄中的 fixed upstream commit table 重新核對。

## 怎麼選

| 如果你的主要問題是……                            | 先從……開始            | 在這些情況下再加 go-like                                               |
| ----------------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| Controllers、modules、decorators 和 DI          | NestJS                | 需要圍繞現有資源或內部服務呼叫增加明確邊界，而且願意自行撰寫 adapter   |
| Node HTTP routes、hooks 和 plugin encapsulation | Fastify               | 需要超出 host 的生命週期組合，或需要內部 unary service contract        |
| 跨 runtime 的 Web Standards routes              | Hono                  | 需要 App/Server lifecycle、內部呼叫或 provider ownership               |
| Bun-first 的 schema 和 route composition        | Elysia                | 保留 Elysia 的同時，需要明確的 lifecycle 和 transport boundary         |
| 精簡的 Node middleware                          | Koa 加上一個 router   | 需要補的是缺少的 lifecycle 或內部呼叫契約，而不是再加一個 router       |
| 型別安全的 procedures                           | tRPC                  | 同時需要明確的 service discovery、provider ownership 或 Core lifecycle |
| Go 微服務堆疊                                   | go-micro 或 go-kratos | 正在建立獨立的 TypeScript 組合，而不是做 source-compatible port        |
| 跨 runtime 的 TypeScript 服務建構元件           | go-like               | 只使用能解決目前邊界問題的 packages 與 providers                       |

正確答案可能是兩套系統一起使用。當明確的所有權模型確實消除了一個實際歧義時，go-like 最有價值；一個已經完整的 framework application 若把每個 package 都加進來，就會違背小型建構元件的目標。

## 證據錨點

本頁對 go-like 的判斷可以追溯到目前的 tree 與 package entrypoints：

- `README.md`：產品範圍與明確排除項；
- `packages/core/src/app.ts`：`App`、`Server`、startup、stop 與 timeout 行為；
- `packages/web/src/context.ts`：標準 Handler 與 Context bridge；
- `packages/client/src/index.ts`：Client options、pooling、retry 與 attempt pipeline；
- `packages/server/src/index.ts`：內部 unary handlers 與 route dispatch；
- `packages/transport/src/types.ts` 與 `packages/transport/src/endpoint.ts`：Message 與 typed Endpoint 邊界；
- `packages/registry/src/types.ts` 與 `packages/registry/src/selector.ts`：snapshots、filters、selectors 與 feedback。

研究記錄也保存了以下固定版本的外部比較輸入：

- [repository 記錄的 go-micro comparison commit](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)；
- [go-kratos v3 comparison commit](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)；
- [go-zlab/go-kratos comparison commit](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336)；
- [NestJS lifecycle documentation](https://docs.nestjs.com/fundamentals/lifecycle-events)、[Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/)、[Hono API](https://hono.dev/docs/api/hono)、[Elysia lifecycle](https://elysiajs.com/essential/life-cycle)、[Koa](https://koajs.com/) 與 [tRPC routers](https://trpc.io/docs/server/routers)。

這些 URL 是比較參考，不表示本次文件階段重新抓取或重新驗證了每個 upstream 頁面。修改與版本相關的比較陳述前，請重新核對 release tag 或 commit。

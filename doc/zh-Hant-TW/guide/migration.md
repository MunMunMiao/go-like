# 遷移與導入

最穩妥的遷移原則是：**保留資料面，導入你能清楚說明的邊界**。這裡的資料面，指的是實際處理請求、訊息或工作的那部分系統。

保留現有的 Web 框架、worker、排程器、訊息代理、logger 或 telemetry provider（具體實作）。針對一個真實的生命週期或服務呼叫問題，加上一個明確的 go-like 契約。確認這個邊界成立後，再導入下一個 provider。

## 分階段遷移

1. 保持現有的啟動流程，以及路由／資料面程式碼不變。
2. 找出一個明確的擁有者：listener、worker、排程器、訊息代理訂閱、logger 輸出端或 telemetry provider。
3. 增加結構式 `Server` adapter，或使用既有的 go-like adapter。定義資源如何被接納、如何停止、等待多久，以及在哪裡觀察終態。
4. 在真正發生取消或 deadline 控制的邊界導入 `@go-like/context`，它提供帶有取消訊號、deadline 與 context value 的 Context，並把它當作操作的第一個參數往下傳。
5. 使用 `@go-like/health` 與 `@go-like/web/health` 增加 liveness 和 readiness 檢查。
6. 在測試中先用 `@go-like/transport-memory` 加上一個內部 typed unary call（帶型別的單請求／單回應呼叫）。
7. 只有在確實需要網路線路或原生 Node host 時，才把這個呼叫切換到 `@go-like/transport-http` 或 `@go-like/transport-http/node`。
8. 一次只增加一項能力：Registry、Config、Store、Cache、Broker、logging、metrics 或 tracing。
9. 為每個新邊界記錄 provider、runtime、擁有者與證據通道。

不要一開始就重寫整個服務。小型契約的價值，就在於遷移單位可以維持很小。

## 框架遷移矩陣

| 現有系統 | 保留原生部分                                                          | 優先導入                                                                 | 目前的邊界                                                                          |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| NestJS   | Modules、controllers、decorators、DI、interceptors、pipes、adapter    | 在現有應用外包一層自訂結構式 Server，或建立獨立的內部 Client/Server 邊界 | 目前 repository 沒有 go-like Nest bridge，也沒有自動 DI 整合                        |
| Fastify  | Routes、plugins、hooks、request/reply、原生 listener                  | 自訂生命週期 wrapper，或明確實作的 Fetch bridge                          | 目前沒有證據證明 Fastify request/reply 能自動轉換成 go-like Handler                 |
| Hono     | Routes、middleware、sub-apps、`app.fetch`                             | `newNodeServer(app.fetch, ...)`，再接到 `newApp(...)`                    | `examples/hono` 展示了直接使用原生 Fetch 的整合方式                                 |
| Elysia   | Route tree、schema、decorators、derives、hooks、Bun/Web Standard 行為 | 在適合的情況下使用原生 `app.fetch` 加上 Core host/lifecycle              | 保留 Bun 專屬的 `.listen()` 語意；不要把它說成跨 runtime 的 go-like API             |
| H3       | H3 router 與原生 handler 轉換                                         | 目前 H3 範例中的 Fetch handler 路徑                                      | 目前展示的是 H3 2.x 的 `app.fetch`；舊版 `toWebHandler` 指引需要獨立固定版本的範例  |
| Koa      | Middleware 與外部 router                                              | 自訂擁有者 wrapper，或內部服務呼叫                                       | `@go-like/web` 不會直接接收 Koa 的 Node request/reply 物件，除非應用自行提供 bridge |
| tRPC     | Router、procedure middleware、輸入／輸出解析器、adapter               | 在 host 外圍加上 Core lifecycle，或使用獨立的內部 transport 邊界         | go-like Endpoint 不是 tRPC procedure router                                         |

### Hono 範例

這是 repository 已經展示的整合方式：

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/web/node"

const web = new Hono().get("/users/:id", (c) => c.json({ id: c.req.param("id") }))

const app = newApp(name("users"), server(newNodeServer(web.fetch, port(3000))), signal())

await app.run()
```

目前的 Hono 範例保留 Hono 的路由擁有權，把原生 Fetch handler 交給 Node host。它沒有新增 go-like route table，也沒有 Hono 專用的 bridge 套件。

### Elysia 與 H3

對於暴露標準 Fetch handler 的框架，可以採用相同的邊界：

```text
framework route table
  -> framework native Fetch handler
  -> @go-like/web/node (when using the Node host)
  -> @go-like/core App
```

在匯入 Node 子路徑前，先檢查框架使用的 runtime adapter。Elysia 的 Bun adapter 與 Web Standard adapter 的 listen 行為並不完全相同；H3 的版本與 handler 轉換 API 也需要固定版本的範例。不要因為存在一個範例，就承諾所有框架版本或 runtime 組合都能運作。

## Go 服務遷移

如果你熟悉 Go 或 Kratos，遷移時應該遷移概念，而不是照抄拼法：

| Go 概念           | go-like 概念                                                                                                       | 重要差異                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `context.Context` | `@go-like/context` `Context`                                                                                       | `done()` 回傳的是 `AbortSignal` 或 null，不是 Go channel              |
| Server lifecycle  | Core 結構式 `Server`                                                                                               | `start(ctx)` 可能長時間維持執行，不等於 readiness                     |
| App runner        | `newApp`、`App.run`、`App.stop`                                                                                    | `App.stop()` 沒有呼叫端 Context，並回傳一個共用的 Promise             |
| RPC client        | `@go-like/client`                                                                                                  | 內部呼叫是 unary `Message`；retry 預設關閉                            |
| Transport         | `@go-like/transport`                                                                                               | Provider 與 Message headers 都是 TypeScript/Web 契約                  |
| Registry          | `@go-like/registry`                                                                                                | Watcher 回傳完整替換後的 snapshot                                     |
| Selector          | `newRoundRobinSelector`、`newRandomSelector`、`newWeightedRoundRobinSelector`、`newP2CSelector`、`newEWMASelector` | feedback 是同步的，而且取決於具體策略                                 |
| Protobuf/IDL      | go-like 沒有對應能力                                                                                               | `Endpoint` + `Struct` 是 runtime validation，不是產生式 schema 程式碼 |
| gRPC stream       | go-like 目前沒有對應能力                                                                                           | 對外 Web streaming 與內部 unary transport 是兩回事                    |

一個適合漸進遷移的第一步，是用 Memory Transport 做一次直連位址的 typed call：

```ts
const transport = newMemoryTransport()
const server = newServer(
  serverTransport(transport),
  address("memory://pricing"),
  handler(pricingEndpoint, pricingHandler)
)
const client = newClient(withTransport(transport))

const result = await client.call(ctx, pricingEndpoint, request, withAddress("memory://pricing"))
```

先把這個邊界測通，再引入 Discovery、真正的 Registry provider 或 HTTP transport。這樣替換的是目的地與所有權接線，領域契約仍然保持穩定。

## Kubernetes 導入

Kubernetes 的原生能力繼續由 Kubernetes 負責：

- Deployment、Service、DNS、Ingress、RBAC、探針、發布策略、HPA 與 network policy 仍是平台責任；
- `@go-like/config-kubernetes` 透過注入的 Fetch capability，從一個 namespace 內的 ConfigMap 或 Secret 讀取一個 key；
- `@go-like/registry-kubernetes` 在確實需要直接探索時使用 EndpointSlice 記錄；
- EndpointSlice 不是 Kubernetes Service DNS，也不會提供通用的註冊 TTL；
- 可選的 Pod owner reference 與明確註銷具有不同的故障語意。

先導入 health 與 configuration，再處理直接的 EndpointSlice selection。如果應用已有穩定的 Service DNS 名稱，`withAddress(...)` 加上 HTTP transport 可能比引入 Registry provider 更簡單，也更符合實際。

## 訊息代理與工作導入

保留原生的 settlement 語意與工作策略：

| 現有資料面     | 保留                                                             | 用 go-like 增加                                                      |
| -------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| NATS Core      | Connection、subscription、queue group、`Msg`、drain              | `newNatsCoreServer`、`newNatsCoreBroker`、生命週期與位元組邊界       |
| NATS JetStream | Stream、durable consumer、`JsMsg`、ack/nak/term、redelivery、DLQ | `newNatsJetStreamServer`、`newNatsJetStreamBroker`、生命週期         |
| RabbitMQ       | Connection、topology、confirm policy、channel                    | 借用或復原中的 subscriber lifecycle，以及 generation-safe 的原生結算 |
| BullMQ         | Queue、Worker、processor、retry/backoff、Redis                   | 圍繞官方 dormant Worker 使用 `newBullMqWorkerServer`                 |
| Croner         | Cron expression、time zone、callback、overlap policy             | 圍繞暫停狀態的原生 Cron jobs 使用 `newCronerServer`                  |
| Memory Broker  | 程序內 topic map 與測試語意                                      | `newBrokerServer` 與可選的 event codec                               |

不要把 NATS ack/nak/term、JetStream durable settlement、RabbitMQ confirmations 或 BullMQ retries 搬進通用的 go-like Broker 抽象。正因為這些語意重要，provider 的原生物件才應該繼續可見。

## 狀態遷移

一次只遷移一個狀態領域：

- Config 用於不可變的程序設定快照與 reload；
- Registry 用於暫時性的服務可達性；
- Store 用於權威記錄、revision、CAS、TTL 與分頁；
- Cache 用於可以重新計算的可丟棄值。

一個實用的遷移測試，是寫下程序重啟、讀到過期資料、provider 故障、watcher compaction、CAS 衝突和 cache miss 後會發生什麼。如果答案不同，它們就不應該共用一個通用 repository interface。

## 增加可觀測性

先建立原生 provider，再包住邊界：

```text
application creates logger / Registry / MeterProvider / TracerProvider
  -> go-like wrapper records bounded operation facts
  -> application-owned exporter or destination
  -> explicit Core lifecycle adapter closes the admitted resource
```

`@go-like/prometheus` 不使用 global registry。`@go-like/otel` 不會安裝 global providers 或 exporters。Pino 與 Winston adapter 不會取代原生 logger 設定。讓 labels 與 attributes 保持有界，並另外為應用自有的 log 設定脫敏策略。

## 遷移驗收清單

合併一個邊界前，確認：

- 有一個命名清楚的擁有者；
- 擁有者拿到正確的 Context，且不會用 `background()` 取代它；
- 啟動接納與 readiness 是兩個不同概念；
- stop timeout 的行為已按等待邊界寫清楚；
- 原生終態觀察能力仍然保留（如果 provider 有提供）；
- 外部 Web handler 與內部 unary handler 沒有混用；
- retry 授權符合業務操作；
- credentials、metadata、log 與 trace attributes 有脫敏策略；
- provider 專屬語意仍然可見；
- 目標 checkout 中的 focused unit/typecheck 指令已通過；
- 相關 runtime、provider、published 或 example E2E 指令要嘛已執行並記錄，要嘛明確標示為未執行。

## 目前支援邊界

repository 目前有 vanilla Fetch、Hono、Elysia、H3、Memory Transport、typed internal calls、health、brokers、workers 與 observability adapter 的直接範例。它沒有證明 NestJS 或 Fastify 的自動 bridge、gRPC/Protobuf/IDL 相容性、全雙工內部 stream、通用身分驗證或部署編排能力。這些都需要獨立的 adapter、測試與產品承諾。

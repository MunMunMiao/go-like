# go-like 與其他工具的比較

公平的比較從擁有權開始。NestJS、Fastify、Hono、Elysia、Koa 與 tRPC 各自解決 TypeScript 應用程式的不同部分。go-micro 與 go-kratos 是 Go 的參照，傳輸與程式碼產生都不相同。go-like 是一塊插座面板：明確的生命週期層級、內部呼叫，以及你所選後端的插頭。

本頁的證據標籤：

- **Source** 表示目前的 checkout 暴露了這個 API。
- **Pinned external** 表示一份已記錄的發布、commit 或官方頁面。它不是一輪新的評測。
- **Declared** 表示存在一個範例或測試。它不是通過結果。
- **Gap** 表示這個 repository 沒有證明一項相容承諾。

歷史文件基準是 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`。研究記錄裡有兩個 go-micro commit：`9d306dcfc1a912a8a9493f31fee0bb983475258d`，以及 v6.9.0 備忘用的 `3c39d17fadaa9ec21b671be4afef3e63846406e6`。兩者都當作要重新核對的輸入。

## 在堆疊中的位置

| 工具      | 它通常擁有的部分                                             | go-like 放在旁邊的部分                                            |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| NestJS    | Module、controller、decorator、應用程式 context              | 只有在你自己寫那個 adapter 時，才有一個結構式 `Server`            |
| Fastify   | 路由、hook、plugin、Node listener                            | 繞著 Fastify 仍然擁有的資源，加一條生命週期或呼叫邊界             |
| Hono      | 路由、middleware、`app.fetch`                                | App 層級、內部呼叫、插頭                                          |
| Elysia    | 路由樹、schema、hook、它自己的 adapter                       | 同樣這些，同時 `.listen()` 仍屬於 Elysia                          |
| Koa       | Middleware 與外部 router                                     | 生命週期與內部呼叫，不是另一個 router                             |
| tRPC      | Procedure、解析器、adapter                                   | 服務探索、選擇，以及 App 生命週期                                 |
| go-micro  | Go Context、service、registry、broker，以及更寬的 agent 表面 | 只有詞彙。沒有 Go ABI                                             |
| go-kratos | App 生命週期、HTTP/gRPC、registry、config、Protobuf          | 一份 TypeScript 組裝。gRPC 路徑是 Connect-ES，不是 Google runtime |
| go-like   | 插座、層級、Fetch 與 SSE 呼叫、插頭                          | 路由、政策、授權與原生協定細節仍由應用程式擁有                    |

## 擁有權

| 關注點       | go-like                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| 對外路由     | 框架或應用程式的 `Handler`                                                                  |
| Web handler  | `(Request) => Response \| Promise<Response>`                                                |
| 程序生命週期 | `newApp`、三個層級、hook                                                                    |
| 依賴         | 建構函式與選項。沒有容器                                                                    |
| 內部呼叫     | `Transport`、`Client`、`Server`、`defineService`、SSE `ServerStream`                        |
| 服務探索     | `Registry`、`Discovery`、篩選、五個 selector                                                |
| 重試         | 一次嘗試，除非 `withRetry` 授權更多次                                                       |
| 串流         | 邊緣使用 Web Streams；內部是 JSON 或 SSE；`@go-like/connectrpc/node` 上有四種 gRPC 呼叫形態 |
| 觀測埋點     | Core 記錄工作單元。插頭填入 telemetry 插座。沒有全域註冊                                    |

## 生命週期與 Context

```ts
import type { Server } from "@go-like/core/lifecycle"

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

type Lifecycle = Server
void null as unknown as Lifecycle
```

`Server` 是結構式的：`start(ctx)` 與 `stop(ctx)`。在 resource 層級，`start` 在資源可用時 resolve。在 server 層級，`start` 可以一直 pending，兄弟的停止並行執行。資源的停止依宣告的反向順序執行。Nest context、Fastify plugin 圖或 Elysia hook 有自己的順序。比較的是擁有者，而不是 graceful 這個詞。

Context 暴露 `deadline()`、`done()`、`err()` 與 `value(key)`，以及 `background`、`withCancel`、`withTimeout`、`withDeadline`、`withoutCancel` 與 `withValue`。它內部使用 `AbortSignal`。它不是 Go 的 `context.Context`，也不是一套 gRPC API。

## 呼叫、重試與串流

內部路徑是 Client、可選的 Discovery、篩選、selector、transport、`POST /<service>/<endpoint>`，然後是 server handler。帶型別的 Endpoint 用 Struct 驗證 JSON。它不是 IDL。`withEndpoint("discovery:///name")` 選擇一個服務。直接的位址清單不會。

呼叫只做一次嘗試，除非 `withRetry` 把 `authorization` 設成 `"idempotent"` 或 `"caller-approved"`，給出正的 `maxAttempts`，並給出 `shouldRetry`。那份授權是一項宣告。已經收到的回應，不會因為後來的 feedback 失敗而被重送。

```text
Web Handler
  Web Streams, framework SSE, or WebSocket

@go-like/core client and server
  one JSON body, or SSE when stream: true

@go-like/connectrpc
  Connect and gRPC-Web unary and server-streaming on Fetch

@go-like/connectrpc/node
  standard gRPC unary, server-streaming, client-streaming, and bidi
```

go-micro 的預設重試迴圈與 go-kratos 的 HTTP 串流形式都跟版本有關。發布一份依賴它們的比較之前，先重新核對那些釘選的 commit。

## Runtime

共用入口使用 Fetch 與 `AbortSignal`，或一項注入的能力。自訂 TLS、HTTP/2 與 mTLS 住在 `@go-like/core/transport/http/node` 與 `@go-like/connectrpc/node`。Hono、Elysia、H3 與一般 Fetch 範例把 Fetch handler 傳給 core host。這個 repository 裡沒有 NestJS 或 Fastify bridge。Manifest 版本 `0.0.1` 不能證明 npm 已發布。

## 依工具

**NestJS。** Module、provider 與 controller 仍屬於 Nest。整合方式是在 Nest 應用程式外圍放一個由應用程式擁有的 `Server`，並有明確的接納與關閉。這個 repository 不包含那個 adapter。

**Fastify。** 路由、封裝與 listener 仍屬於 Fastify。go-like 不會把 `request` / `reply` 轉成 Fetch `Handler`。

**Hono。** `examples/hono` 把 `app.fetch` 傳給 `newNodeServer`，再把那個 host 放進 `server(...)`。路由留在 Hono。

**Elysia。** 保留路由樹與 Bun 專屬行為。範例把 Fetch handler 配上 Node host。`.listen()` 不是 go-like API。

**Koa。** 保留 middleware 與外部 router。只在你能說出擁有者的地方，加上生命週期或呼叫邊界。

**tRPC。** Procedure 仍屬於 tRPC。go-like 的 Endpoint 是 JSON Fetch 上的 Struct，不是 procedure router。

**go-micro 與 go-kratos。** 它們是 Context 優先呼叫、生命週期與服務探索詞彙的參照。go-like 裡的 watcher 產出完整替換快照。託管 gRPC 入口是 `@go-like/connectrpc/node`。

## 怎麼選

使用那個真正擁有你手上問題的框架。缺的是接納、取消、服務探索，或一份有具名擁有者的後端契約時，再加一個 go-like 插座。把每一個插頭都裝進一個已經完成的框架應用程式，就去掉了小契約的好處。

## 證據錨點

目前的樹：

- `packages/core/src/app/app.ts` 與 `packages/core/src/app/tiers.ts`：層級、時間預算與停止順序；
- `packages/core/src/lifecycle/index.ts`：`Server` 與 `Endpointer`；
- `packages/core/src/web/context.ts`：`Handler` 與 `contextHandler`；
- `packages/core/src/client/index.ts`：呼叫選項、服務探索與重試；
- `packages/core/src/server/index.ts`：內部分派；
- `packages/core/src/transport/service.ts`：`defineService`；
- `packages/core/src/registry/selector.ts`：篩選、selector 與 feedback；
- `packages/connectrpc/src/node.ts`：託管 gRPC。

釘選的外部輸入，這次文件修訂沒有重新驗證：

- [go-micro comparison commit](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)；
- [go-micro v6.9.0 commit](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6)；
- [go-kratos v3 commit](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)；
- [go-zlab/go-kratos commit](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336)；
- [NestJS lifecycle](https://docs.nestjs.com/fundamentals/lifecycle-events)、[Fastify server](https://fastify.dev/docs/latest/Reference/Server/)、[Hono](https://hono.dev/docs/api/hono)、[Elysia lifecycle](https://elysiajs.com/essential/life-cycle)、[Koa](https://koajs.com/)、[tRPC routers](https://trpc.io/docs/server/routers)。

用來比較而記錄下來的第三方 TypeScript 版本，不是相容承諾：NestJS `@nestjs/core@11.1.28`、Fastify `5.11.2`、Hono `4.12.34`、Elysia `1.4.29`、Koa `3.2.1`、tRPC `@trpc/server@11.18.0`。Elysia 範例的 manifest 是那個範例的釘選；這張表是研究快照。

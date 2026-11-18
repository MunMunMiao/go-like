# go-like 同其他工具嘅比較

公平比較由 ownership 開始。Ownership 即係邊個建立資源、邊個負責停佢、邊個觀察終態。NestJS、Fastify、Hono、Elysia、Koa 同 tRPC 解決 TypeScript 應用唔同嘅部分。go-micro 同 go-kratos 係 Go 參考，transport 同程式碼產生都唔同。go-like 係一塊插座面板：明確嘅生命週期層、內部呼叫，同你揀嘅後端插頭。

呢頁嘅證據標籤：

- **Source** 代表而家呢個 checkout 暴露咗該 API。
- **Pinned external** 代表記錄咗嘅 release、commit 或官方頁面。佢唔係新跑嘅 benchmark。
- **Declared** 代表有 example 或測試存在。佢唔係通過結果。
- **Gap** 代表呢個 repo 冇證明相容承諾。

歷史文件基線係 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`。研究記錄有兩個 go-micro commit：`9d306dcfc1a912a8a9493f31fee0bb983475258d`，以及 v6.9.0 備忘用嘅 `3c39d17fadaa9ec21b671be4afef3e63846406e6`。兩個都當需要重新核對嘅輸入。

## 喺技術堆疊入面嘅位置

| 工具      | 通常擁有咩                                                   | go-like 喺隔離加咩                                                |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| NestJS    | Module、controller、decorator、application context           | 只有你自己寫該 adapter 時，先有一個結構式 `Server`                |
| Fastify   | 路由、hook、plugin、Node listener                            | 圍住 Fastify 仍然擁有嘅資源，加一條生命週期或呼叫邊界             |
| Hono      | 路由、middleware、`app.fetch`                                | App 層、內部呼叫、插頭                                            |
| Elysia    | 路由樹、schema、hook、佢自己嘅 adapter                       | 同一樣，同時 `.listen()` 仍然係 Elysia 嘅                         |
| Koa       | Middleware 同外部 router                                     | 生命週期同內部呼叫，而唔係另一個 router                           |
| tRPC      | Procedure、parser、adapter                                   | 服務探索、選擇同 App 生命週期                                     |
| go-micro  | Go Context、service、registry、broker，以及更闊嘅 agent 表面 | 只係詞彙。冇 Go ABI                                               |
| go-kratos | App 生命週期、HTTP/gRPC、registry、config、Protobuf          | 一份 TypeScript 組合。gRPC 路徑係 Connect-ES，唔係 Google runtime |
| go-like   | 插座、層、Fetch 同 SSE 呼叫、插頭                            | 應用仍然擁有路由、政策、auth 同原生協議細節                       |

## Ownership

| 關注點          | go-like                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| 外部路由        | 框架或應用 `Handler`                                                                |
| Web Handler     | `(Request) => Response \| Promise<Response>`                                        |
| 程序生命週期    | `newApp`、三層、hook                                                                |
| 依賴            | 建構函式同 option。冇容器                                                           |
| 內部呼叫        | `Transport`、`Client`、`Server`、`defineService`、SSE `ServerStream`                |
| 服務探索        | `Registry`、`Discovery`、filter、五種 selector                                      |
| 重試            | 一次嘗試，除非 `withRetry` 授權更多                                                 |
| 串流            | 邊緣係 Web Streams；內部係 JSON 或 SSE；`@go-like/connectrpc/node` 上四種 gRPC 基數 |
| Instrumentation | Core 記錄工作單元。插頭填遙測插座。冇全域註冊                                       |

## 生命週期同 Context

```ts
import type { Server } from "@go-like/core/lifecycle"

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

type Lifecycle = Server
void null as unknown as Lifecycle
```

`Server` 係結構式嘅：`start(ctx)` 同 `stop(ctx)`。喺資源層，`start` 喺資源可用時 resolve。喺 Server 層，`start` 可以一直 pending，sibling stop 並行運行。資源 stop 按宣告嘅反向次序行。Nest context、Fastify plugin graph 或 Elysia hook 有自己嘅次序。比較持有者，而唔係「graceful」呢個字。

Context 暴露 `deadline()`、`done()`、`err()` 同 `value(key)`，以及 `background`、`withCancel`、`withTimeout`、`withDeadline`、`withoutCancel` 同 `withValue`。佢內部用 `AbortSignal`。佢唔係 Go `context.Context`，亦唔係 gRPC API。

## 呼叫、重試同串流

內部路徑係 Client、可選 Discovery、filter、selector、transport、`POST /<service>/<endpoint>`，然後 server handler。有型別端點用 Struct 驗證 JSON。佢唔係 IDL。`withEndpoint("discovery:///name")` 選擇一個服務。直接位址清單就唔係。

除非 `withRetry` 將 `authorization` 設為 `"idempotent"` 或 `"caller-approved"`、正數 `maxAttempts`，以及 `shouldRetry`，否則呼叫只做一次嘗試。呢個授權係宣告。已經收到嘅回應，喺之後嘅 feedback 失敗時唔會重播。

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

go-micro 嘅預設重試迴圈同 go-kratos 嘅 HTTP 串流形式係跟版本嘅。發布一份依賴佢哋嘅比較之前，重新核對已固定嘅 commit。

## Runtime

共用入口用 Fetch 同 `AbortSignal`，或者注入嘅能力。自訂 TLS、HTTP/2 同 mTLS 喺 `@go-like/core/transport/http/node` 同 `@go-like/connectrpc/node`。Hono、Elysia、H3 同 vanilla Fetch 例子將 Fetch Handler 傳畀 core host。呢個 repo 冇 NestJS 或 Fastify bridge。Manifest 版本 `0.0.1` 唔能夠證明 npm 發布。

## 按工具

**NestJS。** Module、provider 同 controller 仍然係 Nest 嘅。整合係應用持有、圍住 Nest 應用嘅 `Server`，有明確接納同關閉。呢個 repo 冇包含該 adapter。

**Fastify。** 路由、封裝同 listener 仍然係 Fastify 嘅。go-like 唔會將 `request` / `reply` 轉成 Fetch `Handler`。

**Hono。** `examples/hono` 將 `app.fetch` 傳畀 `newNodeServer`，再將該 host 放入 `server(...)`。路由留喺 Hono。

**Elysia。** 保留路由樹同 Bun 專屬行為。例子用 Fetch Handler 配 Node host。`.listen()` 唔係 go-like API。

**Koa。** 保留 middleware 同外部 router。只喺你講得出持有者嘅地方加生命週期或呼叫邊界。

**tRPC。** Procedure 仍然係 tRPC 嘅。go-like 端點係 JSON Fetch 上嘅 Struct，唔係 procedure router。

**go-micro 同 go-kratos。** 佢哋係 Context-first 呼叫、生命週期同服務探索詞彙嘅參考。go-like 嘅 watcher 產生完整替換快照。託管 gRPC 入口係 `@go-like/connectrpc/node`。

## 點揀

用真正擁有你手上問題嘅框架。缺嘅係接納、取消、服務探索，或者一個有具名持有者嘅後端契約時，先加一個 go-like 插座。將每隻插頭裝入一個已經完成嘅框架應用，會失去細小契約嘅好處。

## 證據錨點

而家嘅樹：

- `packages/core/src/app/app.ts` 同 `packages/core/src/app/tiers.ts`：層、時限同停止次序；
- `packages/core/src/lifecycle/index.ts`：`Server` 同 `Endpointer`；
- `packages/core/src/web/context.ts`：`Handler` 同 `contextHandler`；
- `packages/core/src/client/index.ts`：呼叫 option、服務探索同重試；
- `packages/core/src/server/index.ts`：內部分派；
- `packages/core/src/transport/service.ts`：`defineService`；
- `packages/core/src/registry/selector.ts`：filter、selector 同 feedback；
- `packages/connectrpc/src/node.ts`：託管 gRPC。

已固定嘅外部輸入，呢次文件修改冇重新驗證：

- [go-micro comparison commit](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)；
- [go-micro v6.9.0 commit](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6)；
- [go-kratos v3 commit](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)；
- [go-zlab/go-kratos commit](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336)；
- [NestJS lifecycle](https://docs.nestjs.com/fundamentals/lifecycle-events)、[Fastify server](https://fastify.dev/docs/latest/Reference/Server/)、[Hono](https://hono.dev/docs/api/hono)、[Elysia lifecycle](https://elysiajs.com/essential/life-cycle)、[Koa](https://koajs.com/)、[tRPC routers](https://trpc.io/docs/server/routers)。

為比較而記錄嘅第三方 TypeScript 版本，唔係相容承諾：NestJS `@nestjs/core@11.1.28`、Fastify `5.11.2`、Hono `4.12.34`、Elysia `1.4.29`、Koa `3.2.1`、tRPC `@trpc/server@11.18.0`。Elysia 例子嘅 manifest 係該例子嘅 pin；呢張表係研究快照。

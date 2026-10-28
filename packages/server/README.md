# @go-like/server

面向内部微服务调用的 Server。它消费 `@go-like/transport` 的 Fetch `Request` / `Response`，负责 path 路由、middleware 与生命周期；Registry 由 App 统一管理，外部 Web 请求使用 `@go-like/web`。

```ts
import { newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newTokenBucketLimiter } from "@go-like/resilience"
import {
  address,
  advertise,
  httpRoute,
  maxSendMessageBytes,
  middleware,
  newServer,
  rateLimitMiddleware,
  streamKeepAlive,
  transport,
  use,
  type HandlerRegistrar,
  type Middleware
} from "@go-like/server"
import { newNodeHTTPTransport } from "@go-like/transport-http/node"

declare const tracing: Middleware
declare const metrics: Middleware
declare const authorizeCatalogRead: Middleware
declare function registerCatalogServiceHandler(server: HandlerRegistrar, handler: unknown): void
declare const catalogService: unknown

const catalogLimiter = newTokenBucketLimiter({
  capacity: 100,
  refillTokens: 100,
  refillIntervalMs: 1_000
})

const rpc = newServer(
  transport(newNodeHTTPTransport()),
  address("0.0.0.0:9000"),
  advertise("catalog.internal"),
  httpRoute("GET", "/v1/catalog", "catalog", "get"),
  streamKeepAlive(15_000),
  maxSendMessageBytes(4 * 1024 * 1024),
  middleware(tracing),
  use("catalog/*", metrics, rateLimitMiddleware(catalogLimiter), authorizeCatalogRead)
)
registerCatalogServiceHandler(rpc, catalogService)

const app = newApp(signal(), server(rpc))
await app.run()
```

应用自己的 service glue 只依赖 `HandlerRegistrar`。原始 handler 是 `(ctx, request: Request) => Response | Promise<Response>`，并且内部 RPC 在进入 handler 前已经要求 `POST` 与 JSON `content-type`：

```ts
import type { HandlerRegistrar } from "@go-like/server"

export interface CatalogServiceHandler {
  get(ctx: unknown, request: Request): Response | Promise<Response>
}

export function registerCatalogServiceHandler(
  server: HandlerRegistrar,
  handler: CatalogServiceHandler
): void {
  server.registerHandler("catalog", "get", (ctx, request) => handler.get(ctx, request))
}
```

共享类型化 contract 使用 `defineService(...).registerHandler(server, handler)`，或 `server.registerHandler(contract, handler)`。`stream: true` 的 handler 是 `async *`，返回 `AsyncIterable`。unary 与 stream 进入同一条 route、middleware 与生命周期链。

无信封 REST 用 `httpRoute(method, path, service, endpoint, successStatus?)` 把精确 method+pathname 映射到同一 handler；省略 `successStatus` 时成功载体为 200。`httpRoute` 先于内部 RPC 匹配，并且不检查 POST 或 JSON `content-type`。

已注册的 `/<service>/<endpoint>` 必须是 `POST`，否则 405；`content-type` 必须是 `application/json`，否则 400 `invalid_request`。未注册的两段 path 返回 404 `not_found`，即使没有 `content-type`。成功的类型化 JSON 是 HTTP 200。`ServiceError` 使用真实 HTTP status，body 是 `{ code, message, metadata }`。

无信封且未命中精确 `httpRoute` 时，`GET` 与 `HEAD` `/healthz` 缺省回答 HTTP 200 空 body，不进入 unary handler；精确 `httpRoute("GET", "/healthz", …)` 覆盖该缺省。`/livez`、`/readyz` 与其它未匹配路径仍为 404。Docker 发布端口上的 TCP connect 不能代替这次 HTTP 探活：docker-proxy 可能在 listener 就绪前接受连接。

`Go-Like-Timeout-Ms` 必须是非负十进制整数，否则 400 `invalid_request`。Server 把请求 deadline 设为收到该值后的剩余时间与自身限制的较早者。`0` 立即取消。请求 Context 活到 response body 结束：Transport 的 `Listener.serve` 在 body 到达终态（结束、出错或取消）时取消交给 handler 的 Context，deadline 子 Context 及其 timer 随父 Context 取消而释放，Server 不包装 response body。stream 响应在终态或取消时取消流 Context 并调用 iterator `return()`。仅当 Transport 交来的 Context 不可取消（`done()` 为 `null`，例如 `background()`）时，Server 才自行观察 response body，并在终态释放 deadline。

operation 使用唯一的 `service/endpoint` 名称；两段 route token 必须匹配 `^[A-Za-z0-9._~-]+$`，且不能恰好是 `.` 或 `..`。注册和入站 path 都执行同一校验且不执行 trim。`middleware(...)` 始终包在 operation middleware 外层。`use(selector, ...middleware)` 只接受精确 `token/token`，或尾部 wildcard `*`、`token*`、`token/token*`（包括 `orders/*` 与 `orders/get*`）。匹配时精确 selector 优先，其次是尾部 wildcard 的最长前缀，最后回退到 `*`；同一 selector 的后声明覆盖前声明，空 middleware 可屏蔽较宽前缀。

`streamKeepAlive(intervalMs)` 设置 SSE 注释间隔，默认 `15000`。`0` 只保留握手后的初始注释。`maxSendMessageBytes(bytes)` 限制单条已编码 SSE 事件的 UTF-8 字节，默认 4 MiB；超限的 code 是 `resource_exhausted`，HTTP status 是 429，message 包含实际字节数、上限和超限的一侧。计数包含 SSE 前缀和结尾空行。没有流的总字节上限。

`rateLimitMiddleware(limiter)` 的一个 middleware 实例共享一个 limiter。需要 operation 隔离时，为不同 `use(...)` 传入独立 limiter；未知 route 在 middleware 之前被拒绝，不会消耗 token。

`newServer()` 允许暂时没有 handler；第一次 `endpoint()` 或 `start()` 会同步 seal 注册表。空注册、重复注册、不存在的 `httpRoute` target 和 seal 后注册都会在 listener I/O 前失败。`Server.start(ctx)` 持续运行至 listener 停止；`Server.stop(ctx)` 负责优雅关闭，超时由 App 的 `stopTimeout(...)` 统一控制。`endpoint(ctx)` 与启动共享同一次真实 bind，返回注册端点。`address(...)` 只配置 bind；`advertise(...)` 配置注册端点或 host，host-only 值会沿用实际绑定端口。wildcard bind 必须显式提供可达的 advertise 值。

Server 的 `protocol()` 来自选定 Transport 的 `kind()`。同一个 Core App 生成的 Registry instance 只能包含一种非空 protocol；HTTP 与标准 gRPC 应分别使用 `orders-http`、`orders-grpc` 等应用名。应用名是 `withEndpoint("discovery:///<name>")` 里的名字，契约 service 名是 URL path 的第一段。

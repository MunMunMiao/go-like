# @go-like/server

面向内部微服务调用的 go-micro 风格 Server。它消费 `@go-like/transport`，负责路由、middleware 与生命周期；
Registry 由 App 统一管理，外部 Web 请求使用 `@go-like/web`。

```ts
import { newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newTokenBucketLimiter } from "@go-like/resilience"
import {
  address,
  advertise,
  handler,
  middleware,
  newServer,
  rateLimitMiddleware,
  transport,
  use
} from "@go-like/server"
import { newNodeHTTPTransport } from "@go-like/transport-http/node"

const catalogLimiter = newTokenBucketLimiter({
  capacity: 100,
  refillTokens: 100,
  refillIntervalMs: 1_000
})

const rpc = newServer(
  transport(newNodeHTTPTransport()),
  address("0.0.0.0:9000"),
  advertise("catalog.internal"),
  handler("catalog", "get", async (_ctx, request) => request),
  middleware(tracing),
  use("catalog/*", metrics, rateLimitMiddleware(catalogLimiter), authorizeCatalogRead)
)

const app = newApp(signal(), server(rpc))
await app.run()
```

共享类型化 contract 时，直接使用 `handler(contract, fn)`；Server 会在 Message 边界完成请求校验与响应编码：

```ts
const rpc = newServer(
  transport(newNodeHTTPTransport()),
  handler(quoteEndpoint, async (_ctx, request) => calculateQuote(request))
)
```

原始 `handler(service, endpoint, fn)` 继续用于 bytes/message 级 handler。两种形式进入同一条 route、
middleware 与生命周期链，不增加第二套 Server。

operation 使用唯一的 `service/endpoint` 名称；两段 route token 必须只包含 U+0021–U+007E 可见 ASCII，
且不得包含 `/`、`*`。注册和入站 routing header 都执行同一校验且不执行 trim。`middleware(...)`
始终包在 operation middleware 外层。
`use(selector, ...middleware)` 只接受精确 `token/token`，或尾部 wildcard `*`、`token*`、
`token/token*`（包括 `orders/*` 与 `orders/Get*`）；token 遵循上述 canonical route token 规则。匹配时精确 selector
优先，其次是尾部 wildcard 的最长前缀，最后回退到 `*`；同一 selector 的后声明覆盖前声明，空
middleware 可屏蔽较宽前缀。直接 `use()` 会在声明时校验，自定义 `ServerOption` 注入的 Map 会在 `newServer`
构造时重新校验，均在监听前 fail-fast。

`rateLimitMiddleware(limiter)` 的一个 middleware 实例共享一个 limiter。需要 operation 隔离时，为不同
`use(...)` 传入独立 limiter；未知 route 在 middleware 之前被拒绝，不会消耗 token。

`handler` 注册精确的 service 与 endpoint。`Server.start(ctx)` 持续运行至 listener 停止；
`Server.stop(ctx)` 负责优雅关闭，超时由 App 的 `stopTimeout(...)` 统一控制。底层 Listener 由 Server 使用独立
Context 关闭，每个 stop Context 只限制该调用者的等待，不会取消或污染共享关闭。`endpoint(ctx)` 与
`start(ctx)` 共享同一次真实 bind，供 Core App 自动构造 Registry `ServiceInstance`，不会为注册再开一个
listener。`address(...)` 只配置 bind；`advertise(...)` 配置注册端点或 host，host-only 值会沿用实际绑定端口。
wildcard bind 必须显式提供可达的 advertise 值；容器、NAT、Ingress 与端口映射不会被猜测。

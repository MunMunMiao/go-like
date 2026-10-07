# 服务调用

一次内部 unary 调用由几个小组件配合完成。`@go-like/client` 把 Discovery 快照交给 `Selector`，再通过
`Transport` 完成一次 `fetch`。构造入口统一使用 functional options：

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

`Filter`、`filterVersion(...)` 与 `filterLabel(...)` 属于 Registry 根入口；Filter 在
`Selector.select` 前按声明顺序执行。直连目标在构造时使用
`newClient(withTransport(serviceTransport), withEndpoint(serviceAddress))`；`withEndpoint(...)` 绕过 Discovery，
但仍经过与发现快照相同的 Selector。配置 Discovery 的 Client 同时使用 `withEndpoint("discovery:///<name>")` 与
`withDiscovery(discovery)`，再按服务名懒建立 watcher，并从最新完整快照选择。
只有确认操作可安全重放后，才用 `withRetry(...)` 显式设置尝试次数、失败分类和 backoff；每次获准的 retry
都从最新快照重新选择，默认一次 call 只尝试一次。不再使用 Client 时调用 `client.close(ctx)`。
`closeTimeout(...)` 只限制逻辑 Transport Client 的清理等待。Client 默认保留最多 `poolSize(100)` 个 idle 逻辑 owner，闲置 `poolTtl(60_000)` 毫秒后回收；每次 attempt 会从 idle pool 借用并在成功后归还，而不是每次都创建再关闭。portable Fetch 的物理连接复用归 runtime；Node HTTP provider 在同一次 `transport.dial(...)` 返回的 Client 内复用 H1 keep-alive 或 H2 session。

`@go-like/server` 把业务 handler 映射到 Transport 并暴露实际绑定地址。使用 `transport(...)`、
`address(...)`、`middleware(...)` 与 `listenOption(...)` 构造 Server，再在启动前通过
`server.registerHandler(...)` 注册路由；`listenOption(...)`
把 provider 专属 `ListenOption` 原样传给 `Transport.listen`。`endpoint(ctx)` 与
`start(ctx)` 共享同一次真实 bind。配置为 `newApp(registrar(registry), server(serviceServer))` 的 Core App
会把该 endpoint 作为应用 `ServiceInstance` 统一发布和撤销。

Client 会把实际 target、`service/endpoint` operation 和真实 wire headers 作为 client-side `TransportInfo`
注入交给 Transport 的子 Context；Server 会在调用业务 handler 前注入对应的 server-side `TransportInfo`。
Client/Server 使用有界、规范的 `Go-Like-Metadata` envelope 编码多值 Context metadata；Transport provider
只需把它当作普通 Fetch header 无损承载。`propagateToClientContext(...)` 只有收到显式 `exact` 或
`prefix` allowlist 时才会把 server metadata 复制到下游。

调用会等待 feedback，以及逻辑 Transport Client 归还连接池或按需关闭。成功客户端默认可以复用，`poolSize(0)` 才会禁用保留。收到响应后若清理失败，`AggregateError.cause` 保留 response，`errors` 按顺序保存清理错误，这类失败不会重放业务调用。不再使用 owner 时调用 `client.close(ctx)`。

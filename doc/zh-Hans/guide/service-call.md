# 服务调用

一次内部 unary 调用由几个小组件配合完成。`@likego/client` 把 Discovery 快照交给 `Selector`，再通过
`Transport` 完成一次 `send` 和 `recv`。构造入口统一使用 functional options：

```ts
import { newClient, withDiscovery, withFilter, withSelector, withTransport } from "@likego/client"
import { filterLabel, filterVersion, type Filter } from "@likego/registry"

const client = newClient(
  withDiscovery(discovery),
  withSelector(selector),
  withTransport(serviceTransport)
)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
const reply = await client.call(
  ctx,
  {
    service: "orders",
    endpoint: "Orders.Get",
    message: { header: {}, body: requestBytes }
  },
  withFilter(...filters)
)
```

`Filter`、`filterVersion(...)` 与 `filterLabel(...)` 属于 Registry 根入口；Filter 在
`Selector.select` 前按声明顺序执行。只做直连调用时使用 `newClient(withTransport(serviceTransport))` 即可；
`withAddress(...)` 绕过发现和选择。配置 Discovery 的 Client 按服务名懒建立 watcher，并从最新完整快照选择。
只有确认操作可安全重放后，才用 `withRetry(...)` 显式设置尝试次数、失败分类和 backoff；每次获准的 retry
都从最新快照重新选择，默认一次 call 只尝试一次。不再使用 Client 时调用 `client.close(ctx)`。
`closeTimeout(...)` 只限制逻辑 Transport Client 的清理等待。portable Fetch 的物理连接复用归 runtime；
Node HTTP provider 在同一次 `transport.dial(...)` 返回的 Client 内复用 H1 keep-alive 或 H2 session，高层
Client 当前仍按每次 attempt 创建并关闭该逻辑 Client。

`@likego/server` 把业务 handler 映射到 Transport 并暴露实际绑定地址。它的构造 option 是
`transport(...)`、`address(...)`、`handler(service, endpoint, fn)`、`middleware(...)` 与
`listenOption(...)`；最后一个把 provider 专属 `ListenOption` 原样传给 `Transport.listen`。`endpoint(ctx)` 与
`start(ctx)` 共享同一次真实 bind。配置为 `newApp(registrar(registry), server(serviceServer))` 的 Core App
会把该 endpoint 作为应用 `ServiceInstance` 统一发布和撤销。

Client 会把实际 target、`service/endpoint` operation 和真实 wire headers 作为 client-side `TransportInfo`
注入交给 Transport 的子 Context；Server 会在调用业务 handler 前注入对应的 server-side `TransportInfo`。
Client/Server 使用有界、规范的 `Likego-Metadata` envelope 编码多值 Context metadata；Transport provider
只需把它当作普通 Message header 无损承载。`propagateToClientContext(...)` 只有收到显式 `exact` 或
`prefix` allowlist 时才会把 server metadata 复制到下游。

公共 Transport SPI 与 go-micro 的角色一致：`Transport`、`Client`、`Listener`、`Socket`。
`@likego/transport-http` 同时实现 client 和 server。业务交换完成后若 feedback 或逻辑 client close 失败，
原生 `AggregateError` 会把 response 保存在 `cause`，并在 `errors` 中保留有序清理错误；清理失败不会被伪装成可重试的业务调用。

# @go-like/transport-grpc-buf

`@go-like/transport-grpc-buf` 集成上游 Protobuf-ES 与 Connect-ES，不实现 protobuf 编码、gRPC framing、
stream state machine 或 HTTP/2。根入口是只依赖标准 Web API 的 Connect/gRPC-Web Fetch bridge；托管的标准
gRPC client/server 位于 capability subpath `@go-like/transport-grpc-buf/native`。该边界不使用 Buf online
service，也不集成 Google gRPC runtime。

## Portable Fetch

```ts
import { createConnectTransport } from "@connectrpc/connect-web"
import { newHandler } from "@go-like/transport-grpc-buf"
import { newOrderServiceClient, registerOrderServiceHandler } from "./gen/order_like.js"

export const handler = newHandler((server) => {
  registerOrderServiceHandler(server, orderService)
})

const client = createConnectTransport({ baseUrl: "https://api.example.com" })
const orders = newOrderServiceClient(client)
const order = await orders.getOrder(ctx, { id: "order-1" })
```

`newHandler()` 返回 `(request: Request) => Promise<Response>`。Node、Bun 与 Deno 的现有 portable runtime test
通过进程内 Fetch bridge 覆盖 Connect/gRPC-Web unary 和 server-streaming 的协议往返，不证明真实 HTTP 连接的
取消传播。Fetch request-streaming 与 bidi 会在业务 handler 进入前拒绝。浏览器和
Edge 使用调用方创建的官方 Connect/gRPC-Web transport，不宣称浏览器标准 gRPC。

真实 HTTP 故障场景另有已知限制：Bun 1.4.2 Fetch 客户端读取首条响应后，对随后保持静默的流执行
reader cancel 或 AbortController abort，Node 26.9.0 与 Bun 1.4.2 服务端均未在 500ms 观察窗口内收到
response/socket close；Node 客户端在相同场景能够传播取消。去掉 LikeGo、Connect 与 Protobuf 的纯
`node:http` + Fetch 场景也能复现，因此该项归为 runtime 限制。它不表示所有 Fetch 场景都失败，但依赖远端
prompt cancellation 的 Bun 长连接业务不能据基础协议测试宣称可靠。此项只记录边界，不通过重放流或强制退出掩盖。

## Managed standard gRPC

直连一个地址：

```ts
import { newClient, withAddress } from "@go-like/transport-grpc-buf/native"
import { newOrderServiceClient } from "./gen/order_like.js"

const client = newClient(withAddress("https://orders.internal"))
const orders = newOrderServiceClient(client)
const order = await orders.getOrder(ctx, { id: "order-1" })

await client.close(ctx)
```

直连多个地址和服务发现都复用 `@go-like/registry` 的 `Selector`。多地址直连：

```ts
import { newClient, withAddress, withSelector } from "@go-like/transport-grpc-buf/native"
import { newRoundRobinSelector } from "@go-like/registry"

const client = newClient(
  withAddress("https://orders-a.internal", "https://orders-b.internal"),
  withSelector(newRoundRobinSelector())
)
const orders = newOrderServiceClient(client)
```

服务发现：

```ts
import {
  newClient,
  withDiscovery,
  withSelector,
  withService
} from "@go-like/transport-grpc-buf/native"
import { newRoundRobinSelector } from "@go-like/registry"

const client = newClient(
  withService("orders-grpc"),
  withDiscovery(discovery),
  withSelector(newRoundRobinSelector())
)
const orders = newOrderServiceClient(client)
```

托管 Server 在启动前使用同一份生成胶水注册：

```ts
import { address, advertise, newServer } from "@go-like/transport-grpc-buf/native"
import { registerOrderServiceHandler } from "./gen/order_like.js"

const server = newServer(address("0.0.0.0:9000"), advertise("orders.internal:9000"))
registerOrderServiceHandler(server, orderService)
```

默认 round-robin 只轮询当前地址快照，不检测或摘除故障节点。Discovery watcher 发布的新完整快照负责更新
成员；直连地址不会自动变化。每次 RPC 只选择一次地址。需要重试时，由应用明确限制次数、Context 总预算和
可重试错误，并保证 unary 操作幂等；连接中断本身不能证明服务端尚未产生副作用。流中断后如何续传由业务协议
决定，managed Client 不会自动重放请求或已经交付的响应。

生成的 `newOrderServiceClient(client)` 借用传入的 Connect transport；只有 `/native` 创建的 managed Client
拥有 session、Discovery resolver 与 `close(ctx)`。标准 gRPC 的 unary、server-streaming、client-streaming 和
bidi 的既有物理发布包互操作记录包含 Node 26.7.0、Bun 1.4.0、Deno 2.9.5。Node 是 Connect-ES
上游支持的 runtime；Bun 与 Deno 由 LikeGo 的兼容性 lane 验证并记录实际执行版本，版本记录不构成固定版本门禁
或全部生产场景的保证。

后续故障回归发现：Deno 2.9.5 和 2.9.7 在服务停止时，慢消费者仍在读取的响应可能以 `Premature close`
提前结束。该问题也能用不依赖 LikeGo 或 Connect 的 `node:http2` 代码复现。Node 26.9.0、Bun 1.4.2 通过了
相同的 managed drain 回归；此前 Deno 的四种调用成功不能作为优雅停止可靠性的证明。
当前 `test:e2e:published` 保留该强回归，并在 Deno 上失败；Deno native 的此项生产可靠性尚未满足。
目前没有经过验证的安全 workaround，不应依靠固定延迟或重放流隐藏失败。

流式调用提前停止时，先取消原始 Like Context，再退出循环；`cancel()` 可重复调用，所以 `finally` 负责兜底：

```ts
const [ctx, cancel] = withCancel(parent)
try {
  for await (const event of orders.watchOrders(ctx, { customerId: "customer-1" })) {
    consume(event)
    if (enough(event)) {
      cancel()
      break
    }
  }
} finally {
  cancel()
}
```

同一规则适用于生成的 bidi 方法。不要假设 `break` 会调用 Connect 生成结果的 raw iterator `return()`；取消
Like Context 才是生成 client 的提前停止契约。

取消会异步传播到远端 handler；客户端已经收到取消错误，不代表服务端的 `finally` 已执行。需要确认业务收尾时，
等待明确的完成信号并设置截止时间，不能依赖固定 sleep 或把客户端取消当作事务回滚。

当前固定的 Connect 2.1.2 还有独立的依赖清理缺陷：响应流已交付一条消息、消费者暂停读取后，外部取消即使
已经使 handler 和 managed owner 关闭，Connect 的 deadline timer 仍可能保留到原 deadline。Node 26.9.0 和
Bun 1.4.2 的纯上游 Connect HTTP/2 复现均观察到 1,200ms RPC 预算导致约 1.2 秒的自然进程退出延迟。
这是有期限的 timer 滞留与退出延迟，尚无数据丢失、重复写或永久泄漏证据；本仓库尚未修补该依赖。
`client.close(ctx)` 完成不能据此等同于所有依赖 timer 已释放。额外 `next()` 仅是定位根因的对照，
不是已验证的应用 workaround；不应强制 drain、`unref`、缩短业务预算或强制退出来伪造清理成功。

`withTLSConfig(...)` 配置 managed Client；Server 使用 `tlsConfig(...)` 与 `clientAuth("require")`。物理发布
测试在上述三个固定 runtime 上都证明可信客户端证书成功、缺少证书和不可信 CA 证书在 handler 前失败；Node
还通过了带 CA、client certificate/key 与 server name 的独立 Buf TLS 调用。这不是对未来 runtime 版本或任意
TLS 部署的泛化承诺。

TLS 握手失败的 Connect status 和底层 `cause` 可能随 runtime 和 HTTP/2 关闭时序变化。跨 runtime 的认证契约是
可信客户端成功、缺少或不受信任的证书在 handler 前被拒绝；不要依赖某个固定 TLS 错误码或文本来决定重试。

业务 handler 可以显式抛出上游 `ConnectError`，传递 status 和 Protobuf details。普通 `Error` 由 Connect 服务端
转为通用 `Internal`；不要把内部异常文本当作公开错误协议。无效输入、资源额度等业务错误应由 handler 明确分类，
该包不根据异常文本猜测错误类型。

当前不提供 health、reflection、validation、canonical error-details mapping、Google gRPC runtime 或任何 Buf
online service。

# 服务调用

一次内部服务调用是一次 Fetch 交换。操作名和传输地址是不同的值。带类型的调用在 JSON body 上加上 Struct 校验。生成的 Protobuf RPC 是另一条路径；见[流式传输](/zh-Hans/guide/streaming)。

## 操作身份与地址

`defineService("appointment-policy.v1", { check })` 把操作命名为 `appointment-policy.v1/check`。`withEndpoint("memory://appointment-policy.v1")` 和 `address("memory://appointment-policy.v1")` 命名字节发往何处。注册中心的 `ServiceInstance` 把传输 URL 存在 `endpoints` 里。Filter 和 Selector 在这些 URL 中选择。它们不选择操作。

## 带类型的 Memory Transport

两边使用同一个 `newMemoryTransport()`。它位于进程内，并且实例私有。这是 `examples/healthcare-appointments` 里的形态：

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

`service.registerHandler` 在启动前绑定每个带类型的 handler。`service.newClient(client).add(ctx, value)` 校验请求和响应。`client.close(ctx)` 是应用的清理。在真实进程里，从 `afterStop` 关闭客户端，让 `app.run()` 拥有生命周期。

`newHTTPTransport()` 是可移植的 Fetch 客户端。它不监听。Node 监听器在服务端和 Node 客户端两边都使用 `@go-like/core/transport/http/node` 的 `newNodeHTTPTransport()`。把 `newHTTPTransport()` 传给 `newServer` 可以通过类型检查，然后在监听时以 `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY` 失败。

`@go-like/core/server` 和 `@go-like/core/client` 都导出 `middleware` 和 `use`。一个文件两边都需要时，把其中一个作为命名空间导入。

## 一次尝试

默认调用只做一次尝试。客户端构造带 `content-type: application/json` 的 `POST`，拨号或复用一条传输，然后读取响应。匹配服务错误信封的非 2xx JSON body 会变成 `ServiceError`。在读取 `code`、`status` 或 `metadata` 之前，用 `@go-like/core/transport` 的 `isServiceError` 识别它。`ServiceError.code` 由应用拥有。它不是 `GO_LIKE_*` 代码。

原始的 `client.call` 接收 `{ service, endpoint, headers, body }`，返回 Fetch `Response`。调用方读取 body 或取消它。

Metadata 在 Context 上传递。`@go-like/core/metadata` 提供 `newClientContext`、`fromServerContext` 和 `propagateToClientContext`。传播是显式的。除非 handler 自己这样做，入站 metadata 不会复制到下一跳。

## 发现、过滤与选择

`@go-like/core/registry` 的 `newDiscoveryResolver` 监视一个服务，并保留一份完整替换快照。空快照是权威的：选择以 `GO_LIKE_NO_AVAILABLE_ENDPOINT` 失败，而不是复用上一批实例。

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

`withDiscovery` 接收 `Discovery`。客户端建立私有 resolver。只有应用代码需要客户端之外的快照时，才调用 `newDiscoveryResolver(discovery)`。同一个 Discovery 上的两个 resolver 不共享 watcher。

Filter 是纯函数，并且有顺序。内建的是 `filterVersion` 和 `filterLabel`，通过 `withFilter` 按次调用传入。Selector 是 `newRoundRobinSelector`、`newWeightedRoundRobinSelector`、`newRandomSelector`、`newP2CSelector` 和 `newEWMASelector`。P2C 和 EWMA 在尝试之后接收同步反馈。该状态与 `circuitBreakerMiddleware` 分开，后者把断路器键到一个操作上。

`withBlock()` 等待第一份非空快照。直接的 `withEndpoint` 地址列表是静态快照，仍然经过 Selector。`withEndpoint("discovery:///name")` 命名要监视的服务。

## 重试是重放授权

`@go-like/core/client` 的 `withRetry` 要求：

- `authorization`：`"idempotent"` 或 `"caller-approved"`；
- `maxAttempts`：正整数，计入第一次尝试；
- `shouldRetry(ctx, error, attempt)` 返回布尔值。

这份授权是调用方的声明。Core 不检查副作用。每次尝试都重新进入发现和选择。已经收到响应之后，如果后续反馈或清理失败，不会重放。

`@go-like/core/resilience` 里的 `retry` 和 `exponentialBackoff` 是同一想法，给客户端之外的应用代码使用。`newCircuitBreaker` 和 `circuitBreakerMiddleware` 在调用方定义的失败上打开。`circuitOpen` 是断路器打开时抛出的哨兵。`newTokenBucketLimiter` 和 `rateLimitMiddleware` 拒绝超额调用。

## 清理

- 在 `afterStop` 里关闭客户端和配置 watcher，或用 `newResourceServer` 接纳一条原生连接。
- 调用时保留请求 Context。把它换成 `background()` 会丢掉取消和当前 span。
- 用哨兵、`isServiceError` 或文档中的 `code` 匹配失败。把 message 留给诊断。目录在[错误处理](/reference/errors)。

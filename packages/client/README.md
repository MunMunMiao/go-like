# @go-like/client

`@go-like/client` 是 go-like 的内部服务调用组合包。它从构造时的直连根 URL 或 Discovery 快照选择节点，再通过
Transport 的 `fetch(ctx, request)` 完成 unary JSON 调用或 SSE 服务端流。`withAddress` 与 `withService` 已删除，地址来源统一为 `withEndpoint`。

## Client

地址属于长生命周期 Client 的构造配置，不是一次调用的临时 option。直连一个根 URL：

```ts
import { background } from "@go-like/context"
import { newClient, withEndpoint, withTransport } from "@go-like/client"
import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"
import { newHTTPTransport } from "@go-like/transport-http"

const orders = defineService("orders", {
  get: {
    request: struct.object({ id: struct.string() }),
    response: struct.object({ id: struct.string() })
  }
})

const client = newClient(
  withTransport(newHTTPTransport()),
  withEndpoint("https://orders-a.internal")
)
const api = orders.newClient(client)
const ctx = background()
const order = await api.get(ctx, { id: "order-1" })
void order
await client.close(ctx)
```

直连多个根 URL 时，同一地址快照进入 Registry `Selector`；默认 selector 是 round robin。后声明的 option 覆盖先声明的：

```ts
import { newClient, withEndpoint, withSelector, withTransport } from "@go-like/client"
import { newRoundRobinSelector } from "@go-like/registry"
import { newHTTPTransport } from "@go-like/transport-http"

const client = newClient(
  withTransport(newHTTPTransport()),
  withEndpoint(["https://orders-a.internal", "https://orders-b.internal"]),
  withSelector(newRoundRobinSelector())
)
void client
```

`discovery:///<name>` 选择 Registry 里的应用名，不会被当作可拨号地址，并且必须同时提供 `withDiscovery`。它不能和直连地址放进同一个数组。服务发现只把地址来源换成 resident watcher；选择算法仍是同一个：

```ts
import {
  newClient,
  withDiscovery,
  withEndpoint,
  withSelector,
  withTransport
} from "@go-like/client"
import { newRoundRobinSelector, type Discovery } from "@go-like/registry"
import { newHTTPTransport } from "@go-like/transport-http"

declare const discovery: Discovery

const client = newClient(
  withTransport(newHTTPTransport()),
  withEndpoint("discovery:///orders-http"),
  withDiscovery(discovery),
  withSelector(newRoundRobinSelector())
)
void client
```

节点地址必须是绝对根 URL：`new URL` 成功，pathname 为 `""` 或 `"/"`，且没有 query 或 fragment。HTTP 内部调用的 path 是 `/<service>/<endpoint>`，不能写进 dial 地址。URL scheme 不表示 operation。

`withFilter(...)` 与显式授权的 `withRetry(...)` 仍是 call option；它们不能覆盖构造时的地址来源。原始 `call` 返回 `Response`，调用方必须消费 body 或 `response.body?.cancel()`。每条内部 RPC 都是 `POST`，并带 `content-type: application/json`：

```ts
import { newClient, withEndpoint, withFilter, withRetry, withTransport } from "@go-like/client"
import { background } from "@go-like/context"
import { exponentialBackoff } from "@go-like/resilience"
import { filterLabel, filterVersion } from "@go-like/registry"
import { newMemoryTransport } from "@go-like/transport-memory"

declare const ctx: ReturnType<typeof background>

const client = newClient(withTransport(newMemoryTransport()), withEndpoint("memory://orders"))
const response = await client.call(
  ctx,
  {
    service: "orders",
    endpoint: "get",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ id: "order-1" }))
  },
  withFilter(filterVersion("v2"), filterLabel("zone", "a")),
  withRetry({
    authorization: "idempotent",
    maxAttempts: 3,
    shouldRetry: (_ctx, failure) => failure instanceof TypeError,
    backoff: exponentialBackoff({ initialDelayMs: 20, maxDelayMs: 100 })
  })
)
await response.body?.cancel()
```

同一个 Client 也可直接调用共享的类型化 contract。`defineService(...).newClient(client)` 只暴露契约方法。类型化 `call` 拒绝 `stream: true` 的 endpoint；服务端流使用 `client.stream(...)` 或契约方法，返回 `Promise<ServerStream<T>>`。类型化 unary 与 stream 都会设置 `content-type: application/json`，stream 还会设置 `accept: text/event-stream`。

类型化和 raw 调用共用 canonical `service/endpoint`。两段 route token 必须匹配 `^[A-Za-z0-9._~-]+$`（URL unreserved），且不能恰好是 `.` 或 `..`；Client 不执行 trim，并在 middleware、Discovery 与网络 I/O 前拒绝非法名称。

配置 Discovery 的 `newClient` 会按应用名懒加载一个常驻 watcher，并缓存其完整替换快照；同一服务的并发调用共享一次接纳。watcher 先于首次读取建立；首次 `next()` 只作为 barrier，随后用 fresh `getService()` reconcile，避免旧的 watcher 初始快照覆盖刚读取的状态。此后的每个完整 replacement snapshot 都是权威状态，包括空数组；空快照会覆盖旧节点并使调用以 `NoAvailableEndpointError` fail closed。watcher 终止后保留最后一个快照，并在 1 秒退避后重建。调用方必须在不再使用 Client 时执行 `client.close(ctx)`；它会关闭常驻 transport owner、停止全部 watcher，随后任何调用都稳定失败。直接地址 Client 不创建 watcher，但仍使用同一个 `close(ctx)` 生命周期。

默认空 discovery 快照会立即 fail closed。需要等待服务首次就绪时，可在构造中加入 `withBlock()`：

```ts
import { newClient, withBlock, withDiscovery, withEndpoint, withTransport } from "@go-like/client"
import { newHTTPTransport } from "@go-like/transport-http"
import type { Discovery } from "@go-like/registry"

declare const discovery: Discovery

const waitingClient = newClient(
  withBlock(),
  withEndpoint("discovery:///orders-http"),
  withDiscovery(discovery),
  withTransport(newHTTPTransport())
)
void waitingClient
```

它只等待原始 discovery 快照首次出现至少一个 endpoint，不受 call filter 影响；每个调用仍由自己的 Context 限制等待。服务一旦曾经就绪，后续空快照继续作为权威状态并立即 fail closed，不会保留旧节点。`client.close(ctx)` 会以稳定的 `client is closed` 唤醒尚未就绪的调用并停止共享 watcher。

默认每次调用只执行一个 attempt；每个 attempt 从当前缓存选择地址，并优先借用该地址最近释放的空闲 Transport Client（后进先出），没有空闲 owner 才执行 `dial`。同一 owner 在借出期间不在空闲池内，不会被并发调用共享；完整交换成功后 owner 回到该地址的空闲栈，同一地址可同时保留多个空闲 owner，下一波同等并发因此可直接复用而无需重新拨号。失败 attempt、响应不可复用的 attempt 与超出全局上限的 owner 立即执行真实 `close`，从不入池。发现结果只按显式 Registry Filter 过滤，endpoint 对 Client 保持 opaque，并原样交给 Selector；Selector 选出的地址再原样交给 Transport `dial`。协议解析和可拨号性属于具体 Transport。Client 另外要求选出的节点是绝对根 URL，不根据 `kind()` 或 URL scheme 猜测 operation。

空闲池默认在整个 Client 范围（跨全部地址）最多保留 100 个 owner，并在空闲 60,000ms 后主动关闭。`poolSize(maxIdle)` 设置这个全局 idle 上限，超限时按释放顺序淘汰最久未使用的 owner，而不论其地址；`poolSize(0)` 禁用 idle reuse，每个 owner 在交换结束时关闭。`poolTtl(milliseconds)` 设置空闲时间，每个空闲 owner 各自计时，到期只关闭并摘除它自己；`poolTtl(0)` 只禁用时间过期，仍受 size 约束。`client.close(ctx)` 对每个已入池的 owner 恰好关闭一次。这两个值不是 Transport 并发上限，也不声明底层协议可多路复用。

Client 会为自身创建独立的 round-robin Selector；`withSelector(...)` 只用于覆盖默认选择策略。直接地址与 Discovery 快照都进入这个 Selector；区别只是直接模式不创建 watcher。直接地址 Client 按服务名各构建并缓存一份由 `snapshotServiceInstances` 发布的不可变实例快照（地址已规范化并排序，至多缓存 1,024 个服务），每个 attempt 与内置 Selector 直接复用它而不再复制；配置的地址无法通过该快照校验（例如含凭据或 fragment）时，Client 原样把配置实例交给 Selector，由 Selector 照旧报告错误。`withEndpoint` 的直连根 URL 与 `discovery:///` 是互斥的构造来源。`withFilter` 按声明顺序应用 `@go-like/registry` 的 `filterVersion`、`filterLabel` 或用户自定义 Filter，空结果稳定抛出 `NoAvailableEndpointError`；Filter 返回的新数组不属于已发布快照，Selector 仍会完整复制并校验。

每个 call option 只应用并快照一次：Client 把已发布的 `CallOptions` 原样交给 middleware 与最终调用，不在 typed call、原始调用和最终调用之间重复复制；middleware 追加或替换的 option 仍按原顺序校验并应用，调用方自行构造的对象即使已冻结也会被完整复制并校验。

round-robin 不会探测健康状态或自动摘除不可达节点；成员变化由 Discovery 的完整替换快照提供。显式 retry 会重新选择地址，但不保证新地址可达，也不能把连接失败等同于服务端没有执行请求。幂等和重复副作用控制仍是业务契约。握手完成后的流失败不会重放。

默认调用严格执行一次。只有 `withRetry` 同时声明 `authorization`、最大尝试次数和失败判定后才允许重放；backoff 复用 `@go-like/resilience` 的 Context-aware 实现。每次 attempt 从最新 watcher 快照重新选择，但重放的是调用开始时已经复制的同一请求 body。没有并存的 feedback/close failure 时，最终 `ServiceError`、Context error 或 Transport primary 保留原始 identity；若主失败与 attempt 清理失败同时存在，顶层为 `AggregateError`，`errors[0]` 始终是 primary，其后按 feedback、close 排序。调用 Context 控制调用方的取消与截止时间，注入的 Transport 仍可实施自己的协议超时策略；只要调用 Context 已经取消，随后由 provider 抛出的独立 `AbortError` 也不会作为节点故障反馈。

调用方 Context 有 deadline 时，Client 把剩余毫秒向上取整写入 `Go-Like-Timeout-Ms`；没有 deadline 时不写这个头。`0` 表示立即取消。下游观察到的失败可能是 `Canceled` 而不是 `DeadlineExceeded`，应以 deadline 是否存在为准，而不是错误名。

Client 为一次逻辑调用创建唯一的 client-side `TransportInfo` facade。Client middleware 在调用 `next` 前即可读取稳定的 `operation() = service/endpoint`，此时尚未选择 target，所以 `endpoint()` 诚实返回空字符串且 request/reply headers 为空；attempt 选定或直接指定 target 后，同一 facade 更新为实际 target 与 wire request headers，响应到达后再更新 reply headers。显式 retry 会在每次 attempt 开始时清空上一轮 reply 并更新 target，调用结束后 facade 表示最终 attempt。

`kind()` 优先读取 Transport 可选的结构式 `kind()`；HTTP provider 返回 `http`，未知、抛错或返回非法 token 的 provider 回退为通用 `transport`。该值只进入 `TransportInfo` 供观测，不参与 endpoint 过滤或拨号决策。

`requestHeaders()` 与 `replyHeaders()` 是实际 Fetch header 的小写、只读 `Metadata` 观察投影。Provider-neutral Metadata 不设 header-token、键数、值长或总量配额，因此超过 64 个 header、大值和 control character 都能完整表达；仅空 key、非 well-formed UTF-16 等 Metadata 本身无法表达的条目会从观察投影省略。任何投影失败都绝不会阻止 dial，也不会把已成功响应改成失败。

调用 Context 中原有的多值 `fromClientContext` 会通过公共 `Go-Like-Metadata` 保留头传播到服务端。编码保留键顺序与多值顺序，拒绝业务请求覆盖保留头；空 metadata 不产生该 header，超过 16 KiB 或无法规范编码时在 discovery / transport I/O 前失败。路由不使用 `Go-Like-Service` 或 `Go-Like-Endpoint` 头；operation 来自 `CallRequest.service` / `CallRequest.endpoint`，请求 path 是 `/<service>/<endpoint>`。

## Middleware

`middleware(...)` 复用 `@go-like/transport` 的 Context-first middleware 契约；第一个声明的 middleware 位于最外层。middleware 看到的是一次逻辑调用的 Context：`TransportInfo` 已经安装，实际 target 会在选择完成后更新。

```ts
import {
  circuitBreakerMiddleware,
  middleware,
  newClient,
  use,
  withDiscovery,
  withEndpoint,
  withTransport,
  type ClientMiddleware
} from "@go-like/client"
import type { Discovery } from "@go-like/registry"
import type { Transport } from "@go-like/transport"

declare const discovery: Discovery
declare const transport: Transport
declare const tracing: ClientMiddleware
declare const metrics: ClientMiddleware

const client = newClient(
  withEndpoint("discovery:///orders-http"),
  withDiscovery(discovery),
  withTransport(transport),
  middleware(
    circuitBreakerMiddleware({
      failureThreshold: 3,
      resetTimeoutMs: 1_000
    })
  ),
  use("orders/*", tracing),
  use("orders/get", metrics)
)
void client
```

上面的 `tracing` / `metrics` 声明只是为了展示 option 形状。`use(selector, ...middleware)` 只接受精确 `token/token`，或尾部 wildcard `*`、`token*`、`token/token*`（包括 `orders/*` 与 `orders/get*`）；token 遵循 URL unreserved route token。匹配时精确 selector 优先，其次是最长尾部 wildcard 前缀，最后回退到 `*`；同一 selector 后声明覆盖前声明。直接 `use()` 会在声明时校验，自定义 `ClientOption` 注入的 Map 会在 `newClient` 构造时重新校验，均在 I/O 前 fail-fast。全局 `middleware(...)` 始终位于 operation middleware 外层。

`circuitBreakerMiddleware` 按已安装的 canonical `service/endpoint` operation 懒建并隔离 breaker。它包围一次逻辑调用，因此显式 retry 的多个 attempt 只产生一个 breaker outcome；open operation 会在 Discovery、Selector 与 Transport I/O 前以 `circuitOpen` 拒绝，不影响其他 operation。Context 取消不改变 breaker health。业务交换完成后的 feedback 或 owner 清理失败始终作为健康 outcome 记录，即使自定义 `isFailure` classifier 要求把所有 rejection 计为失败也不能覆盖该语义。

`ServiceInstance.endpoints` 表示 transport URL，而 `CallRequest.endpoint` 表示 operation。Client 不提供名为 endpoint 的实例 filter，也不会把 URL 冒充服务声明的 operation。

Client 会在 dial 或 Request 构造前验证 Selector 返回严格二元 tuple、非空 well-formed `selected.url` 以及可调用 completion callback；不完整的自定义 Selector 会在任何 target I/O 前失败。completion callback 是严格同步的 `void` 契约。若 TypeScript 的 `void` assignability 放入了 `async` callback，Client 会立即观察其 rejection 防止 `unhandledRejection`，并稳定记录 `TypeError("Selector.select completion callback must return void")`，不会等待其异步完成。

每个已选择的 attempt 都通过 `SelectionOutcome` 报告真实交换阶段：`bytesSent` 在调用 `transportClient.fetch` 之前为 `true`，`bytesReceived` 在 `Response` 到达后为 `true`。dial、fetch、wire 解码和 typed validation 失败不会伪造尚未完成的阶段；直连与 Discovery 选择都产生同一份 selection feedback。服务端流会一直持有该 Transport Client，直到 response body 结束。

成功取得 response 后，selection feedback 必须成功，连接也必须成功回到空闲池，或在超出全局上限、池被禁用时完成关闭，调用才算完整成功。若业务交换已完成但任一后置步骤失败，Client 使用原生 `AggregateError` 报告 `client exchange completed but cleanup failed; do not retry`。`withRetry` 把这一内部已完成事实视为终态，即使调用方的 `shouldRetry` 返回 true、调用 Context 同时取消，也绝不会重放请求或执行 backoff。

每个 Client 默认最多等待 Transport Client `close` 1,000ms，可用 `closeTimeout(ms)` 修改；`0` 明确表示无界等待。正值会把 deadline Context 交给 provider 并在边界后释放调用等待，迟到 fulfillment/rejection 仍持续被观察，不会产生 unhandled rejection。`client.close(ctx)` 会幂等关闭所有空闲和活跃 owner，并等待已经开始的 dial 接纳后关闭迟到 owner；transport 与 discovery 清理由独立 owner 执行并聚合失败，每个 close Context 只限制该调用者的等待。超时使用普通 `Error("transport client close exceeded <ms>ms")`；失败 attempt 仍按既有 cleanup 顺序聚合，首位是主失败。

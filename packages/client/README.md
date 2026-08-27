# @go-like/client

`@go-like/client` 是 go-like 的内部服务调用组合包。它按服务名读取 Discovery 快照并选择端点，再通过 Transport
完成 unary `send`/`recv` 交换。

## unary Client

```ts
import {
  circuitBreakerMiddleware,
  middleware,
  newClient,
  poolSize,
  poolTtl,
  use,
  withAddress,
  withBlock,
  withDiscovery,
  withFilter,
  withRetry,
  withTransport
} from "@go-like/client"
import { background } from "@go-like/context"
import { filterLabel, filterVersion } from "@go-like/registry"
import { exponentialBackoff } from "@go-like/resilience"

const client = newClient(
  withDiscovery(serviceDiscovery),
  withTransport(serviceTransport),
  poolSize(100),
  poolTtl(60_000),
  middleware(
    circuitBreakerMiddleware({
      failureThreshold: 3,
      resetTimeoutMs: 1_000
    })
  )
)
const response = await client.call(background(), {
  service: "orders",
  endpoint: "Create",
  message: { header: {}, body: new Uint8Array([1, 2, 3]) }
})

const directClient = newClient(withTransport(serviceTransport))
const direct = await directClient.call(
  background(),
  {
    service: "orders",
    endpoint: "Get",
    message: { header: {}, body: new Uint8Array() }
  },
  withAddress("https://orders.internal/")
)
await directClient.close(background())

const retried = await client.call(
  background(),
  {
    service: "orders",
    endpoint: "Get",
    message: { header: {}, body: new Uint8Array() }
  },
  withFilter(filterVersion("v2"), filterLabel("zone", "a")),
  withRetry({
    authorization: "idempotent",
    maxAttempts: 3,
    shouldRetry: (_ctx, failure) => failure instanceof TypeError,
    backoff: exponentialBackoff({ initialDelayMs: 20, maxDelayMs: 100 })
  })
)

await client.close(background())
```

同一个 Client 也可直接调用共享的类型化 contract；原始 `CallRequest` API 保持可用：

```ts
const quote = await client.call(background(), quoteEndpoint, {
  amount: 100,
  currency: "CNY"
})
```

类型化和 raw 调用共用 canonical `service/endpoint`。两段 route token 必须只包含 U+0021–U+007E
可见 ASCII，且不得包含 `/`、`*`；Client 不执行 trim，并在 middleware、Discovery 与网络 I/O 前拒绝
非法名称，避免 HTTP header 归一化改名或 operation selector 冲突。

配置 Discovery 的 `newClient` 会按服务名懒加载一个常驻 watcher，并缓存其完整替换快照；同一服务的并发调用共享
一次接纳。watcher 先于首次读取建立；首次 `next()` 只作为 barrier，随后用 fresh `getService()` reconcile，
避免旧的 watcher 初始快照覆盖刚读取的状态。此后的每个完整 replacement snapshot 都是权威状态，包括空数组；
空快照会覆盖旧节点并使调用以 `NoAvailableEndpointError` fail closed。watcher 终止后保留最后一个快照，并在
1 秒退避后重建。调用方必须在不再使用 Client 时执行 `client.close(ctx)`；它会关闭常驻 transport owner、停止全部
watcher，随后任何调用都稳定失败。直接地址 Client 不创建 watcher，但仍使用同一个 `close(ctx)` 生命周期。

默认空 discovery 快照会立即 fail closed。需要等待服务首次就绪时，可在构造中加入 `withBlock()`：

```ts
const waitingClient = newClient(
  withBlock(),
  withDiscovery(serviceDiscovery),
  withTransport(serviceTransport)
)
```

它只等待原始 discovery 快照首次出现至少一个 endpoint，不受 call filter 影响；每个调用仍由自己的 Context
限制等待。服务一旦曾经就绪，后续空快照继续作为权威状态并立即 fail closed，不会保留旧节点。
`client.close(ctx)` 会以稳定的 `client is closed` 唤醒尚未就绪的调用并停止共享 watcher。

默认每次调用只执行一个 attempt；每个 attempt 从当前缓存选择地址，并优先借用该地址唯一的空闲 Transport
Client，没有空闲 owner 才执行 `dial`。同一 owner 不会被并发调用共享；完整交换成功后至多保留一个空闲 owner，
失败 attempt 与同地址多出的并发 owner 立即执行真实 `close`。发现结果只按显式 Registry Filter 过滤，endpoint
对 Client 保持 opaque，并原样交给 Selector；Selector 选出的地址再原样交给 Transport `dial`。协议解析和可拨号性
属于具体 Transport，不由 Client 根据 `kind()` 或 URL scheme 猜测。

空闲池默认在整个 Client 范围最多保留 100 个 owner，并在空闲 60,000ms 后主动关闭。
`poolSize(maxIdle)` 设置全局 idle 上限，使用 Map 插入顺序淘汰最久未使用的 owner；`poolSize(0)`
禁用 idle reuse。`poolTtl(milliseconds)` 设置空闲时间；`poolTtl(0)` 只禁用时间过期，仍受 size
约束。这两个值不是 Transport 并发上限，也不声明底层协议可多路复用。

配置 Discovery 后，Client 会为自身创建独立的 round-robin Selector；`withSelector(...)` 只用于覆盖默认选择策略。
只使用直接地址的 Client 构造时仅需提供 Transport。`withAddress` 使用一个 transport-opaque 地址并完全绕过
Discovery 与 Selector；没有 `withAddress` 的调用才要求 Client 配置 Discovery。`withFilter` 按声明顺序应用
`@go-like/registry` 的 `filterVersion`、`filterLabel` 或用户自定义 Filter，空结果稳定抛出
`NoAvailableEndpointError`。这是 go-micro Selector Filter 的直接 TypeScript 表达，不额外引入 Client 专属过滤 DSL。

默认调用严格执行一次。只有 `withRetry` 同时声明 `authorization`、最大尝试次数和失败判定后才允许重放；backoff
复用 `@go-like/resilience` 的 Context-aware 实现。每次 attempt 从最新 watcher 快照重新选择，但重放的是调用开始时
已经复制的同一 Message。没有并存的 feedback/close failure 时，最终 `ServiceError`、Context error 或 Transport
primary 保留原始 identity；若主失败与 attempt 清理失败同时存在，顶层为 `AggregateError`，`errors[0]` 始终是
primary，其后按 feedback、close 排序。调用 Context 控制调用方的取消与截止时间，注入的 Transport 仍可实施自己的
协议超时策略；只要调用 Context 已经取消，随后由 provider 抛出的独立 `AbortError` 也不会作为节点故障反馈。

Client 为一次逻辑调用创建唯一的 client-side `TransportInfo` facade。Client middleware 在调用 `next` 前即可读取
稳定的 `operation() = service/endpoint`，此时尚未选择 target，所以 `endpoint()` 诚实返回空字符串且 request/reply
headers 为空；attempt 选定或直接指定 target 后，同一 facade 更新为实际 target 与 wire request headers，响应到达
后再更新 reply headers，因此 middleware 的 after 阶段和 Transport 看到同一对象。显式 retry 会在每次 attempt
开始时清空上一轮 reply 并更新 target，调用结束后 facade 表示最终 attempt。

`kind()` 优先读取 Transport 可选的结构式 `kind()`；HTTP provider 返回 `http`，未知、抛错或返回
非法 token 的 provider 回退为通用 `transport`。该值只进入 `TransportInfo` 供观测，不参与 endpoint
过滤或拨号决策；Client 从不解析或调用仅供诊断的 `string()`。

`requestHeaders()` 与 `replyHeaders()` 是实际 unary Message header 的小写、只读 `Metadata` 观察投影。
Provider-neutral Metadata 不设 header-token、键数、值长或总量配额，因此超过 64 个 header、大值和 control
character 都能完整表达；仅空 key、非 well-formed UTF-16 等 Metadata 本身无法表达的条目会从观察投影省略。
任何投影失败都绝不会阻止 dial，也不会把已成功响应改成失败；原始 Message 始终是完整 wire 事实。

调用 Context 中原有的多值 `fromClientContext` 会通过公共 `Go-Like-Metadata` 保留头传播到服务端，并出现在实际 wire
header 投影中。编码保留键顺序与多值顺序，拒绝业务请求覆盖保留头；空 metadata 不产生该 header，超过 16 KiB
或无法规范编码时在 discovery / transport I/O 前失败。具体 Transport provider 只需无损承载 Message headers，
不得重新解释 metadata。

## Middleware

`middleware(...)` 复用 `@go-like/transport` 的 Context-first middleware 契约；第一个声明的 middleware
位于最外层。middleware 看到的是一次逻辑调用的 Context：`TransportInfo` 已经安装，实际 target 会在选择完成后更新。

```ts
const client = newClient(
  withDiscovery(serviceDiscovery),
  withTransport(serviceTransport),
  middleware(
    circuitBreakerMiddleware({
      failureThreshold: 3,
      resetTimeoutMs: 1_000
    })
  ),
  use("orders/*", tracing),
  use("orders/Get", metrics),
  middleware(tracing),
  middleware(metrics)
)
```

`use(selector, ...middleware)` 只接受精确 `token/token`，或尾部 wildcard `*`、`token*`、
`token/token*`（包括 `orders/*` 与 `orders/Get*`）；token 遵循上述 canonical route token 规则。匹配时精确
selector 优先，其次是最长尾部 wildcard 前缀，最后回退到 `*`；同一 selector 后声明覆盖前声明。直接 `use()`
会在声明时校验，自定义 `ClientOption` 注入的 Map 会在 `newClient` 构造时重新校验，均在 I/O 前 fail-fast。
全局 `middleware(...)` 始终位于 operation middleware 外层。

`circuitBreakerMiddleware` 按已安装的 canonical `service/endpoint` operation 懒建并隔离 breaker。它包围一次
逻辑调用，因此显式 retry 的多个 attempt 只产生一个 breaker outcome；open operation 会在 Discovery、Selector
与 Transport I/O 前以 `circuitOpen` 拒绝，不影响其他 operation。Context 取消不改变 breaker health。
业务交换完成后的 feedback 或 owner 清理失败始终作为健康 outcome 记录，即使自定义 `isFailure` classifier
要求把所有 rejection 计为失败也不能覆盖该语义。

go-like 当前 `ServiceInstance.endpoints` 表示 transport URL，而 `CallRequest.endpoint` 表示 operation。Client 不提供
名为 endpoint 的实例 filter，也不会把 URL 冒充服务声明的 operation；未来只有在 Registry 明确保留 operation
声明后才应增加该能力。

Client 会在 dial 或 Request factory 前验证 Selector 返回严格二元 tuple、非空 well-formed `selected.url` 以及可调用
completion callback；不完整的自定义 Selector 会在任何 target I/O 前失败，避免成功调用静默丢失 feedback。
completion callback 是严格同步的 `void` 契约。若 TypeScript 的 `void` assignability 放入了 `async` callback，Client
会立即观察其 rejection 防止 `unhandledRejection`，并稳定记录
`TypeError("Selector.select completion callback must return void")`，不会等待其异步完成。

每个已选择的 attempt 都通过 `SelectionOutcome` 报告真实交换阶段：`bytesSent` 在 `send` fulfillment 后为
`true`，`bytesReceived` 在 `recv` fulfillment 后为 `true`；只有 response 通过 Message snapshot 后才附带
规范化、不可变且与 provider header 独立的 `replyMetadata`。dial、send、recv、wire 解码和 typed validation
失败不会伪造尚未完成的阶段；直连调用不产生 selection feedback。

成功取得 response 后，selection feedback 必须成功，连接也必须成功回到唯一空闲槽或在槽已满时完成关闭，调用才算
完整成功。若业务交换已完成但任一后置步骤失败，Client 使用原生 `AggregateError` 报告
`client exchange completed but cleanup failed; do not retry`。防御快照后的 response 位于标准 `cause`，冻结的
`errors` 固定按 feedback、close 排序。`withRetry` 把这一内部已完成事实视为终态，即使调用方的
`shouldRetry` 返回 true、调用 Context 同时取消，也绝不会重放请求或执行 backoff；用户不需要识别 go-like 专属错误类型。

每个 Client 默认最多等待 Transport Client `close` 1,000ms，可用 `closeTimeout(ms)` 修改；`0` 明确恢复旧有的
无界等待。正值会把 deadline Context 交给 provider 并在边界后释放调用等待，迟到 fulfillment/rejection 仍持续被
观察，不会产生 unhandled rejection。`client.close(ctx)` 会幂等关闭所有空闲和活跃 owner，并等待已经开始的 dial
接纳后关闭迟到 owner；transport 与 discovery 清理由独立 owner 执行并聚合失败，每个 close Context 只限制
该调用者的等待。超时使用普通
`Error("transport client close exceeded <ms>ms")`；失败 attempt 仍按既有 cleanup 顺序聚合，首位是主失败。

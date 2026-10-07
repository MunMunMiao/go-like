# LikeGo 内部端到端 RPC 设计

> 状态：设计稿，API 均为拟议，尚未实现。现有代码是事实来源；本文与代码冲突时以代码为准，本文明确列出的变更除外。

## 1. 定位

LikeGo 内部的端到端 RPC：像 oRPC 一样用 TypeScript 值定义契约、两端强类型、不需要代码生成；
像 go-kratos 一样契约优先、契约与实现分离，并完整复用 LikeGo 已有的 Server、Client、Transport、
Registry、App 生命周期与 ctx-first 约定。

本设计包含六项变更（决策依据与同类产品调研见第 13 节，问题归属见第 14 节）：

1. 新增 `defineService`：契约对象组合现有的 `endpoint`、`registerHandler`、`client.call`，形态与
   `protoc-gen-like` 生成的 `registerXHandler` / `newXClient` 一致（第 3–5 节）；
2. 连接目标统一为 kratos 式的 `withEndpoint`，`@go-like/client` 与 `@go-like/transport-grpc-buf/native`
   同步（第 5.1 节）；
3. 内部 Transport 的传输单位改为标准 Fetch `Request` / `Response`，路由进 URL path，删除 `Go-Like-Service`、
   `Go-Like-Endpoint`、`Go-Like-Target` 等自定义请求头（第 7 节）；
4. 支持服务端流，线上格式为 SSE（第 8 节）；
5. 从 zen-kit 重新迁入 Struct，采用严格字段存在性，删除“零值”设计（第 9 节）；
6. deadline 跨服务传播：新增 `Go-Like-Timeout-Ms` 请求头（第 7.2 节）。

## 2. 命名规则

| 规则                              | 说明                                                                                               | 例子                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `define*` 只用于纯声明            | 没有 IO、没有生命周期，可以被任何一端 import                                                       | `defineService`                                                   |
| `new*` 是构造函数                 | 沿用 Go 与现有代码的约定                                                                           | `newServer`、`newClient`、`newApp`、`payment.newClient`           |
| `register*` 的第一个参数是容器    | 与 kratos `RegisterXServer(s, srv)`、`protoc-gen-like` 的 `registerXHandler(server, handler)` 一致 | `payment.registerHandler(server, handler)`                        |
| 契约派生的类型以 `Service` 为前缀 | 对应生成代码里的 `OrderServiceHandler`、`OrderServiceClient`                                       | `ServiceHandler<typeof payment>`、`ServiceClient<typeof payment>` |
| 连接对象的变量名用 `conn`         | 同 kratos：`conn` 由 `newClient(...)` 创建，业务代理由契约的 `newClient(conn)` 创建                | `const conn = newClient(...)`                                     |

词汇沿用现有代码：Service 是契约服务名，Endpoint 是契约中的一个操作（`Endpoint` 类型），Handler 是服务端实现，
Client 是调用方。`withEndpoint`、`server.endpoint(ctx)`、注册中心的 `endpoints` 中的 endpoint 是地址含义，
与 kratos 一致；两种含义并存。

## 3. 契约（`api/`）

```ts
// apps/payment/api/payment.ts
import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"

const payRequest = struct.object({
  amount: struct.number(),
  currency: struct.string(),
  memo: struct.string().optional()
})

const payResponse = struct.object({
  id: struct.string()
})

const listChannelsResponse = struct.object({
  channels: struct.array(struct.string())
})

const payEvent = struct.discriminatedUnion("type", [
  struct.object({ type: struct.literal("pending") }),
  struct.object({ type: struct.literal("settled"), settledAt: struct.date() })
])

export const payment = defineService("payment.v1", {
  pay: { request: payRequest, response: payResponse },
  listChannels: { response: listChannelsResponse },
  watch: { request: payResponse, response: payEvent, stream: true }
})
```

契约对象的形状：

```ts
payment.name // "payment.v1"
payment.endpoints.pay // Endpoint：{ service, endpoint, request, response, stream }
payment.registerHandler(server, handler)
payment.newClient(conn)
```

规则：

- 服务名只写一次；endpoint 名取自对象键，也只写一次。线上路由是 URL path `/<服务名>/<endpoint 名>`，
  例如 `/payment.v1/pay`（第 7 节）。
- 每个 endpoint 用普通对象 `{ request, response, stream? }` 声明，不需要额外的包装函数。
- 省略 `request` 表示没有请求参数：线上按空对象 `{}` 传输，handler 签名为 `(ctx)`，调用签名为 `(ctx, ...options)`。
- `stream: true` 表示服务端流：`response` 是每一条流消息的 Struct（第 8 节）。多种消息类型用
  `struct.discriminatedUnion` 表达。
- 业务 endpoint 放在 `endpoints` 下，不放在契约对象顶层，避免与 `name`、`registerHandler`、`newClient` 冲突，
  以后给契约增加能力时也不会破坏兼容。
- `payment.endpoints.pay` 是 `Endpoint` 对象，所以原始写法 `client.call(ctx, payment.endpoints.pay, request)`
  和字符串中间件选择器 `use("payment.v1/pay", ...)` 都继续可用。
- 服务名建议带版本号（同 kratos 的 `package todo.v1`）；出现不兼容变更时新建 `payment.v2` 契约，
  同一个 Server 可以同时注册 v1 和 v2。
- 响应建议用对象而不是顶层数组，以后才能在不破坏兼容的前提下增加字段（例如分页的 `nextPageToken`）。

定义期校验（在 `defineService` 调用时抛 `TypeError`）：

- 服务名与键都必须是 URL path 安全的路由 token：只允许 `A–Z a–z 0–9 . _ ~ -`（URL unreserved 字符），
  不需要百分号编码；不能恰好是 `.` 或 `..`（URL 会把它们当作路径段归一化，导致路由不可达）；
- 键不能与 `Object.prototype` 的成员同名（如 `constructor`、`toString`、`__proto__`）；
- `request`、`response` 必须是真正的 Struct（沿用 `isStruct`）；`stream` 只能是 `true` 或省略；
- 至少声明一个 endpoint；
- 产物冻结。

## 4. 服务端

```ts
// apps/payment/internal/server/payment.ts
import type { ServiceHandler } from "@go-like/transport"
import { payment } from "../../api/payment"

export function newPaymentService(uc: PaymentUsecase): ServiceHandler<typeof payment> {
  return {
    async pay(ctx, req) {
      return { id: await uc.pay(ctx, req) }
    },
    async listChannels(ctx) {
      return { channels: await uc.channels(ctx) }
    },
    async *watch(ctx, req) {
      for await (const event of uc.watch(ctx, req.id)) yield event
    }
  }
}
```

```ts
// apps/payment/cmd/main.ts
import { name, newApp, registrar, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newConsulRegistry } from "@go-like/registry-consul"
import { address, newServer, transport } from "@go-like/server"
import { newNodeHTTPTransport } from "@go-like/transport-http/node"

import { payment } from "../api/payment"
import { newPaymentService } from "../internal/server/payment"

const hs = newServer(transport(newNodeHTTPTransport()), address("0.0.0.0:8000"))
payment.registerHandler(hs, newPaymentService(uc))

const app = newApp(
  signal(),
  name("payment"),
  registrar(newConsulRegistry(consulOptions)),
  server(hs)
)
await app.run()
```

规则：

- `ServiceHandler<typeof payment>` 相当于 kratos 的 `v1.PaymentServer` 接口：工厂函数标注返回类型后，
  `ctx`、`req` 与返回值都从契约推导，缺方法或返回值不符合契约都会在编译期报错。
- unary 方法返回 `Infer<Response> | Promise<Infer<Response>>`；流方法返回 `AsyncIterable<Infer<Response>>`，
  通常写成 `async *` 生成器。
- 单独拆出一个方法时用 `ServiceHandler<typeof payment>["pay"]` 标注，不需要运行时函数。
- `payment.registerHandler(server, handler)` 对每个 endpoint 调用带类型的 `server.registerHandler(endpoint, handler)`，
  因此 JSON 编解码、Struct 校验（请求不合法 400、响应不合法 500）、`ServiceError`、重复注册检测、
  启动后禁止注册等行为都保持不变。
- 注册前先检查每个 endpoint 都有对应的函数，缺失时直接抛错，不会出现只注册了一半的情况。
- 调用时以 handler 对象作为 `this`，所以 class 实例也能直接注册。
- 同一个 handler 可以注册到多个 Server（例如生产用 HTTP、测试用 Memory）。
- 服务的名字由 App 决定：`newApp(name("payment"))` 就是注册中心里的服务名，Server 没有名字。
- 生命周期由 App 驱动：`app.run()` 启动 Server 之后才注册到注册中心，停机时先注销再停 Server。
  直接调用 `hs.start()` 不会注册到注册中心。

## 5. 客户端

```ts
// apps/bill/internal/infrastructure/payment.ts
import { newClient, withDiscovery, withEndpoint, withTransport } from "@go-like/client"
import { newHTTPTransport } from "@go-like/transport-http"
import { payment } from "@acme/payment/api"

const conn = newClient(
  withEndpoint("discovery:///payment"),
  withDiscovery(registry),
  withTransport(newHTTPTransport())
)
const paymentClient = payment.newClient(conn)

const response = await paymentClient.pay(ctx, { amount: 100, currency: "USD" })
const channels = await paymentClient.listChannels(ctx)

await using events = await paymentClient.watch(ctx, { id: response.id })
for await (const event of events) {
  if (event.type === "settled") break
}
```

规则：

- `payment.newClient(conn)` 相当于 kratos 的 `v1.NewPaymentHTTPClient(conn)`。它与 Transport 无关，
  所以名字里不带 HTTP；协议由 `conn` 的 `withTransport` 决定。
- `ServiceClient<typeof payment>` 上只有契约里的方法：
  - unary：`(ctx, request, ...options: CallOption[]) => Promise<Infer<Response>>`，内部调用
    `conn.call(ctx, endpoint, request, ...options)`；
  - 流：`(ctx, request, ...options: CallOption[]) => Promise<ServerStream<Infer<Response>>>`，内部调用
    `conn.stream(ctx, endpoint, request, ...options)`（第 8 节）。
- 业务代理只借用 `conn`，没有自己的生命周期；`conn.close(ctx)` 由创建它的一方负责。
- 一个 `conn` 对应一个发现目标（一个 App），它可以同时服务这个 App 上注册的多个契约：
  `payment.newClient(conn)`、`bill.newClient(conn)`。
- 按 kratos 的分层，调用其他服务的代理放在 infrastructure 层，藏在 application 层声明的接口后面。

### 5.1 连接目标：`withEndpoint`

按 kratos 的心智，连接目标只用一个选项 `withEndpoint` 表达，取代现有的 `withAddress` 与 `withService`：

```ts
// 服务发现：路径就是 App 名
newClient(
  withEndpoint("discovery:///payment"),
  withDiscovery(registry),
  withTransport(newHTTPTransport())
)

// 直连：一个或多个地址
newClient(withEndpoint("https://payment.internal"), withTransport(newHTTPTransport()))
newClient(
  withEndpoint(["https://10.0.0.1:8000", "https://10.0.0.2:8000"]),
  withTransport(newHTTPTransport())
)

// 进程内：Memory Transport，常用于测试
newClient(withEndpoint("memory://payment"), withTransport(memoryTransport))
```

签名：`withEndpoint(endpoint: string | readonly string[]): ClientOption`。

两种来源最终汇聚到同一条调用链：

```text
discovery:///payment ──> Discovery.getService("payment") ──┐
                                                           ├──> 实例列表 ──> filter ──> Selector ──> 连接池 ──> Transport
https://a, https://b ──> 静态实例（directInstances）────────┘
```

这条链路在现有代码中已经成立（`packages/client/src/index.ts` 的 `attempt`：直连地址经 `directInstances`
转成实例，服务发现经 `resolver.getService`，之后共用 filter、Selector 与连接池）。`withEndpoint`
只在入口把 URI 解析成两种来源之一，不改动后续链路。

规则：

- `discovery:///<name>`：`<name>` 是目标 App 名，不能为空，authority 必须为空；必须同时配置 `withDiscovery`。
- 其他 scheme（`http://`、`https://`、`memory://`）是直连地址，由 Transport 解析；可以传数组，
  数组内的地址由 Selector 负载均衡，连接由连接池管理。
- HTTP 直连地址必须是根 URL（不带 path、query、fragment、credentials），因为 path 用于路由（第 7 节）；
  与 grpc-buf 现有的 `canonicalAddress` 规则一致。这条规则由 `@go-like/transport-http` 在解析地址时执行；
  `@go-like/client` 不知道 Transport 的协议，只校验字符串边界、重复地址和 `discovery:///` 规则，其他直连地址原样交给 Transport。
- `discovery:///` 只能单独使用，不能出现在数组里、也不能与直连地址混用（沿用现有
  “cannot combine direct addresses with discovery” 约束）。
- 错误发生的时机：
  - 空字符串、空数组、数组内重复地址、数组内出现 `discovery:///`：调用 `withEndpoint` 时立即抛错；
  - 配置了 `withDiscovery` 但 endpoint 不是 `discovery:///`，或 `discovery:///` 缺少 `withDiscovery`：`newClient` 构造时抛错。
- `withEndpoint` 与其他函数式选项一样按声明顺序归约，重复声明时后一个覆盖前一个。

`@go-like/transport-grpc-buf/native` 同步采用同一规则：

```ts
import { newClient, withDiscovery, withEndpoint } from "@go-like/transport-grpc-buf/native"

const conn = newClient(withEndpoint("discovery:///orders-grpc"), withDiscovery(registry))
const orders = newOrderServiceClient(conn)
```

- 它的 `withAddress(...)`、`withService(...)` 同样由 `withEndpoint` 取代并移除；
- 直连地址沿用现有 `canonicalAddress`：`http://` 或 `https://` 根 URL；
- `docs/superpowers/specs/2026-08-28-buf-connect-grpc-integration-design.md` 第 10 节列为后续目标的
  `discovery:///` target 由此落地；`grpc://`、`grpcs://` scheme 不在本设计范围内。

## 6. 三个名字

一次调用涉及三个彼此独立的名字：

| 名字        | 来源                                                           | 用途                               | 例子      |
| ----------- | -------------------------------------------------------------- | ---------------------------------- | --------- |
| 发现名      | `newApp(name(...))`，客户端 `withEndpoint("discovery:///...")` | 服务发现、选节点                   | `payment` |
| 契约服务名  | `defineService(name, ...)`                                     | URL path、中间件选择器、日志与指标 | `bill.v1` |
| endpoint 名 | 契约对象的键                                                   | URL path、中间件选择器、日志与指标 | `findOne` |

例如 payment 这个 App 同时注册了 `bill.v1` 契约，调用 `findOne` 时：服务发现找 `payment`，选中节点
`http://10.0.0.1:8000` 后，请求是 `POST http://10.0.0.1:8000/bill.v1/findOne`。

一个 App 只能发布同一种协议的地址（`app Endpointer protocols must match`），所以同一个服务同时提供
HTTP 与 gRPC 时，要用两个 App 名，例如 `payment` 与 `payment-grpc`（参见
`docs/developer-experience-alignment.md` 中的 `orders-http` / `orders-grpc`）。

## 7. 线上协议：Fetch `Request` / `Response`

### 7.1 传输单位

内部 Transport 的传输单位从自定义 `Message { header, body }` 改为标准 Fetch `Request` / `Response`。
Bun、Node.js、Deno 都支持构造任意 scheme 的 `Request`（已验证 `new Request("memory://payment/payment.v1/pay")`
在三个运行时的 `url`、`method`、`body` 均正常），也都支持以 `ReadableStream` 为 body 的 `Response`。
因此路由、方法、状态码、内容类型与流式 body 全部由标准字段表达：

| 信息                | 旧载体                                                                   | 新载体                                                    |
| ------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| 服务名、endpoint 名 | `Go-Like-Service`、`Go-Like-Endpoint` 请求头                             | `new URL(request.url).pathname` = `/<service>/<endpoint>` |
| HTTP 方法           | `Go-Like-Method` 请求头                                                  | `request.method`                                          |
| 请求路径            | `Go-Like-Target` 请求头                                                  | `request.url`                                             |
| 响应状态            | `Go-Like-HTTP-Status`（server 内部）、ServiceError 的 carrier status 200 | `response.status`                                         |
| ServiceError 标记   | `Go-Like-Service-Error`、`-Code`、`-Status` 响应头                       | 非 2xx 状态 + JSON body（7.3）                            |
| mTLS 对端身份       | `Go-Like-Peer-Identity` 请求头                                           | 请求 ctx 上的 TransportInfo（7.5）                        |
| 流式响应            | 不支持                                                                   | `response.body`（`ReadableStream`）                       |
| 调用方剩余时间      | 不传播                                                                   | 新增 `Go-Like-Timeout-Ms` 请求头（7.2）                   |

Transport SPI 随之简化：

```ts
/** 服务端处理一个请求；ctx 由 Transport 为每个请求派生，request.signal 中止时 ctx 取消。 */
type TransportHandler = (ctx: Context, request: Request) => Response | Promise<Response>

/** 到一个地址的可复用连接。 */
interface Client {
  fetch(ctx: Context, request: Request): Promise<Response>
  close(ctx: Context): Promise<void>
}

/** 一个已绑定的监听地址。 */
interface Listener {
  addr(): string
  serve(ctx: Context, handler: TransportHandler): Promise<void>
  close(ctx: Context): Promise<void>
}

interface Transport {
  dial(ctx: Context, address: string, ...options: readonly DialOption[]): Promise<Client>
  listen(ctx: Context, address: string, ...options: readonly ListenOption[]): Promise<Listener>
  // init、options、string、kind 保持不变
}
```

删除：`Message`、`Socket`、`AcceptHandler`、`MessageCodec`（及 `Options.codec`）、`ServiceErrorEnvelope`
的 carrier status 概念。Transport 只负责把 `Request` 送到对端、把 `Response` 带回来，不再解释路由头。

迁移方式：一次性破坏性变更，不保留兼容层（各包均为 0.0.1、未发布）。

- 不提供 `legacy` 子入口、`registerLegacyHandler`、`legacyMiddleware` 或旧选项的兼容导出；`withAddress`、`withService`、
  旧 Message 形状的 `Handler` / `Middleware` / `CallRequest` 一并删除。
- 原始 handler 只有一种形状 `(ctx, request: Request) => Response | Promise<Response>`；不得根据参数或异常在运行时猜测形状。
  预演练中出现过“先按旧形状调用、失败再按新形状调用”的兼容实现，会让有副作用的 handler 执行两次。
- 同一次变更内迁移全部调用方：packages、examples、e2e、published consumer fixture、README 与 `doc/` 各语言译本；
  合并条件是全仓 `bun run typecheck` 与 `bun run test:unit` 通过。预演练中未迁移的调用方包括
  `examples/commerce-catalog`、`examples/healthcare-appointments`、`examples/enterprise-platform-runtime`、
  `examples/telecom-service-provisioning`、`packages/transport/http` 中以 `/rpc` 作为拨号地址或断言旧路由头的测试（16 个）。
- 同一文件不要拆给并行任务：预演练中 `withEndpoint` 被两个并行任务各实现一次，合并时 8 个文件冲突。
  `@go-like/transport`、`@go-like/server`、`@go-like/client` 的改动按 7 → 3–6 → 8 的顺序串行完成，Struct（第 9 节）可以并行。

### 7.2 unary 调用

```http
POST /payment.v1/pay HTTP/1.1
Content-Type: application/json
Go-Like-Timeout-Ms: 4870
Go-Like-Metadata: ...

{"amount":100,"currency":"USD"}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"id":"p-001"}
```

- 客户端在选中节点后构造 `new Request(new URL("/payment.v1/pay", 节点地址), { method: "POST", headers, body })`；
  请求 body 是编码好的字节，所以重试时可以重放。
- 只接受 `POST`。内部调用不依赖 HTTP 缓存；需要对浏览器或 CDN 以 GET 暴露时使用 `httpRoute`。
- 服务端要求 `Content-Type: application/json`（沿用现有检查），用请求 Struct 严格解析，失败返回 400；
  响应用响应 Struct 编码，失败返回 500。
- 线上只保留两个 Go-Like 请求头：
  - `Go-Like-Metadata`：ctx metadata 的跨服务传播，编码与选择性传播规则不变；
  - `Go-Like-Timeout-Ms`：deadline 传播，见下。

deadline 传播（对应 gRPC 的 `grpc-timeout`、Connect 的 `Connect-Timeout-Ms`、go-micro 的 `Timeout`）：

- 客户端 ctx 带 deadline 时，每次尝试发送前按剩余毫秒数（向上取整）写入 `Go-Like-Timeout-Ms`；重试时重新计算。
  ctx 没有 deadline 时不发送该头。
- 服务端把请求 ctx 的 deadline 设为“收到请求的时刻 + 该值”与服务端自身限制中较早的一个；handler 发起的下游调用
  继承这个 ctx，因此剩余时间沿调用链逐跳递减。
- 值必须是非负十进制整数，否则返回 400（`invalid_request`）；值为 0 时请求 ctx 立即超时。
- 流调用同样适用，deadline 覆盖整条流。
- 服务端必须保存 `withDeadline` 返回的 cancel 函数，并在 `Response.body` 结束（读完、出错或被 cancel；没有 body 时为交付时）时调用，
  unary 与流一致（8.3），不得遗留定时器。
- 下游 ctx 的取消原因不一定是 `DeadlineExceeded`：上游超时后会先中止请求，下游可能先观察到 `Canceled`。
  判断 deadline 是否传播，应检查下游 ctx 是否带有 deadline，而不是比较最终的错误名。

### 7.3 错误

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{"code":"payment_not_found","message":"payment not found","metadata":{"id":"p-001"}}
```

- `ServiceError` 编码为：`response.status` = `error.status`，`Content-Type: application/json`，
  body 为 `{ code, message, metadata }`。
- body 顶层键严格为 `code`、`message`、`metadata`，不含 `status`：状态只取自 `response.status`。解码时校验键集合、字段类型、
  大小上限，不读取也不生成任何 `Go-Like-Service-Error*` 头。
- 客户端收到非 2xx、media type 为 `application/json` 且 body 完全符合上述形状时，还原并抛出 `ServiceError`；
  调用方从异常读取 `code`、`status`、`metadata`，原始 `call` 也不会把它当作普通响应返回。其他非 2xx 响应
  （例如代理返回的 502 HTML 页面）作为 Transport 层错误处理，不冒充业务错误。

### 7.4 服务端路由

服务端对每个 `Request` 按下面的顺序匹配：

1. 显式注册的 `httpRoute(method, path, ...)`，精确匹配 method 与 pathname；命中后不做内部 RPC 的 POST / JSON 检查；
2. `/<service>/<endpoint>`：先查注册表，未注册一律返回 404（`not_found`，7.3 格式），不因缺少 Content-Type 改成 400；
   已注册时方法必须是 `POST`（否则 405）、Content-Type 必须是 JSON（否则 400），然后创建请求 ctx，进入中间件与 handler；
3. `GET` / `HEAD /healthz`：200；
4. 其他：404。

`httpRoute` 的目标 endpoint 必须在 Server 封口前注册。

- 路径不加前缀，与 gRPC、Connect 的 `/pkg.Service/Method` 一致；内部服务通常独占端口，`httpRoute` 精确匹配优先，
  已能避免冲突。以后需要把内部 RPC 挂到网关子路径下时，再为客户端直连地址增加路径前缀支持（同 Connect `baseUrl`）。
- 现有代码用“是否带 `Go-Like-Service` 头”区分内部调用与 `httpRoute`，改为上面的 path 规则后不再需要。
- 暴露面不变：以前任何能访问端口的人都能带上 `Go-Like-Service` 头调用内部 endpoint，现在是按 path 调用。
  内部服务端口仍不应直接暴露到公网，鉴权交给中间件。
- `TransportInfo.operation()` 由 pathname 得出，值仍是 `payment.v1/pay`，与中间件选择器格式一致。

### 7.5 各 Transport

- **HTTP**：客户端就是 Fetch（沿用现有的 Node 连接池 executor）；服务端 host 直接把 `Request` 交给
  `TransportHandler`，返回的 `Response` 原样写回。mTLS 校验得到的对端身份放进请求 ctx 的 TransportInfo
  （`peerIdentity()`，值为已验证的 URI SAN，未认证时为 `null`），不再写成请求头（避免与客户端伪造的同名头混淆）。
  - 请求 URL 用 `new URL(path, 节点地址)` 构造，不用字符串拼接。
  - 连接在 `Response.body` 读到结尾、出错或被 cancel 之后才归还连接池。typed `call` 与 `stream` 由框架负责读完或关闭 body；
    原始 `call` 返回的 `Response` 由调用方负责读完或 `response.body?.cancel()`，否则该连接一直被占用。
- **Memory**：继续保留，用于单元测试与单进程多服务。`listen("memory://payment")` 在进程内登记
  `TransportHandler`；`dial` 得到的 `Client.fetch` 直接调用它，`Request` / `Response` 对象原样传递，
  流式 body 天然可用。与 HTTP 走完全相同的服务端路由、编解码与 SSE 路径。
  - 客户端中止请求时，Memory 必须把它映射为服务端请求 ctx 的取消（与 HTTP 的 `request.signal` 行为一致）；
    流的请求 ctx 生命周期见 8.3。
- **gRPC（grpc-buf）**：使用 Connect 自己的协议与 transport，不经过 go-like Transport SPI，本节不影响它。

## 8. 服务端流（SSE）

### 8.1 使用方式

契约里用 `stream: true` 声明（第 3 节），服务端返回 `AsyncIterable`（第 4 节），客户端拿到 `ServerStream`：

```ts
interface ServerStream<T> extends AsyncIterable<T>, AsyncDisposable {
  /** 主动结束流并取消底层请求；幂等。 */
  close(): Promise<void>
}

await using events = await paymentClient.watch(ctx, { id })
for await (const event of events) {
  // event 的类型是 Infer<typeof payEvent>
}
```

- 先 `await` 再迭代（同 oRPC、grpc-go）：`await paymentClient.watch(...)` 在收到响应头（握手）后返回，
  是握手完成的明确时点，也便于 `await using` 管理关闭。
- 错误分两个时点抛出：
  - `await` 时：服务发现、选节点、连接失败，以及调用 handler 之前的错误（路由、请求解码或校验、中间件拒绝）；
  - `for await` 时：handler 体内的任何错误（包括产出第一条消息之前抛出的）、消息不符合响应 Struct、流被截断。
    需要在 `await` 时就失败的检查，放进中间件或请求 Struct。
- `CallOption` 中的重试只作用于握手之前；收到响应头后调用即视为已提交，不再重试（同 gRPC 重试规范）。
- 流只能迭代一次；`break`、`close()`、`await using` 离开作用域或 ctx 取消，都会中止底层请求。
- 结束语义：只有收到 `end` 事件，或消费者自己 `break` / `close()` / `await using` 离开作用域时，迭代才正常结束（`done`）。
  调用方 ctx 被取消或 deadline 到期时，无论迭代尚未开始、正在等待还是处于两条消息之间，后续 `next()` 都以 ctx 的错误
  （`canceled` / `deadlineExceeded`）拒绝，不会表现为正常结束。
- 终态优先级（按发生先后判定）：
  - 调用方 ctx 失败之后，不再产出任何消息，包括已经读入缓冲区的数据帧与 `end`/`error` 帧；后续 `next()` 以 ctx 错误拒绝；
  - 消费者先 `close()` / `break`，随后（或同时）等待中的 `next()` 与之后的 `next()` 都正常结束（`done`），不得被报告为截断；
  - 调用方 ctx 先失败、消费者随后 `close()`：`close()` 正常完成，`next()` 仍以 ctx 错误拒绝；
  - ctx 健康时，服务端先到的 `error` 事件照常以 `ServiceError` 抛出。
- 中止底层 body 是尽力而为的清理：`close()` / `return()` 以及终态结果或错误（含 `resource_exhausted`）的交付只负责发起取消，
  不等待底层 `cancel()` 的 Promise 完成（例如 `Response.clone()` 留下未读副本时，该 Promise 可能长期不完成）。
- 底层 API：`conn.stream(ctx, endpoint, request, ...options): Promise<ServerStream<Infer<Response>>>`，
  与 `conn.call` 对应；`client.call` 保持只处理 unary。
- 只支持服务端流。客户端流与双向流使用 `@go-like/transport-grpc-buf/native`。

### 8.2 线上格式

请求与 unary 相同，额外带 `Accept: text/event-stream`。成功时：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

:

data: {"type":"pending"}

:

data: {"type":"settled","settledAt":"2026-09-28T08:00:00.000Z"}

event: end
data: {}

```

第一行 `:` 是握手时立即发送的初始注释，后面的 `:` 是心跳（8.3）。

业务中途失败时：

```text
event: error
data: {"code":"internal","message":"...","status":500,"metadata":{}}

```

规则：

- 每条业务消息是一个默认事件（不写 `event:` 行），`data` 是用响应 Struct 编码的单行 JSON。
- `end` 与 `error` 是协议保留的终止事件。业务消息从不使用 `event:` 字段，所以不会与它们冲突。
- 客户端：默认事件按响应 Struct 严格解析后产出；`end` 结束迭代；`error` 抛出还原的 `ServiceError`；
  连接在收到终止事件之前断开，抛出 Transport 协议错误（流被截断），不会被当成正常结束。
- 未知事件名、注释行（`: ...`）、`id`、`retry` 字段一律忽略。
- 路由失败、请求解码或校验失败、中间件拒绝，都发生在调用 handler 之前，按 unary 错误返回（7.3），不进入 SSE。
- 调用 handler 后立即发送响应头与一条初始注释（同 oRPC 的 `initialComment`、tRPC 的 `connected` 事件），
  不等待第一条消息；因此首条消息很慢的流不会让客户端的 `await` 阻塞，途经的代理也能立刻收到响应头。
- “调用 handler 后”的精确含义：`async *` 函数被调用时只返回迭代器，函数体要到第一次 `next()` 才执行。因此：
  - handler 函数调用本身同步抛错：属于 handler 之前的错误，按 unary 返回；
  - 调用返回的值不是 `AsyncIterable`：发送 `error` 事件（`internal`，500）并结束流；
  - 第一次或之后任何一次 `next()` 抛错（包括生成器在产出第一条消息之前抛出）：发送 `error` 事件并结束流。
- 响应头发出后，handler 体内的任何错误都以 `error` 事件发送并结束流。
- 服务端产出的消息不符合响应 Struct 时，发送 `error` 事件（`internal`，500）并结束流。

### 8.3 运行时语义

- **背压**：服务端用 pull 模式的 `ReadableStream`，不在调用 handler 时预先遍历生成器；客户端按需读取，不设内部队列。
  - Memory：客户端每次 `next()` 对应服务端一次 pull，服务端最多领先 1 条；
  - HTTP：服务端受运行时与 socket 缓冲区限制，允许有限预取，会领先客户端若干条（与 gRPC、Connect 在 HTTP/2 流控窗口内的行为一致）；
    预取量有上限，不会无限占用内存，但不承诺与客户端的 `for await` 逐条对应；
  - 因此生成器里不得执行“以对方已收到为前提”的副作用（例如每产出一条就标记为已发送）：客户端提前停止时，
    已预取但未送达的消息的副作用已经发生。需要确认送达时，由客户端处理完后调用一个 unary 方法提交游标（第 14 节）。
- **请求 ctx 覆盖整条流**（同 Go：gRPC 服务端流的 `stream.Context()`、`net/http` 的 `r.Context()` 都存活到 handler 结束）：
  - handler 拿到的 ctx 从握手一直存活到流结束，生成器里可以继续用它调用下游服务、读取 metadata 与 deadline；
  - “流结束”是以下事件中最先发生的一个：生成器正常结束（发送 `end` 后）、生成器抛错（发送 `error` 后）、
    客户端断开或 cancel、deadline 到期、服务端停机；
  - 流结束时依次：取消请求 ctx、调用迭代器的 `return()`（生成器的 `finally` 执行）、释放 deadline 定时器；
  - 实现上请求 ctx 的清理必须绑定在 `Response.body` 的生命周期上，不能在 handler 返回 `Response` 时执行。
    预演练中 Memory transport 在返回 `Response` 时就结束了请求 ctx，导致生成器里的下游调用被取消，这是错误行为。
- **取消**：客户端中止请求 → 服务端 `request.signal` 中止 → 请求 ctx 取消，并调用迭代器的 `return()`，
  生成器的 `finally` 会执行。
- **截止时间**：客户端 ctx 的 deadline 覆盖整条流，并通过 `Go-Like-Timeout-Ms` 传到服务端（7.2）；
  长时间的流需要调用方给足 deadline。
- **大小限制**（同 gRPC 的 `MaxSendMsgSize` / `MaxRecvMsgSize`，两端各自配置，不要求一致）：
  - 服务端发送上限：服务端选项 `maxSendMessageBytes(bytes)`，默认 4 MiB；产出的消息编码后超限时，发送 `error` 事件并结束流；
  - 客户端接收上限：沿用 Transport 的 `maxMessageBytes`；收到的事件超限时，取消底层请求并抛出错误；
  - 两种情况的错误 code 都是 `resource_exhausted`，status 429（与 Connect、grpc-gateway 对 `RESOURCE_EXHAUSTED` 的 HTTP 映射一致），
    错误信息写明实际字节数、上限与超限的一方，不再是笼统的协议错误；
  - 大小按 UTF-8 编码后的完整 SSE 事件计算（含字段前缀与结尾空行）；整条流不设总大小。
- **心跳**：默认开启，服务端在流空闲时每 15 秒发送一条 `:` 注释行（同 oRPC 默认值）；间隔由服务端选项
  `streamKeepAlive(intervalMs)` 调整，传 `0` 关闭。常见代理的空闲超时约 60 秒（如 nginx `proxy_read_timeout`），
  HTTP/1.1 下没有 HTTP/2 PING 可用。客户端忽略注释行，不把心跳当作消息。
- **不自动重连**（同 gRPC、Connect）：重连等于重新执行一次调用，自动做可能重复副作用；`id`、`retry` 字段被忽略。
  需要续传的业务在请求 Struct 里带游标字段，由调用方显式重新发起调用。

### 8.4 实现来源

- SSE 解析器从 zen-kit `packages/core/src/sse/transport/parser.ts`（改编自 Azure/fetch-event-source，MIT）迁入
  `packages/transport/src/sse/parser.ts`，通过 `@go-like/transport` 的新子入口 `./sse` 导出，同时提供服务端使用的事件编码函数。
  许可证条目写入 `packages/transport/THIRD_PARTY_NOTICES.md`，并确认它包含在发布包内。client 与 server 都已依赖 `@go-like/transport`。
- 不迁入 zen-kit 的 `event_stream.ts`（浏览器侧 fetch、自动重连、推送队列）与 `sse.ts`（defjs endpoint、
  事件名映射表）：RPC 场景下重连语义不正确，pull 模式不需要队列，单一响应 Struct 取代事件名映射表。

## 9. Struct：从 zen-kit 重新迁入

### 9.1 来源与方式

- 来源：`zen-kit/packages/core/src/struct`，版本 `5ba9f6b`（当前 HEAD）。
- 以本项目的方式融合：
  - 包名、入口保持不变：`@go-like/struct` 的 `"."`、`"./codec"`、`"./runtime"`；
  - 测试从 vitest `*.spec.ts` 改为 `packages/struct/test/*.test.ts`（`bun:test`），类型测试沿用 `*.type-test.ts`，
    浏览器用例沿用现有的 `constructors.browser.test.ts` 组织方式；
  - 代码风格按本仓库 oxfmt 配置格式化；
  - 保留原 MIT 许可说明；
  - 覆盖 `packages/struct/src` 前先对照现有测试，确认每项行为差异都在 9.2 的清单里。
- 保留本项目已有、zen-kit 没有的安全边界：原型污染防护、循环 value graph 检测、1000 层深度上限，并改写为严格语义下的断言；
  其中安全预扫描只遍历数据属性，不触发 getter（否则会破坏“第一个字段失败后不读取后续 getter”的行为）。
- 删除或改写只验证 Go 零值、Unicode simple fold、dominant-field、重复 wire key 合并、record UTF-8 排序和全局 `setErrorMap` 的旧用例；
  保留三个入口的运行时 e2e、公开类型负向测试与递归 getter 测试。

### 9.2 行为变化

| 行为                      | 现在（Go `encoding/json` 基线）                  | 迁入后                                                             |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| 缺失的必填字段            | 取零值（`""`、`0`、`false`、`[]`）               | `StructError`                                                      |
| 非 nullable 字段为 `null` | 取零值                                           | `StructError`                                                      |
| `.optional()` 字段缺失    | 省略                                             | 省略（不变）                                                       |
| 未知字段                  | 丢弃                                             | 丢弃（不变）                                                       |
| 字段名匹配                | 精确匹配优先，回退到 Unicode simple fold         | 只精确匹配                                                         |
| 重复的 wire key           | Go dominant-field 规则，重复字段按顺序合并       | 定义期 `TypeError`                                                 |
| 解析失败                  | all-or-throw                                     | 在第一个问题处停止，不暴露部分结果（不变）                         |
| 独立解析                  | 无公开入口                                       | `struct.parse(schema, input, { errorMap? })` 返回 `[error, value]` |
| 错误信息定制              | 全局 `setErrorMap`                               | 每次解析的 `errorMap` 选项；删除 `setErrorMap`                     |
| 公开类型                  | `AnyStruct`、`Infer`、`Struct`、`StructIssue` 等 | 增加 `StructInput`、`ParseResult`、`ObjectStruct`、`StructLike`    |

- 删除 Go 兼容层：`codec/go-unicode-fold.ts`、dominant-field 规则与重复 key 合并；README 的
  “Go 兼容基线”一节改写为严格语义说明。与 Go 服务互通不受影响：Go `encoding/json` 编码时使用精确的
  tag 名，TypeScript 编码的 JSON 也能被 Go 的解码器接受。
- 对 RPC 的影响：服务端对缺字段的请求返回 400（`invalid_request`），客户端对缺字段的响应报错，
  不再静默得到零值。

细则：

- 三个修饰符的区别（预演练中在 `bank-transfer-gateway` 示例里发现把“可省略”误写成 `null()`，严格模式下请求被拒）：

  | 修饰符        | 字段缺失 | 值为 `null` |
  | ------------- | -------- | ----------- |
  | 无            | 错误     | 错误        |
  | `.optional()` | 省略该键 | 错误        |
  | `.null()`     | 错误     | 保留 `null` |
  | `.nullish()`  | 省略该键 | 保留 `null` |

- 重复 wire key（`alias ?? key`）：静态字段在 `struct.object(...)` 定义时抛 `TypeError`；使用 getter 定义的递归字段
  无法在定义时读取（会触发变量的暂时性死区），在第一次解析时抛 `TypeError`。
- `struct.parse(schema, input, options?)`：
  - 返回 `[error: null, value: O] | [error: StructError, value: undefined]`，失败时只包含第一个问题，不存在部分结果；
  - 默认按 TypeScript 属性名读取输入；传 `{ aliases: true }` 时按 `alias ?? key` 读取；`decodeJson` 始终按 wire key 读取；
    两者都只做精确匹配，输出属性始终是 TypeScript 属性名；
  - `errorMap` 只作用于本次解析及其嵌套字段，不影响下一次解析；根入口不再导出 `setErrorMap`，也没有全局错误映射状态。
- `decodeJson` 按 schema 泛型返回 `Infer<S>`，消费方不需要再做类型断言。
- 交集（`intersection`）的成功结果是两侧解析结果的**深合并**，保证满足两侧的类型：
  - 两侧都是普通对象：同名字段递归合并；
  - 两侧都是数组（含根节点、tuple、嵌套数组）：要求长度相同并逐元素递归合并；长度不同返回 `StructError`，不得静默丢弃元素或字段；
  - 其他情况采用后一侧的值；
  - 合并深度计入同一个 1000 层上限。parse、alias 解码、`decodeJson`、各编码入口与 JSON body 往返使用同一套合并规则。
- 公开入口不得因递归过深抛出 `RangeError`。容器深度上限为 1000 层；递归使用 `or()` / `discriminatedUnion()` 的 schema
  每层消耗更多调用帧，若在默认栈上无法达到 1000 层，必须返回受控的 `StructError`，并在 `packages/struct/README.md` 写明各运行时实际可达的层数。
- 缺失必填字段的错误信息写明字段路径，并附加提示 `Use optional() or nullish() if the field may be omitted`（第 14.3 节）。

### 9.3 不迁入

- `struct.request`、`struct.json`、`struct.urlencoded`、`struct.formData`、`struct.text` 与 `RequestStruct`：
  它们是 defjs HTTP endpoint 的 request section 与 body codec，内部 RPC 的 body 固定为 JSON。
- `struct.bench.ts`：依赖 defjs 内部的 `request_builder`。
- zen-kit README 中 HTTP tuple、`REQ_*` / `RES_*` fault 等 endpoint 层内容。

## 10. 与 go-kratos、protoc-gen-like 的对应

| 概念             | go-kratos                                | protoc-gen-like                                | LikeGo 端到端 RPC                          |
| ---------------- | ---------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| 契约             | `api/payment/v1/*.proto`                 | `.proto`                                       | `api/payment.ts` 中的 `defineService(...)` |
| 实现类型         | `v1.PaymentServer`                       | `OrderServiceHandler`                          | `ServiceHandler<typeof payment>`           |
| 注册             | `v1.RegisterPaymentHTTPServer(srv, svc)` | `registerOrderServiceHandler(server, handler)` | `payment.registerHandler(server, handler)` |
| 连接             | `http.NewClient(ctx, WithEndpoint(...))` | `newClient(withEndpoint(...))`（native）       | `newClient(withEndpoint(...), ...)`        |
| 业务代理         | `v1.NewPaymentHTTPClient(conn)`          | `newOrderServiceClient(conn)`                  | `payment.newClient(conn)`                  |
| 操作名           | `/payment.v1.Payment/Pay`                | Protobuf 全名                                  | `/payment.v1/pay`                          |
| 服务端流         | HTTP 映射为 SSE（v3）                    | server-streaming                               | `stream: true`，SSE                        |
| 客户端流、双向流 | gRPC；HTTP 映射为 WebSocket（v3）        | 支持（native）                                 | 不支持，使用 grpc-buf                      |
| 代码生成         | 需要                                     | 需要                                           | 不需要                                     |

## 11. 实施范围

### 11.1 包

| 包                                                                          | 变更                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@go-like/struct`                                                           | 按第 9 节重新迁入                                                                                                                                                                                                                                                                                                            |
| `@go-like/transport`                                                        | 新增 `defineService`、`ServiceHandler`、`ServiceClient`、`ServerStream`；`Endpoint` 增加 `stream` 字段；路由 token 收紧为 URL unreserved 字符；SPI 改为 `Request` / `Response`（7.1）；ServiceError 编解码改为状态码 + JSON（7.3）；新增 `./sse` 子入口；`./headers` 只保留 `Go-Like-Metadata` 与新增的 `Go-Like-Timeout-Ms` |
| `@go-like/server`                                                           | 按 path 路由（7.4）；原始 `Handler`、`Middleware` 改为处理 `Request` / `Response`；支持流 endpoint；删除 `Go-Like-HTTP-Status`；读取 `Go-Like-Timeout-Ms` 设置请求 ctx 的 deadline；流握手后立即发送初始注释，新增选项 `streamKeepAlive(intervalMs)`（默认 15000，`0` 关闭）与 `maxSendMessageBytes(bytes)`（默认 4 MiB）    |
| `@go-like/client`                                                           | `withEndpoint` 取代 `withAddress`、`withService`；原始 `CallRequest` 改为 `{ service, endpoint, headers, body }`，原始 `call` 返回 `Response`；新增 `stream`；按 ctx 剩余时间写 `Go-Like-Timeout-Ms`                                                                                                                         |
| `@go-like/transport-http`                                                   | 客户端按 `Request` 发送、服务端把 host 收到的 `Request` 交给 handler；直连地址限定为根 URL；对端身份改放 ctx                                                                                                                                                                                                                 |
| `@go-like/transport-memory`                                                 | 进程内直接传递 `Request` / `Response`                                                                                                                                                                                                                                                                                        |
| `@go-like/transport-grpc-buf`                                               | `/native` 的 `withEndpoint` 取代 `withAddress`、`withService`（5.1）                                                                                                                                                                                                                                                         |
| `@go-like/otel`、`@go-like/prometheus`、`@go-like/pino`、`@go-like/winston` | 不再读取 `Go-Like-Service` / `Go-Like-Endpoint` 头：客户端读 `CallRequest` 的 `service`、`endpoint`，服务端读 `TransportInfo.operation()`；流调用按 11.4 记录                                                                                                                                                                |

### 11.2 不变

- 契约层的 `endpoint(service, name, request, response)`、带类型的 `registerHandler(endpoint, handler)` 与
  `client.call(ctx, endpoint, request)`；
- `Go-Like-Metadata` 的 metadata 传播语义；
- 服务发现、Selector、连接池、重试策略（只作用于握手前）、App 生命周期、Registry；
- `protoc-gen-like` 生成的 `registerXHandler` / `newXClient`，以及 grpc-buf 的 Connect 协议；
- `@go-like/transport` 只依赖 context、metadata、struct，不反向依赖 server 或 client。契约对象的
  `registerHandler`、`newClient` 只依赖参数的结构化接口，编解码与校验仍由 server、client 完成，
  import 契约不会把服务发现、选择器、重试等运行时带进调用方的 bundle。

### 11.3 示例与文档

- 示例：`bank-transfer-gateway`、`commerce-catalog`、`enterprise-platform-runtime`、`healthcare-appointments`、
  `telecom-service-provisioning` 改用 `defineService`；所有使用 `withAddress`、`withService`、原始 `Message`
  调用的示例随之迁移。
- 文档：根 `README.md`；`packages/{client,core,server,transport,struct}/README.md`、
  `packages/transport/{http,memory,grpc-buf}/README.md`、`packages/protoc-gen-like/README.md`；
  `doc/guide/{service-call,zero-to-one,architecture,config-registry-store,migration,streaming,comparison}.md`
  及各语言译本；`doc/reference/providers.md`（含 `setErrorMap`）；`docs/developer-experience-alignment.md`。
- 需要改写的现有表述：`doc/guide/service-call.md` 中“go-like does not infer a protocol or operation from a URL
  scheme”（现在 `discovery:` scheme 与 URL path 都有含义）；`doc/guide/streaming.md` 中“内部 transport 没有
  多帧协议”（现在支持 SSE 服务端流）。

### 11.4 可观测性：流在结束时记录

同类做法：

| 产品                               | 流调用的记录方式                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| otelgrpc（gRPC Go 官方 OTel 集成） | 每个流一个 span，在流结束（stats `End` 事件）时结束；每条收发的消息记为 span event                                                 |
| go-grpc-prometheus                 | `grpc_server_handling_seconds` 统计到 handler 结束；另有 `grpc_server_msg_sent_total`、`grpc_client_msg_received_total` 等消息计数 |
| Connect 系的客户端拦截器           | span 在流被读完、出错或中断时结束                                                                                                  |
| oRPC `@orpc/otel`                  | 跟踪每次 `yield` 与流的最终完成或错误                                                                                              |

规则：

- 四个观测包共用一个约定：包装 `Response.body`，在以下终止点中最先发生的一个结束 span、记录耗时：
  `end` 事件或自然 EOF、`error` 事件、客户端 cancel、底层读取错误。握手耗时（到响应头为止）另作为属性记录。
- 状态：`end` 记为成功；`error` 事件记为其中 `ServiceError` 的 code 与 status；客户端 cancel 记为 `canceled`；
  没有终止事件就断开记为截断的协议错误。
- 增加流消息计数：服务端发送条数、客户端接收条数（对应 go-grpc-prometheus 的 `msg_sent_total` / `msg_received_total`）。
- 不为每条消息单独记录日志；pino / winston 只在流结束时输出一条包含耗时、消息数与最终状态的日志。
- 这个 body 包装作为共用工具放在 `@go-like/transport`（server、client 都依赖它），四个观测包只消费“流结束”回调，不各自实现一遍。

## 12. 示例目录结构

```text
apps/
  payment/
    api/
      payment.ts            # 契约：只 import struct 与 @go-like/transport
    cmd/
      main.ts               # 组合根：构造依赖、Server、App
    internal/
      server/
        payment.ts          # ServiceHandler 实现：DTO ↔ 领域对象转换，调用 application
      application/
        payment.ts          # 用例，声明所需的仓储与下游服务接口
      domain/
        payment.ts          # 领域模型与规则
      infrastructure/
        payment.ts          # 仓储实现、其他服务的业务代理（如 bill.newClient(conn)）
    README.md
    package.json            # exports 只导出 "./api"
  bill/
    api/
      bill.ts
    cmd/
      main.ts
    internal/
      server/
        bill.ts
      application/
        bill.ts
      domain/
        bill.ts
      infrastructure/
        bill.ts
    README.md
    package.json
packages/
  ...                       # 需要的其他共享包
pkg/
  util/
    db.ts
    logger.ts
    transformer.ts
  transport/
    http.ts
    grpc.ts
    websocket.ts
  registry/
    consul.ts
    etcd.ts
    zookeeper.ts
  middleware/
    logging.ts
    tracing.ts
    metrics.ts
package.json                # workspaces
```

约定：

- TypeScript 没有 Go 的 `internal/` 限制。每个 App 在 `package.json` 的 `exports` 里只导出 `./api`，
  其他 App 只能 import 契约，拿不到实现。
- 依赖方向：server → application → domain；infrastructure 实现 application 声明的接口；
  只有 `cmd/main.ts` 装配所有层。
- 两个 App 互相 import 对方的 `api` 时会形成 workspace 包循环，这时把 `api/` 拆成独立的包。
- `pkg/` 只放装配代码（例如从环境变量构造 `newConsulRegistry(...)`），不重新封装 go-like 的包。
- 请求与响应的结构校验由契约的 Struct 在边界完成；Struct 不做业务校验（金额为正、邮箱格式等），
  这类规则放在 application 或 domain 层。
- 每个 App 的 `package.json` 必须在 `dependencies` 中声明所有直接 import 的运行时包（例如 `@go-like/transport-http`、
  `@go-like/context`）。TypeScript 的路径映射能让类型检查通过，但不能代替运行时依赖；预演练中 Node 启动时因此报错。
- 需要被另一个 App import 的契约包加入 workspace 后要更新 `bun.lock`。
- 三个运行时的启动命令（预演练实测）：

  ```bash
  node --import tsx apps/payment/cmd/main.ts
  bun apps/bill/cmd/main.ts
  deno run --sloppy-imports --node-modules-dir=auto --allow-env --allow-net --allow-read apps/bill/cmd/main.ts
  ```

  Deno 默认不接受省略 `.ts` 后缀的相对 import，所以需要 `--sloppy-imports`。

- 各运行时的 HTTP 服务端要分别验证流的取消、对端断开与背压：Node 服务端通过验证，不代表 Deno 原生 HTTP 服务端可用。
  预演练只验证了 Node 服务端，以及 Bun、Deno 作为调用方。
- 本地多服务联调用 Docker 启动注册中心，例如 `docker run -d --name consul -p 8500:8500 consul:1.15.4 agent -dev -client=0.0.0.0`；
  预演练用两个 payment 实例验证了负载均衡与实例下线。

## 13. 设计决策记录与同类产品调研

调研对象（2026-09 时点）：gRPC、Connect 协议规范（connectrpc.com/docs/protocol）、Twirp、tRPC v11、
oRPC v2（beta，文档更新于 2026-09-27）、go-kratos v3、go-micro v6。每项列出同类做法、备选方案与采用的方案；
结论已写入对应章节，本节保留决策依据。

### D1. 流的响应头何时发送（handler 体内的早期错误走哪条路径）

| 产品                    | 响应头时机                                    | handler 开始后、第一条消息前的错误                                                                 |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| gRPC                    | 惰性，第一条消息或结束时发送                  | Trailers-Only 响应（HTTP 200，`grpc-status` 在头里）；客户端在第一次 `Recv` 时拿到                 |
| Connect                 | 流式响应固定 HTTP 200                         | 写在 `EndStreamResponse` 里，客户端迭代时抛出                                                      |
| tRPC v11                | 立即发送 `connected` 事件                     | 中间件、输入校验错误走普通 HTTP 错误；生成器体内的错误发 `serialized-error` 事件                   |
| oRPC v2                 | 立即发送初始注释（`initialComment` 默认开启） | 中间件、输入校验错误走普通 HTTP 错误；生成器体内的错误发 `error` 事件，客户端在 `for await` 中抛出 |
| 本设计（当前 8.2 初稿） | 等 handler 产出第一条消息                     | 按 unary 错误返回，`await client.x()` 时抛出                                                       |

没有同类产品等待第一条消息再发响应头。

选项：

- **A. 等第一条消息（初稿）**：handler 体内的参数检查也能在 `await` 时抛出，写法与 unary 一致；
  代价是首条消息很慢的流（watch 类）会让 `await` 一直阻塞，途经的代理可能因为等不到响应头而超时。
- **B. 立即握手（tRPC、oRPC 模式）**：调用 handler 前的错误（路由、解码、校验、中间件）按 unary 返回；
  调用 handler 后立即发送响应头和一条初始注释，handler 体内的任何错误都走 `error` 事件，在 `for await` 中抛出。
- **C. 固定 200（Connect 模式）**：连解码、校验错误也放进流里；协议最简单，但所有错误都只能在迭代时拿到。

决定：采用 **B**。与两个最接近的 TypeScript 同类一致，`await` 不会被慢流卡住；需要在 `await` 时就失败的检查，
放进中间件或请求 Struct 即可。

### D2. 心跳

| 产品          | 做法                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| gRPC、Connect | 协议层不定义，依赖 HTTP/2 PING（gRPC keepalive）                                          |
| tRPC v11      | 可配置 `sse.ping.enabled`、`sse.ping.intervalMs`；客户端可配 `reconnectAfterInactivityMs` |
| oRPC v2       | `keepAlive` 默认开启，间隔 15000ms，发送注释行                                            |

背景：常见代理的默认空闲超时是 60 秒左右（如 nginx `proxy_read_timeout`），HTTP/1.1 下没有 HTTP/2 PING 可用。

选项：A. 不发心跳（初稿）；B. 默认开启，间隔可配（如 15 秒），发送 `: ` 注释行。

决定：采用 **B**。成本只是几个字节；客户端本来就忽略注释行，协议不需要改。

### D3. 断线重连与续传

| 产品          | 做法                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| gRPC、Connect | 不自动重连，不定义续传；由业务在请求里带游标                                                  |
| tRPC v11      | `tracked(id, data)` 给事件编号；5xx 时客户端按 `lastEventId` 自动重连                         |
| oRPC v2       | `withEventMeta(value, { id, retry })`；客户端重试插件带上 `lastEventId`，handler 参数里能拿到 |

选项：A. 不自动重连（初稿）；B. 支持事件 id 与 `lastEventId`，由调用方显式开启重连。

决定：采用 **A**。tRPC、oRPC 面向浏览器订阅，断线重连是常态；内部 RPC 与 gRPC、Connect 同类，
重连等于重新执行调用，自动做可能重复副作用。需要续传的业务在请求 Struct 里带游标字段即可。

### D4. 客户端流 API 形态

| 产品                       | 写法                                                     |
| -------------------------- | -------------------------------------------------------- |
| Connect-ES                 | `for await (const x of client.m(req))`，不需要先 `await` |
| oRPC v2                    | `const it = await client.m(input)`，再 `for await`       |
| grpc-go                    | `stream, err := c.M(ctx, req)`，再循环 `Recv()`          |
| tRPC v11（vanilla client） | `client.m.subscribe(input, { onData, onError })` 回调    |

选项：A. 先 `await` 再迭代，返回 `ServerStream`（初稿，同 oRPC、grpc-go）；B. 直接返回 `AsyncIterable`（同 Connect-ES）。

决定：采用 **A**。`await` 是握手完成的明确时点，重试、服务发现错误都在这里结束；也方便 `await using` 管理关闭。

### D5. ctx metadata 的线上表示

| 产品       | 做法                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| gRPC       | 每个 metadata key 是一个 HTTP/2 头，二进制值用 `-bin` 后缀                               |
| Connect    | 普通 HTTP 头；unary 的 trailer 用 `trailer-` 前缀的头                                    |
| kratos     | 每个 key 一个头，按前缀区分传播范围：`x-md-global-*` 逐跳透传，`x-md-local-*` 只到本服务 |
| go-micro   | ctx 里的 metadata 全部复制成请求头，没有白名单                                           |
| 本项目现状 | 全部 metadata 编码进一个 `Go-Like-Metadata` 头                                           |

选项：A. 保留 `Go-Like-Metadata` 单头（初稿）；B. 改为每个 key 一个普通请求头，加统一前缀以便筛选。

决定：采用 **A**，本次不动。它不是路由头，现有的选择性传播（`@go-like/metadata` 的显式 copy）已经工作；
B 与 Fetch 原生风格更一致，但会牵动 metadata 包的编码与白名单规则，适合单独立项。

### D6. deadline 跨服务传播（调研中发现的缺口）

| 产品              | 做法                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| gRPC              | `grpc-timeout` 请求头，服务端据此设置 ctx deadline                                      |
| Connect           | `Connect-Timeout-Ms` 请求头                                                             |
| go-micro          | `Timeout` 请求头，服务端转成 ctx deadline                                               |
| tRPC、oRPC、Twirp | 不传播，只有客户端本地取消                                                              |
| 本项目现状        | 不传播：客户端请求头只有路由头与 `Go-Like-Metadata`，服务端 ctx 不知道调用方的 deadline |

选项：A. 不传播（现状）；B. 客户端按剩余时间写 `Go-Like-Timeout-Ms`，服务端把它设为请求 ctx 的 deadline
（取与服务端自身限制中较早者）。

决定：采用 **B**。微服务链路上，下游在上游已经放弃之后继续执行是常见的资源浪费；三家 Go 系框架都做了。
属于新增一个请求头，与“删除路由头”不冲突。

### D7. RPC 路径是否加前缀

| 产品    | 路径                                                 |
| ------- | ---------------------------------------------------- |
| gRPC    | `/pkg.Service/Method`，无前缀                        |
| Connect | `/pkg.Service/Method`，客户端 `baseUrl` 可带路径前缀 |
| Twirp   | `/twirp/pkg.Service/Method`，前缀可配置              |
| tRPC    | `/trpc/router.procedure`，前缀可配置                 |
| oRPC    | 由 handler 的 `prefix` 决定，文档示例为 `/rpc`       |

选项：A. 无前缀 `/<service>/<endpoint>`，与 `httpRoute` 按 7.4 的优先级共存，直连地址只能是根 URL（初稿）；
B. 固定前缀如 `/rpc/<service>/<endpoint>`；C. 前缀可配置，直连地址允许带路径前缀（同 Connect `baseUrl`）。

决定：采用 **A**。与 gRPC、Connect 一致，内部服务通常独占端口；`httpRoute` 精确匹配优先，已经能避免冲突。
需要把内部 RPC 挂到网关某个子路径下时，再按 C 扩展。

### D8. unary 是否允许 GET

| 产品        | 做法                                                      |
| ----------- | --------------------------------------------------------- |
| gRPC、Twirp | 只允许 POST                                               |
| Connect     | 默认 POST；标记为无副作用的方法可以用 GET，便于 HTTP 缓存 |
| tRPC        | query 用 GET，mutation 用 POST                            |
| oRPC        | 默认 POST，可按 procedure 配置 GET                        |

选项：A. 只允许 POST（初稿）；B. 契约里可标记无副作用，允许 GET 与缓存。

决定：采用 **A**。内部调用很少依赖 HTTP 缓存；需要对浏览器或 CDN 暴露时用 `httpRoute`。

### D9. 旧 API 的迁移方式（预演练后决定）

预演练中，保留兼容层的实现出现了“按异常猜测 handler 形状、重复执行”的问题，兼容层本身也扩大了维护面。

决定：**一次性破坏性变更**，不保留 legacy 入口，同一次变更迁移全部调用方（7.1）。

### D10. 流的请求 ctx 生命周期（预演练后决定）

| 做法           | 例子                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ctx 覆盖整条流 | gRPC Go 服务端流的 `stream.Context()`；`net/http` 的 `r.Context()` 存活到 handler 返回，SSE handler 在循环里持续使用它 |

决定：**按 Go 范式，请求 ctx 覆盖整条流**，在流结束时取消（8.3）。

### D11. 流的可观测性（预演练后决定）

决定：**在流结束时记录**，握手耗时作为属性，增加消息计数（11.4）；同类做法见 11.4。

### D12. 单条事件大小上限（预演练后决定）

预演练发现：服务端编码事件时使用默认 4 MiB，客户端使用 Transport 配置的 `maxMessageBytes`，两端不一致时客户端只得到笼统的协议错误。

| 做法                           | 例子                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| 两端各自配置，超限返回明确错误 | gRPC `MaxSendMsgSize` / `MaxRecvMsgSize`，超限返回 `RESOURCE_EXHAUSTED` |

决定：**照 gRPC 两端各自配置**，不通过 Transport 强制统一；超限时返回 `resource_exhausted` 并写明大小与上限（8.3）。

### D13. HTTP 上的流背压承诺（预演练后决定）

预演练发现：Memory 能保证“客户端每读一条，服务端才生成一条”；HTTP 下 Node 写 socket 时会预读，服务端会领先客户端若干条。

| 做法                     | 例子                                               |
| ------------------------ | -------------------------------------------------- |
| 允许流控窗口内的有限预取 | gRPC、Connect 在 HTTP/2 流控窗口内都允许发送方领先 |

决定：**接受 HTTP 有限预取**，并规定生成器内不得执行以送达为前提的副作用，确认送达改用 unary 提交游标（8.3、第 14 节）。

### 与同类产品一致的其他设计

| 设计                                             | 同类做法                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unary 错误用真实状态码 + JSON body（7.3）        | Connect `{code, message, details}`、Twirp `{code, msg, meta}`、kratos `{code, reason, message, metadata}`、tRPC、oRPC 均如此；只有 gRPC 固定 HTTP 200 并把状态放在 trailer |
| 流必须以显式终止帧结束，缺失即视为截断（8.2）    | gRPC 必须有 `grpc-status` trailer；Connect 必须有 `EndStreamResponse`；tRPC 有 `return` 事件；oRPC 默认发送关闭事件                                                        |
| 每条流消息一个 Struct，多种类型用判别联合（8.1） | oRPC `asyncIteratorObject(schema)`、tRPC 生成器 yield 单一类型、Connect 单一 message 类型配合 `oneof`                                                                      |
| 流只在握手前重试（8.1）                          | gRPC 重试规范：收到响应头后调用即“已提交”，不再重试                                                                                                                        |
| `discovery:///<name>` 目标（5.1）                | kratos `discovery:///name`、grpc-go `dns:///host`                                                                                                                          |
| 路由用 `/<service>/<endpoint>` path（7.2）       | gRPC、Connect 的 `/pkg.Service/Method`；go-micro 用 `Micro-Service`/`Micro-Endpoint` 头，本设计不再沿用                                                                    |

## 14. 问题归属：框架、业务与可规避

本节把设计与预演练中出现的问题按责任方分为三类，用来决定实现时由谁处理、用什么手段处理：

- **框架问题**：由框架保证正确，用户不需要知道，也无法绕开。出错就是框架缺陷，必须有回归测试。
- **业务问题**：取决于业务语义，框架无法替用户决定，只在文档中说明规则与推荐做法。
- **可规避问题**：决定权在用户，但常见的误用可以由框架提前拦住或给出明确提示。按拦截时机从早到晚优先选择：
  编译期类型 → 定义期 / 构造期校验 → 运行期明确的错误信息 → 模板与文档。

### 14.1 框架问题

| 问题                       | 框架的保证                                                                                   | 出处      |
| -------------------------- | -------------------------------------------------------------------------------------------- | --------- |
| handler 被执行两次         | 原始 handler 只有一种形状，不在运行时猜测、不做异常回退                                      | 7.1、D9   |
| 注册到一半失败             | `registerHandler` 先检查全部方法再注册，不留下半注册的 Server                                | 4         |
| deadline 定时器泄漏        | 请求结束时释放定时器；每次重试重新计算 `Go-Like-Timeout-Ms`                                  | 7.2       |
| 流的 ctx 过早结束          | 请求 ctx 绑定 `Response.body` 生命周期，存活到流结束；Memory 与 HTTP 行为一致                | 8.3、D10  |
| 客户端中止后服务端继续生成 | 中止传到请求 ctx，并调用迭代器 `return()`，生成器 `finally` 执行                             | 8.3       |
| 流中断被当成正常结束       | 必须收到 `end` 或 `error` 事件，否则报截断错误                                               | 8.2       |
| 慢流被代理断开             | 默认 15 秒心跳                                                                               | 8.3、D2   |
| 握手后仍重试               | 重试只作用于握手前                                                                           | 8.1       |
| 代理的错误页被当成业务错误 | 只有完全符合 7.3 格式的响应才还原为 `ServiceError`                                           | 7.3       |
| 路由判断顺序不稳定         | 固定为 `httpRoute` → 已注册 RPC → `/healthz` → 404/405，未注册路径不因 Content-Type 返回 400 | 7.4       |
| 伪造的对端身份             | mTLS 身份只放在 ctx 的 TransportInfo，不接受请求头                                           | 7.5       |
| typed 调用占用连接         | typed `call` 与 `stream` 由框架读完或关闭 body 后归还连接                                    | 7.5       |
| 可观测性把长流记成短调用   | 流在结束时记录耗时与状态，握手耗时另记                                                       | 11.4、D11 |
| 各运行时行为不一致         | 每个运行时的 HTTP 服务端都要有流取消、对端断开、背压的 e2e；未验证的运行时不宣称支持         | 12        |

### 14.2 业务问题

| 问题                             | 规则与推荐做法                                                                            | 出处     |
| -------------------------------- | ----------------------------------------------------------------------------------------- | -------- |
| 字段是否必填、能否为 `null`      | 按业务语义选择 `optional()`、`null()`、`nullish()`                                        | 9.2      |
| 契约如何演进                     | 由开发者自行管理；不兼容变更建议新建 `v2` 契约与 v1 并存                                  | 3        |
| 业务校验（金额为正、邮箱格式等） | 放在 application / domain 层，Struct 只做结构校验                                         | 12       |
| 生成器内的副作用与送达确认       | 不要在生成器里执行以送达为前提的副作用；需要确认时由客户端处理完后调用 unary 方法提交游标 | 8.3、D13 |
| 断线续传                         | 不自动重连；需要续传的业务在请求 Struct 里带游标，由调用方重新发起调用                    | 8.3、D3  |
| 单条消息太大                     | 业务上分页或分批，而不是一味调大上限                                                      | 8.3、D12 |
| deadline 给多少                  | 长时间的流由调用方给足 deadline                                                           | 8.3      |
| 错误码与状态设计                 | 业务错误用 `ServiceError`，`code` 稳定可分支，`message` 可以安全公开，`metadata` 不放密钥 | 7.3      |
| 是否允许重试                     | 只有幂等操作才用 `withRetry` 显式开启                                                     | 8.1      |
| 端口暴露与鉴权                   | 内部服务端口不直接暴露到公网，鉴权放在中间件                                              | 7.4      |

### 14.3 可规避问题

| 问题                                                      | 预演练中的表现                                | 框架提供的防护                                                                                               | 拦截时机                   |
| --------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| handler 缺方法、参数或返回值类型错                        | —                                             | `ServiceHandler<typeof svc>` 类型检查；注册时再检查一次                                                      | 编译期、注册期             |
| 对流 endpoint 用了 unary 调用或反之                       | —                                             | `ServiceClient` 按 `stream` 生成不同签名                                                                     | 编译期                     |
| 契约名或键不合法、与原型成员同名                          | —                                             | `defineService` 定义期抛 `TypeError`，指出是哪个名字                                                         | 定义期                     |
| 静态 Struct 的重复 wire key                               | —                                             | `struct.object(...)` 定义期抛 `TypeError`（递归 getter 在第一次解析时）                                      | 定义期                     |
| 把“可省略”写成 `null()`                                   | `bank-transfer-gateway` 请求被拒              | 缺失必填字段的错误信息写明字段路径，并附加英文提示 `Use optional() or nullish() if the field may be omitted` | 运行期错误信息、文档对照表 |
| HTTP 直连地址带了路径                                     | 旧测试以 `/rpc` 作为地址                      | transport-http 解析地址时报错，写明必须是根 URL                                                              | 构造期                     |
| `discovery:///` 与 `withDiscovery` 不配套、地址为空或重复 | —                                             | `withEndpoint` / `newClient` 立即报错                                                                        | 构造期                     |
| 契约包 import 了实现代码                                  | —                                             | 示例模板的 `exports` 只导出 `./api`；另一个 App import 实现时类型检查失败                                    | 编译期、模板               |
| 运行时依赖漏写进 `package.json`                           | Node 启动时找不到 `@go-like/transport-http`   | 示例的 e2e 用真实运行时启动，不只做类型检查；文档写明规则                                                    | 模板与 CI                  |
| Deno 无法解析省略后缀的 import                            | 需要 `--sloppy-imports`                       | 文档给出三个运行时的实测启动命令                                                                             | 文档                       |
| 原始 `call` 的 body 不读导致连接被占                      | —                                             | 文档与示例默认使用 typed 调用；原始 `call` 的注释写明调用方须读完或 cancel body                              | 文档                       |
| 单条消息超过上限                                          | 两端上限不一致时只有笼统的协议错误            | `resource_exhausted` 错误写明实际大小、上限与超限的一方                                                      | 运行期错误信息             |
| deadline 太短导致流中途结束                               | 下游看到 `Canceled` 而不是 `DeadlineExceeded` | 调用方收到 `DeadlineExceeded`；文档说明下游看到的取消原因可能不同                                            | 运行期、文档               |
| 在生成器里做以送达为前提的副作用                          | —                                             | 无法在类型上禁止；文档规则与示例给出“客户端提交游标”的写法                                                   | 文档                       |

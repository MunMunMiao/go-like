# LikeGo v1 微服务工具包完整落地设计

日期：2026-07-21

状态：公共 API 部分已被替代

> 本文是历史实施设计，其中 Handle、ResidentClient、Fetch Transport、ServiceDeclaration、自动注册
> 组合器与 `@likego/struct` 不再是当前公共契约。当前上游对齐基线见
> [`../../developer-experience-alignment.md`](../../developer-experience-alignment.md)。

## 1. 决策范围

本文定义 LikeGo v1 从“已验证的生命周期与适配器集合”补齐为可组合微服务工具包的实施边界。用户已经批准
本轮范围，并要求直接在真实 `main` 工作树开发、使用真实外部服务验证，不创建 worktree 或功能分支。

本文显式取代下列旧边界：

- `docs/adr/0004-service-registry-and-selection.md` 中对 etcd、Kubernetes、ZooKeeper、Store、Broker、
  selector 策略和内部路由的延期；
- `docs/superpowers/specs/2026-07-20-likego-service-call-closure-design.md` 中对自动注册、内部 Server
  路由与 streaming 的排除；
- `docs/capability-comparison.md` 中“LikeGo 不提供 Store”的旧结论。

未被本文修改的既有所有权、错误身份、防御性快照、Context、hard drain 和真实验证规则继续有效。

## 2. 不变原则

### 2.1 Go 风格，而不是 Go 语法移植

LikeGo 的 Go 风格固定表现为：

- 所有可能阻塞的方法把 `Context` 作为独立首参；
- 构造函数与 functional options 不执行 I/O；
- resident 能力实现结构式 `Server`，启动后返回唯一 owner handle；
- `done()` 返回稳定 terminal barrier，`stop(ctx)` 只让调用方 Context 限制等待，不转移 owner；
- 依赖与 provider 显式注入，不提供全局默认实例、服务定位器或隐藏单例；
- 接口和实现保持小而正交，应用 composition root 决定组合；
- TypeScript 运行时值统一使用 lower camel case；不模仿 Go 的首字母大写导出规则；
- 能力边界依赖结构类型与工厂函数，不要求继承或自定义 class。

### 2.2 标准 Web API 优先

portable 根入口只依赖标准 ECMAScript 与 Web API，包括：

- `AbortController`、`AbortSignal`；
- `Request`、`Response`、`Headers`、`fetch`；
- `ReadableStream`、`WritableStream`、`TransformStream`；
- `TextEncoder`、`TextDecoder`；
- `URL`、`crypto.subtle`、portable timers。

文件系统、原生 socket、ZooKeeper TCP client、Node HTTP host 等非标准能力必须隔离到 provider 包或
runtime 子路径。项目不限制最终运行时，但每个入口必须诚实声明并验证自己的 runtime matrix。

### 2.3 内外 HTTP 分层

- `@likego/web` 面向外部 HTTP 应用和框架，公共 ABI 是标准 `Request -> Response`；
- `@likego/transport` 定义内部服务通信的公共 SPI；
- `@likego/transport-http` 使用 HTTP/Fetch 实现内部 Transport client 与 server；
- `@likego/server` 只提供内部服务声明、分派和自动注册组合，不成为外部 Web 框架；
- Hono、Elysia、H3 等框架继续由各自的 `@likego/*` 包适配 `@likego/web` 生命周期。

### 2.4 明确排除

v1 不实现：

- gRPC、Protobuf、IDL 代码生成；
- ORM、Active Record、分布式事务；
- service mesh、sidecar、API gateway；
- 全局 codec registry、运行时反射路由、装饰器容器；
- 自动推断幂等性和隐式 retry；
- 将标准 Fetch 冒充为连接级全双工流；
- 对 provider 原生 ack/nack 语义做虚假的统一。

## 3. 当前证据基线

### 3.1 仓库基线

当前真实基线为：

- Bun `1.3.14`；
- Node.js `26.5.0`；
- Deno `2.9.3`；
- Docker Engine `29.6.1`，Docker Compose `5.3.0`；
- 29 个 workspace，其中 25 个发布包、4 个私有 example；
- `bun run typecheck` fresh 退出 0；
- `bun test --isolate --no-orphans` fresh 结果为 2259 pass、1 fail、2260 tests。

唯一已知失败是 `scripts/release-config.test.ts` 仍断言 28 个 workspace，而真实数量已因
`@likego/struct` 变为 29。这是实施前既有计数漂移，不是本设计引入的回归。

### 3.2 已经成立的能力

下列能力已有足够实现，后续只做明确的小幅增强或组合：

- `@likego/context`：Go `context` 等价的取消、deadline、cause、value 与派生语义；
- `@likego/core`：顺序启动、失败回滚、逆序 drain、被动退出、hard deadline、orphan diagnostics；
- `@likego/web`：标准 Fetch handler、Context 适配、Node host、Hono/Elysia/H3 适配；
- unary `@likego/transport` 与 `@likego/transport-http`；
- `@likego/client` 的单次 discover-select-dial-send-recv 调用；
- `@likego/config` 的 immutable snapshot、ordered merge、schema、watch、last-good；
- `@likego/registry` 的完整 SPI、canonical identity、discovery、round robin 与 conformance；
- Consul 与 mDNS Registry，Consul Config；
- Health probe registry 与 Web health handler；
- OpenTelemetry trace/metric provider 生命周期；
- NATS Core、JetStream、BullMQ、Croner 的 native-first 生命周期适配；
- Pino、Winston、Prometheus；
- `@likego/struct` 的 Go 风格 schema 与 object-level Web codec。

### 3.3 已确认的调用面缺口

当前联合 E2E 的请求 endpoint 是 `Orders.Get`，Registry 声明却是 `Call`。两者能够漂移，是因为仓库没有：

- 服务端 endpoint 声明与分派表；
- 从同一声明生成 Registry `Endpoint[]`；
- 将 transport bind、register、deregister、listener drain 自动排序的组合入口；
- 跨 unary Client/Server 的结构化服务错误；
- 内部标准 Fetch streaming 调用面。

### 3.4 Streaming 实验

同一个 `ReadableStream` request body 已在本机验证：

| Runtime | 未提供 `duplex` | 提供 `duplex: "half"` |
|---|---:|---:|
| Bun 1.3.14 | 接受 | 接受 |
| Deno 2.9.3 | 接受 | 接受 |
| Node 26.5.0 | `TypeError` | 接受 |

因此 v1 支持标准 `Request`/`Response` 流，但作出三项诚实限制：

1. Response body 可以跨目标 runtime 增量消费；
2. Request body streaming 取决于 runtime 的标准 Fetch 实现；Node 调用方必须构造带
   `duplex: "half"` 的 Request；
3. 该模型是 Fetch request/response streaming，不宣称 raw connection、HTTP hijack 或连接级全双工。

另一个跨 runtime 实验确认：直接在 request factory 新建的 Request 上设置 LikeGo header 后，Node、Bun、Deno
均能按 `a`、`b` 两个 chunk 增量读取；而 Bun 对 `new Request(original, { headers })` 产生的 tee 在原分支未消费
时不会自然退出。Stream Client 因此接管 factory 返回的 one-shot Request，原地增加 header，不 clone/tee body。

## 4. 目标包图

现有包继续平铺在 `packages` 下；同一能力的 provider 与 Transport 现有结构一致，使用嵌套源码目录、独立发布名。

```text
packages/
  core/                         @likego/core
  context/                      @likego/context
  server/                       @likego/server
  client/                       @likego/client

  transport/                    @likego/transport
  transport/http/               @likego/transport-http

  web/                          @likego/web
  hono/                         @likego/hono
  elysia/                       @likego/elysia
  h3/                           @likego/h3

  config/                       @likego/config
    consul/                     @likego/config-consul
    etcd/                       @likego/config-etcd

  registry/                     @likego/registry
    consul/                     @likego/registry-consul
    mdns/                       @likego/registry-mdns
    etcd/                       @likego/registry-etcd
    kubernetes/                 @likego/registry-kubernetes
    zookeeper/                  @likego/registry-zookeeper

  store/                        @likego/store
    file/                       @likego/store-file
    consul/                     @likego/store-consul
    etcd/                       @likego/store-etcd

  broker/                       @likego/broker
  event/                        @likego/event
  nats/                         @likego/nats
  bullmq/                       @likego/bullmq
  croner/                       @likego/croner

  struct/                       @likego/struct
  health/                       @likego/health
  otel/                         @likego/otel
  prometheus/                   @likego/prometheus
  pino/                         @likego/pino
  winston/                      @likego/winston
  resilience/                  @likego/resilience
  testing/                      @likego/testing
```

新增 11 个发布包后，目标为 36 个发布包、4 个私有 example、40 个 workspace。YAML 是
`@likego/config/yaml` 子路径，不单独形成 workspace。

所有发布包版本保持 `0.0.1`；变更通过 Changesets 记录，不在本轮发布。

## 5. Application 生命周期

### 5.1 应用身份

`@likego/core` 在既有 `name(...)` 基础上增加：

```ts
export interface AppInfo {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly metadata: Readonly<Record<string, string>>
}

export interface AppHookDiagnostic {
  readonly phase: "beforeStart" | "afterStart" | "beforeStop" | "afterStop"
  readonly index: number
  readonly status: "pending" | "running" | "succeeded" | "failed" | "timed-out"
  readonly error: Error | null
}

export function id(value: string): AppOption
export function version(value: string): AppOption
export function metadata(value: Readonly<Record<string, string>>): AppOption
```

`AppDiagnostics` 保留既有 `appName` 兼容字段，并新增 `info: AppInfo` 与
`hooks: readonly AppHookDiagnostic[]`。所有层级都是 fresh immutable snapshot；默认 `id`、`version` 为空
字符串，metadata 为空对象，name 保持现有默认。`id`、`name`、`version` 必须是 well-formed string；
metadata 只接收 own enumerable、well-formed string key/value，并在 option 创建时防御性快照。后声明的同类
identity option 覆盖前者。身份只用于 diagnostics，不读取 hostname、环境变量或 package manifest，也不
作为自动注册的隐式输入。Registry 服务身份只来自 `ServiceDeclaration`，避免形成第二个可漂移来源。

### 5.2 生命周期 hook

增加四个显式 option：

```ts
export type AppHook = (ctx: Context) => void | PromiseLike<void>

export function beforeStart(hook: AppHook): AppOption
export function afterStart(hook: AppHook): AppOption
export function beforeStop(hook: AppHook): AppOption
export function afterStop(hook: AppHook): AppOption
```

语义固定为：

- 每类 hook 按声明顺序执行；
- startup hook 在第一个失败或 startup Context 取消后停止该阶段剩余 hook；已经开始的 hook rejection 被观察，
  尚未开始的 hook 保持 `pending`；
- `beforeStart` 与 `afterStart` 使用 `App.start(ctx)` 的 startup Context；
- `beforeStart` 失败或 startup Context 取消时不启动任何 child；
- `afterStart` 失败或 startup Context 取消时触发现有 child 逆序回滚；
- 任一 startup failure 都进入同一个 owner drain，因此已经成功的 startup hook 可以由 beforeStop/afterStop
  清理；startup failure 保持 primary，随后 cleanup failure 按观察顺序追加；
- 第一次 owner drain 开始时，从 `background()` 创建 shared drain Context，绝对 deadline 为
  `drain 开始时间 + App hardDrainTimeout`；
- `beforeStop`、child drain、`afterStop` 共享该绝对 deadline；某个 `stop(ctx)` 的调用方 Context 只限制
  自己等待 shared drain；
- `beforeStop` 或 `afterStop` 失败不会跳过其他 hook 或 child cleanup；
- deadline 到达后仍以已经取消的 drain Context 调用尚未开始的 cleanup/hook 一次，但不再等待越过 deadline；
- stop 阶段失败按实际观察顺序聚合；
- `AppDiagnostics.hooks` 以 phase 固定顺序及各 phase 声明索引记录
  `pending/running/succeeded/failed/timed-out` 与边界规范化 Error；
- hook 不接管进程信号，不注册全局 listener。

## 6. 内部 Server、Client 与自动注册

### 6.1 `@likego/server`

新增最小内部服务包：

```ts
export interface UnaryEndpoint {
  readonly name: string
  readonly request: Value | null
  readonly response: Value | null
  readonly metadata: Readonly<Record<string, string>>
  readonly handle: (ctx: Context, request: Message) => Message | PromiseLike<Message>
}

export interface FetchEndpoint {
  readonly name: string
  readonly request: Value | null
  readonly response: Value | null
  readonly metadata: Readonly<Record<string, string>>
  readonly handle: (ctx: Context, request: Request) => Response | PromiseLike<Response>
}

export interface NodeDeclaration {
  readonly id: string
  readonly metadata: Readonly<Record<string, string>>
}

export interface ServiceDeclaration<E> {
  readonly name: string
  readonly version: string
  readonly metadata: Readonly<Record<string, string>>
  readonly node: NodeDeclaration
  readonly endpoints: readonly E[]
}

export interface AddressServer extends Server {
  address(): string | null
}

export type AddressServerFactory = (handler: AcceptHandler) => AddressServer

export type FetchServerFactory = (handler: TransportFetchHandler) => AddressServer

export type AdvertiseAddressResolver<E> = (
  ctx: Context,
  boundAddress: string,
  declaration: ServiceDeclaration<E>
) => string | readonly string[] | PromiseLike<string | readonly string[]>

export interface RegisteredServiceOptions<E> {
  readonly advertise: AdvertiseAddressResolver<E>
  readonly registration: readonly RegisterOption[]
}

export type RegisteredServiceOption<E> = (
  options: RegisteredServiceOptions<E>
) => RegisteredServiceOptions<E>

export function advertiseAddress<E>(
  value: string | readonly string[] | AdvertiseAddressResolver<E>
): RegisteredServiceOption<E>

export function registrationOptions<E>(
  ...options: readonly RegisterOption[]
): RegisteredServiceOption<E>

export function registeredUnaryService(
  registrar: Registrar,
  createServer: AddressServerFactory,
  declaration: ServiceDeclaration<UnaryEndpoint>,
  ...options: readonly RegisteredServiceOption<UnaryEndpoint>[]
): ReturnType<typeof lifecycleServer>

export function registeredFetchService(
  registrar: Registrar,
  createServer: FetchServerFactory,
  declaration: ServiceDeclaration<FetchEndpoint>,
  ...options: readonly RegisteredServiceOption<FetchEndpoint>[]
): ReturnType<typeof lifecycleServer>
```

包提供：

- `unaryHandler(declaration)`：生成 provider-neutral `AcceptHandler`；
- `fetchHandler(declaration)`：生成内部 Transport `TransportFetchHandler`；
- `registeredUnaryService(...)`；
- `registeredFetchService(...)`。

这里的 `lifecycleServer` 指从 `@likego/core` 导入并重命名的 `server`。两个 registered 入口都返回
`ReturnType<typeof lifecycleServer>`；Core 的 `AppOption` 继续保持内部 opaque type，不为本包破坏既有
public contract。内部只组合现有 `server(...)` 与
`registration(...)`。固定顺序为：

```text
bind/admit transport server
→ read actual address
→ resolve one or more advertised addresses from actual address
→ build Node with declaration id/metadata and resolved addresses
→ register the exact Service declaration
→ run
→ deregister
→ drain transport server
```

默认 advertise resolver 返回 `[boundAddress]`。`advertiseAddress(...)` 可传入固定公网地址、容器可达地址或
resolver；resolver 在 bind/admit 后、注册 I/O 前执行，接收启动 Context、bound address 与完整声明。
返回值遵循 Registry `Node.addresses` 的 transport-opaque 契约：只要求非空、无重复、well-formed string，
并在注册前冻结；通用 helper 不要求 URL，也不添加 `http://`。resolver 失败或返回空/重复/非法 string
时，必须在 Registry I/O 前回滚已绑定 server。默认值适合当前 HTTP listener 的
`127.0.0.1:port`/`[::1]:port` authority；若绑定 `0.0.0.0`、`::`、容器内部地址、NAT 或 Ingress，用户必须
显式传入可被对应 `ServiceInstanceResolver` 理解的 advertise override。LikeGo 不猜 transport scheme、
NAT、Ingress、容器网卡或端口映射。

注册失败必须回滚已绑定 server。撤注册失败不能跳过 server drain。多个失败保持观察顺序。

用户可以传入任意 `AddressServer` factory；LikeGo 不要求使用 `@likego/transport-http`，也不要求继承。

### 6.2 单一事实源

每个 endpoint 声明同时生成：

- header 名大小写不敏感、service/endpoint 值大小写敏感的精确 dispatch 表；
- Registry `Endpoint`；
- typed codec helper 所需的 request/response shape；
- OTel span name 与低基数属性；
- 文档可展示的 endpoint metadata。

重复 endpoint、空 identity、非法 UTF-16、不完整 handler，以及 metadata 中以 `likego.` 开头但不属于
`likego.endpoint.kind` 或 `likego.codec.media-type` 的 key，在任何 I/O 前拒绝。Registry 发布的 endpoint
metadata 固定增加 `likego.endpoint.kind = unary|fetch`；业务 metadata 不得覆盖该 key。

### 6.3 Middleware

Server 只定义一种普通函数 middleware：

```ts
export type UnaryHandler = UnaryEndpoint["handle"]
export type UnaryMiddleware = (next: UnaryHandler) => UnaryHandler

export function composeUnary(
  handler: UnaryHandler,
  ...middleware: readonly UnaryMiddleware[]
): UnaryHandler
```

`composeUnary(handler, a, b)` 固定形成 `a(b(handler))`，返回的 handler 可直接写入
`UnaryEndpoint.handle`，因此声明、dispatch 与 Registry endpoint 仍只有一个事实源。组合阶段验证每一项，
任何非函数值都在 server bind 前拒绝。Context 始终是独立首参。v1 不增加装饰器、容器、反射、priority
或 route group DSL。

### 6.4 结构化服务错误

`@likego/transport` 增加 provider-neutral `ServiceError` 与 wire helper：

```ts
export interface ServiceError extends Error {
  readonly name: "ServiceError"
  readonly code: string
  readonly status: number
  readonly metadata: Readonly<Record<string, string>>
}

export interface ServiceErrorEnvelope {
  readonly serviceStatus: number
  readonly carrierStatus: number
  readonly header: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

export type ServiceErrorWireKind = "unary" | "fetch"

export function serviceError(
  code: string,
  message: string,
  status?: number,
  metadata?: Readonly<Record<string, string>>
): ServiceError

export function isServiceError(value: unknown): value is ServiceError

export function internalServiceError(): ServiceError

export function encodeServiceError(
  kind: ServiceErrorWireKind,
  error: ServiceError
): ServiceErrorEnvelope

export function decodeServiceError(
  kind: ServiceErrorWireKind,
  carrierStatus: number,
  header: Readonly<Record<string, string>>,
  body: Uint8Array
): ServiceError | null
```

固定规则：

- `serviceError()` 创建带 package-private brand、`name: "ServiceError"` 且完全冻结的对象；
  `isServiceError()` 是 Server 唯一识别入口，不允许仅凭外部对象的 `name` 或同形字段判定；
- code 匹配 `[a-z0-9][a-z0-9._-]{0,127}`，status 默认为 500 且只能为 400 至 599；
- 新增 `Likego-Service-Error: v1`、`Likego-Service-Error-Code` 与
  `Likego-Service-Error-Status`；既有 `Likego-Error` 保持 Transport protocol diagnostic，不复用；
- JSON body 固定为
  `{"code":string,"message":string,"status":number,"metadata":object}`，属性顺序固定，UTF-8 编码，
  `Content-Type: application/json; charset=utf-8`；
- message 最多 4096 UTF-8 bytes；metadata 最多 32 项，key 最多 128 bytes，value 最多 1024 bytes；
  canonical body 总长最多 8192 bytes；
- unary wire 使用 HTTP 200 内的 ServiceError marker/header/body，不把 HTTP status 泄漏到 provider-neutral
  Transport；
- Fetch endpoint 使用真实 Response status 与同一 marker/header/body；
- 未知异常对客户端只暴露固定 internal error，不泄露 stack、路径或原始异常文本；
- `internalServiceError()` 每次产生同一固定 tuple：
  `code = "internal"`、`message = "internal service error"`、`status = 500`、空 metadata；
- `ServiceErrorEnvelope.serviceStatus` 是业务 status；`carrierStatus` 在 unary 固定为 200，在 Fetch
  固定等于 `serviceStatus`；
- `encodeServiceError(kind, error)` 是 carrier/header/body 的唯一 canonical encoder；
  `decodeServiceError(kind, carrierStatus, ...)` 在 marker 缺失时返回 `null`，在 marker 存在时先按 kind
  验证 carrier status，再执行下面的完整严格校验；同一 `200 + marker + service status 500` 在 unary
  合法、在 Fetch 必须是 `TransportProtocolError`；
- `@likego/client` 识别 wire error 并抛出不可变 `ServiceError`；
- 只要出现 ServiceError marker，就先验证 marker、code/status、content-type 与完整 body；任一 malformed、
  mismatch 或超限都作为 `TransportProtocolError`；
- marker 合法时返回 `ServiceError`；无 marker 的 HTTP non-2xx 保持现有 `HTTPStatusError`；无 marker 的
  unary Message 是普通成功响应。

### 6.5 Client middleware 与 typed helper

`@likego/client` 保留现有 unary API，并增加 functional options：

```ts
export type Call = (ctx: Context, request: CallRequest) => Promise<Message>
export type ClientMiddleware = (next: Call) => Call
export interface ClientOptions {
  readonly middleware: readonly ClientMiddleware[]
}
export type ClientOption = (options: ClientOptions) => ClientOptions

export function middleware(value: ClientMiddleware): ClientOption

export function newClient(
  discovery: Discovery,
  selector: Selector,
  transport: Transport,
  ...options: readonly ClientOption[]
): Client
```

基础 Client 的一次调用只选择、dial、send、recv 一次，不隐式 retry。middleware 第一个声明是最外层：
`[a, b]` 形成 `a(b(baseCall))`；显式 middleware 可以 short-circuit 或多次调用 next，并对产生的重复 I/O 与
幂等性负责。推荐 retry 继续由 `@likego/resilience` 在调用外显式组合。

每次已经发生选择的 base call 都必须恰好反馈一次。反馈分类固定为：

- 成功响应、合法 `ServiceError`、以及 caller Context 的 cancellation/deadline：`error: null`；
- dial/send/recv 失败、`TransportProtocolError`、无 marker 的 `HTTPStatusError`：`error` 为该失败；
- middleware 在 base call 外自行抛出的错误不伪造 selection feedback；若 middleware 调用了 base call，
  由每次 base call 分别反馈。

因此 P2C cooldown 只惩罚 transport/protocol failure；业务拒绝、固定 internal ServiceError 与调用方取消
都证明不了节点不健康，不增加连续失败计数。cleanup/feedback callback 自身失败保持现有聚合错误规则，但
不反向成为该次 selector 的健康样本。

typed helper 接受 `@likego/struct` 的 `Codec<T>`，只负责 body encode/decode，不注册全局 codec。

## 7. 标准 Fetch streaming

### 7.1 Transport SPI

`@likego/transport` 增加独立接口，不修改 unary `Message.body: Uint8Array`：

```ts
export type TransportFetchHandler = (
  ctx: Context,
  request: Request
) => Response | PromiseLike<Response>

export interface FetchTransport {
  fetch(ctx: Context, request: Request): Promise<Response>
  string(): string
}
```

`@likego/transport-http` 实现：

- `newHTTPFetchTransport(...)`；
- `newHTTPFetchServer(httpHost, handler, ...options)`；
- `@likego/transport-http/node#newNodeHTTPFetchServer(...)`。

先从现有 HTTP Server 抽取私有 `HTTPHost` lifecycle owner，unary Socket adapter 与 Fetch adapter 共同调用；
不得复制第二套 bind、admission、graceful close、hard force 或 address state machine。

`TransportFetchHandler` 是 Context-first 的内部 Transport ABI，不是 `@likego/web` 的单参数标准 handler。
它仍然接收和返回标准 Request/Response。handler Context 只覆盖“收到 Request 到返回 Response headers”；
Response body 生命周期由 stream 与 `Request.signal` 管理。

### 7.2 Streaming Client

`@likego/client` 增加独立构造函数：

```ts
export interface StreamCallRequest {
  readonly service: string
  readonly endpoint: string
  readonly request: (target: string, signal: AbortSignal) => Request
}

export interface StreamClient {
  stream(ctx: Context, request: StreamCallRequest): Promise<Response>
}

export function newStreamClient(
  discovery: Discovery,
  selector: Selector,
  transport: FetchTransport
): StreamClient
```

固定语义：

- request factory 只在 discovery 和 selection 成功后调用一次；
- Client 把 `ctx.done()` 或一个不会自动取消的标准 signal 传给 factory；factory 必须把它作为 Request signal；
- factory 返回的 Request URL 必须等于传入 target，两个保留路由 header 不得由调用方预置；
- factory 必须返回 unused、unlocked Request，并立即把该 one-shot Request 的所有权转给 Client，调用方不得复用；
- Client 在可变 Request headers 上原地注入路由 header，不 clone/tee body，然后执行一次 Fetch；
- headers 不可修改时在 Fetch 前 fail closed；
- Client 不自动 retry；
- selection 成功后的每一个出口都恰好完成一次 feedback：request factory throw、Request/URL/header
  validation failure 与 caller Context cancellation 反馈 `error: null`；Fetch/FetchTransport 在 caller
  Context 尚未取消时 reject、返回非 Response 或抛出 `TransportProtocolError` 时反馈该 error；
  任意标准 Response（包括 non-2xx 与合法 ServiceError Response）headers 到达后反馈 `error: null`；
- Response headers 到达或上述 pre-response 出口完成 feedback 后，Client/P2C in-flight ownership 结束；
- Client 原样返回标准 Response，不获取 reader、不 tee、不包装 Response，也不观察 body terminal；
- 返回后的 body 读取、cancel、backpressure 与 terminal 完全由调用方标准 Web API 拥有；Context 后续取消是否
  终止 body 由注入 Request signal 与原生 Fetch 实现负责；
- 不缓存、重放或预读 request/response body；
- Node request body streaming 由调用方按 Node Fetch 要求构造 `duplex: "half"` Request。

Stream Client 不把标准 Fetch 的 non-2xx Response 改写成 exception，也不读取 ServiceError body；调用方若要
把 Response 解释为业务错误，可显式读取 bounded bytes 后调用
`decodeServiceError("fetch", response.status, headers, bytes)`。节点健康反馈已经在 headers 到达时结束，
不会因调用方随后得到的业务错误或 body 消费结果反向变化。

## 8. Struct Codec 与 Encoding

`@likego/struct` 在现有 object-level `encodeJson/decodeJson` 上增加唯一的 bytes codec：

```ts
export interface Codec<T> {
  readonly mediaType: string
  encode(value: T): Uint8Array
  decode(bytes: Uint8Array): T
}

export function jsonCodec<S extends AnyStructLike>(
  schema: S
): Codec<S["_struct"]["output"]>
```

固定管线：

```text
encodeJson
→ JSON.stringify
→ TextEncoder

TextDecoder("utf-8", { fatal: true })
→ JSON.parse
→ decodeJson
```

非法 UTF-8、非法 JSON、schema mismatch、循环/不可 JSON 编码值均失败。输入与输出 bytes 防御性复制。
codec 不处理 envelope、版本协商、content negotiation 或全局注册；业务版本由业务 struct 字段显式声明。

该 codec 至少由 typed Client/Server 与 typed Event 使用，避免形成“存在但全仓无消费者”的孤立能力。

## 9. Store

### 9.1 公共 SPI

`@likego/store` 定义：

```ts
export interface StoreRecord {
  readonly key: string
  readonly value: Uint8Array
  readonly metadata: Readonly<Record<string, string>>
  readonly revision: string
  readonly expiresAt: number | null
}

export interface StoreRecordInput {
  readonly key: string
  readonly value: Uint8Array
  readonly metadata?: Readonly<Record<string, string>>
}

export interface StorePage {
  readonly records: readonly StoreRecord[]
  readonly cursor: string | null
}

export interface Store extends Server {
  read(ctx: Context, key: string): Promise<StoreRecord | null>
  write(
    ctx: Context,
    record: StoreRecordInput,
    ...options: readonly WriteOption[]
  ): Promise<StoreRecord>
  delete(
    ctx: Context,
    key: string,
    ...options: readonly DeleteOption[]
  ): Promise<boolean>
  list(ctx: Context, ...options: readonly ListOption[]): Promise<StorePage>
  string(): string
}
```

公共 option 包括：

- `expiresIn(ms)`；
- `ifRevision(revision)`；
- `prefix(value)`；
- `limit(count)`；
- `cursor(value)`。

语义固定为：

- key 为非空、well-formed UTF-16 字符串；
- list 按 Unicode code point 稳定排序；
- revision 是 provider-opaque CAS token；
- TTL 到期记录对 read/list 不可见；
- value、metadata、record 与 page 全部防御性复制并冻结；
- provider README 记录固定 TTL、CAS、shared-writer、最大 key/value 与分页边界，公共对象不提供能力协商；
- construction 不执行 I/O；`start(ctx)` 完成 provider admission，start 前与 stop 后的操作抛稳定
  `StoreStateError`；
- `stop(ctx)` 拒绝新操作、等待已接纳操作并释放本地 client/timer/lock；`start()` 返回的 Promise 表示终态；
- 非 TTL record 是业务持久化状态，Store stop 不删除；TTL record 的远端 lease/session 按到期语义继续存在，
  delete 会提前释放；
- 没有全局默认 Store、隐式 namespace、watch、ORM、cache 或 transaction DSL。

公共 `@likego/store/testing` 提供 provider-neutral conformance。

TTL lease/session 属于对应 record 的业务语义，不是可由 stop 提前删除的进程级连接。测试 teardown 必须显式
删除尚未到期的记录并回读 lease/session 清零。任一 resident background task 被动失败时，Store handle
`done()` 必须拒绝并让 Core 触发其余服务 drain。

### 9.2 File provider

`@likego/store-file` 根入口接受结构式 filesystem host；`./node` 提供 Node host。

v1 使用单目录、单 owner 的版本化快照与原子 temp-write/rename：

- write/delete 在进程内串行化；
- `start(ctx)` 读取并只接受完整 checksum 与 schema version；
- 崩溃留下的 temp 文件不会替代最后成功快照；
- key 不参与路径拼接，避免 traversal；
- revision 单调递增；
- TTL 在读取时惰性清理，并在后续 mutation 持久化；
- capability 明确声明不支持跨进程 shared writers。

这是小型本地持久化 provider，不伪装成数据库。

### 9.3 Consul provider

`@likego/store-consul` 使用注入的标准 Fetch 调用 Consul KV/Session HTTP API：

- KV ModifyIndex 作为 revision；
- `cas` query 实现 compare-and-set；
- recurse 查询实现 prefix/list；
- session behavior `delete` 实现声明过期的 TTL；
- uncertain response 通过 exact KV/session readback 判定；
- ACL token 不进入错误、日志或 redirect；
- delete 与测试 teardown 只清理对应 record 创建的 session。

### 9.4 etcd provider

`@likego/store-etcd` 使用 etcd v3 JSON gRPC gateway：

- key/value 使用 base64；
- header revision 与 mod_revision 作为 cursor/CAS token；
- transaction compare 实现 write/delete CAS；
- lease 实现 TTL；
- prefix range 使用 range_end；
- compaction、lease loss、gateway error 形成稳定 provider error；
- 不引入 gRPC 或 Protobuf runtime。

## 10. Config

### 10.1 YAML

`@likego/config/yaml` 导出：

```ts
export function decodeYaml(input: string): ConfigObject
```

它直接作为现有 `fileSource` decoder 使用，不重写 file watch 生命周期。

固定解析规则：

- 使用 `yaml@2.9.0`；
- 只接受单文档 object root；
- duplicate key、custom tag、循环 alias、非有限数值、BigInt 与危险 prototype key 失败；
- timestamp 保持字符串，不隐式生成 runtime-specific `Date`；
- decoder 失败不污染 Config last-good snapshot。

### 10.2 etcd ConfigSource

`@likego/config-etcd` 实现现有 `ConfigSource`：

- exact key 的 linearizable initial range；
- 从 initial revision + 1 开始 watch；
- update/delete 触发完整 source recompute；
- compaction 后执行 fresh range，再从新 revision 恢复 watch；
- outage/restart 期间保留 last-good；
- borrowed Fetch 仍由应用拥有；
- auth token、TLS origin 和错误保持 secret-safe。

## 11. Registry provider

公共 Registry、canonical hash、Discovery 与 conformance 不复制。

### 11.1 etcd

`@likego/registry-etcd` 使用 JSON gateway：

- logical identity hash 形成 key；
- 每个 registration token 使用独立 lease；
- transaction + exact readback 处理 duplicate ownership 与 uncertain response；
- keepalive loss、lease expiry、generation restore、跨客户端 conflict fail closed；
- prefix watch 遇 compaction执行 watch-first/range/reconcile；
- publisher 被 `SIGKILL` 后记录必须随 lease 到期消失。

### 11.2 Kubernetes

`@likego/registry-kubernetes` 使用标准 Fetch 调用
`discovery.k8s.io/v1 EndpointSlice`：

- 每个 LikeGo Node 对应一个受管 EndpointSlice；
- `kubernetes.io/service-name` 和 LikeGo managed labels 用 canonical hash；
- 完整 Service/Node、token 集与 hashes 放 annotations；
- 不创建 core Service、不引入 CRD；
- 同逻辑 Node 的 token 集使用 `resourceVersion` CAS；
- stop 只删除自己的 token，最后一个 token 才删除 Slice；
- get/list/watch 聚合同 namespace 的全部匹配 Slice；
- watch `410 Gone` 立即 relist、计算逻辑 diff、从新 resourceVersion 续订；
- foreign Slice 永远不修改、不删除；
- 不可无损表示为 EndpointSlice address/port 的 Node address 在 I/O 前拒绝。

最小 RBAC 仅限目标 namespace 的 EndpointSlice：

```text
get, list, watch, create, update, patch, delete
```

### 11.3 ZooKeeper

`@likego/registry-zookeeper` 使用纯 JavaScript `node-zookeeper-client@1.1.3`，明确支持 Node/Bun 后端入口：

- canonical identity 映射到编码安全 znode path；
- registration 使用 ephemeral child znode；
- duplicate publisher 使用独立 token child；
- one-shot watch 每次触发后 re-arm，并周期 reconcile；
- session expiration 后重建 owner 状态；
- auth/ACL、路径编码、identity/service conflict fail closed；
- publisher `SIGKILL` 或 session expiry 后 ephemeral node 必须消失。

不宣称 Deno 支持该 TCP provider。

## 12. Selector

`@likego/registry` 保留现有 `newRoundRobinSelector()`，增加：

```ts
export function newRandomSelector(random?: () => number): Selector

export function newWeightedRoundRobinSelector(
  weight: (endpoint: ServiceEndpoint) => number
): Selector

export interface P2CSelectorOptions {
  readonly random?: () => number
  readonly now?: () => number
  readonly failureThreshold?: number
  readonly cooldownMs?: number
}

export function newP2CSelector(options?: P2CSelectorOptions): Selector
```

固定规则：

- random source 在构造时捕获并验证为函数，每次结果必须满足 `0 <= value < 1`；测试可注入确定性序列；
- Random 每次 select 只取一个随机值并用 `floor(value * candidateCount)` 选择稳定排序后的 endpoint；
- weighted RR 只接受有限正安全整数权重，不从 metadata 猜约定；一次 select 先验证全部候选权重，再推进状态；
- weighted RR 按稳定 endpoint 顺序连续发放权重槽，例如 5:1 的一个周期是 `A,A,A,A,A,B`；membership
  变化时若上次 endpoint 仍存在，则保留它的当前槽位，否则从新 snapshot 首项开始；
- P2C 默认 `Math.random`、`performance.now`、连续失败阈值 3、cooldown 10_000ms；阈值必须是
  1 至 1_000 的整数，cooldown 必须是 1 至 2_147_483_647 的整数毫秒；
- P2C 在非 cooldown 候选中使用两个随机值抽取两个不同候选：第一个索引为
  `floor(r1 * n)`，第二个先取 `floor(r2 * (n - 1))`，若大于等于第一个索引则加一；
- 只有一个 eligible candidate 时不调用 random；两个样本选择 in-flight 较低者，平局选择第一个样本；
- P2C 的 `SelectionDone` 是冻结且幂等的；第一次调用先精确一次递减 in-flight，再按 outcome 更新状态，
  后续调用不读 Context、不调用 clock、不改变状态；
- `SelectionOutcome.error === null` 重置连续失败与 cooldown；非 null 达到阈值后以
  `now() + cooldownMs` 设置/刷新有界 cooldown；
- 全部候选 cooldown 时选择最早恢复者，不伪造“无 endpoint”；
- `random()` 与 `now()` 每次返回值都必须是有限数，`now()` 还必须非负；callback/结果非法时 fail closed，
  且 select 不推进任何 state；
- state 按 service domain 有界到 1024，使用确定性 oldest eviction；
- selector 不启动 timer；cooldown 在下一次 select 时按注入 monotonic clock 计算。

v1 不实现 EWMA latency、zone/locality、adaptive concurrency 或 outlier detection 集群协调。

## 13. Broker 与 Event

### 13.1 `@likego/broker`

公共 Broker 只统一 bytes、topic、订阅所有权，不统一原生 settlement：

```ts
export interface BrokerMessage {
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

export interface BrokerEvent<Native> {
  readonly topic: string
  readonly message: BrokerMessage
  readonly native: Native
}

export interface BrokerSubscription extends ServerHandle {
  readonly topic: string
}

export interface Broker<
  PublishOptions,
  PublishResult,
  SubscribeOptions,
  NativeEvent
> {
  publish(
    ctx: Context,
    topic: string,
    message: BrokerMessage,
    options?: PublishOptions
  ): Promise<PublishResult>
  subscribe(
    ctx: Context,
    topic: string,
    handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>,
    options?: SubscribeOptions
  ): Promise<BrokerSubscription>
  string(): string
}

export function subscription<
  PublishOptions,
  PublishResult,
  SubscribeOptions,
  NativeEvent
>(
  broker: Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent>,
  topic: string,
  handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>,
  options?: SubscribeOptions
): Server<BrokerSubscription>
```

Core NATS 的 `NativeEvent` 是官方 `Msg`，没有伪造 ack；JetStream 的 `NativeEvent` 是官方 `JsMsg`，应用继续
调用 `ack()`、`ackAck()`、`nak()`、`term()`、`working()`。publish result 分别保留 `void` 与原生
`PubAck`。`subscription(...)` 只把 subscribe/stop/done 接入 Core 生命周期，不拥有 Broker connection。

`@likego/nats/broker` 与 `@likego/nats/jetstream/broker` 实现该 SPI；现有 lifecycle adapter 保持兼容。

### 13.2 `@likego/event`

Event 是 typed codec 层，不另造 broker connection：

```ts
export interface EventPublisher<T, Options, Result> {
  publish(ctx: Context, topic: string, value: T, options?: Options): Promise<Result>
}

export interface EventMessage<T, Native> {
  readonly topic: string
  readonly native: Native
  decode(): T
}

export interface EventSubscriber<T, Options, Native> {
  subscribe(
    ctx: Context,
    topic: string,
    handler: (ctx: Context, event: EventMessage<T, Native>) => void | PromiseLike<void>,
    options?: Options
  ): Promise<BrokerSubscription>
}

export interface EventBroker<T, PublishOptions, PublishResult, SubscribeOptions, Native>
  extends EventPublisher<T, PublishOptions, PublishResult>,
    EventSubscriber<T, SubscribeOptions, Native> {}

export function eventBroker<
  T,
  PublishOptions,
  PublishResult,
  SubscribeOptions,
  Native
>(
  broker: Broker<PublishOptions, PublishResult, SubscribeOptions, Native>,
  codec: Codec<T>
): EventBroker<T, PublishOptions, PublishResult, SubscribeOptions, Native>

export function eventSubscription<T, Options, Native>(
  subscriber: EventSubscriber<T, Options, Native>,
  topic: string,
  handler: (ctx: Context, event: EventMessage<T, Native>) => void | PromiseLike<void>,
  options?: Options
): Server<BrokerSubscription>
```

包使用显式 `Codec<T>` 包装 Broker publish/subscribe。`decode()` 延迟执行，因此 schema 失败后，应用仍拥有
原生 JetStream `JsMsg` 并明确决定 nak、term 或不 ack。`EventSubscriber` 返回同一个底层
`BrokerSubscription`；codec 不决定重投、DLQ、durable consumer 或 MaxDeliver。
`eventSubscription(...)` 仅把 typed subscribe/stop/done 接入 Core 生命周期，不拥有 EventBroker 或底层
Broker connection；它与 `@likego/broker` 的 `subscription(...)` 具有相同 admission、rollback、drain
与 stable `done()` 契约。

BullMQ Job 不塞进 Broker/Event SPI；它继续是 durable job lifecycle。

## 14. Health

现有 probe registry 与 Web handler保持公共 API。唯一行为修正为：

- 空 `live` snapshot 返回 `ok: true`；
- 空 `ready` snapshot 返回 `ok: false`；
- 至少一个 ready probe 成功且所有 ready probe 成功时才 ready。

应用继续显式注册 NATS、Redis、Registry、Store 等 dependency probe。LikeGo 不为无法可靠观测健康状态的
第三方 SDK 伪造 probe。

## 15. OpenTelemetry

现有 provider 生命周期继续由应用配置和拥有。`@likego/otel` 增加显式 wrapper，而不是自动插桩：

- `traceClient(client, tracer, propagator?)`；
- `traceUnaryMiddleware(tracer, propagator?)`；
- `traceBroker(broker, tracer, propagator?)`。

固定规则：

- 使用官方 `@opentelemetry/api`；
- W3C trace context 注入 Message/Request/Broker headers；
- server/consumer 提取后在官方 active context 内执行 handler；
- span name 使用稳定 service/endpoint/topic，不含 URL、node ID、error text；
- attributes 只包含低基数字段；
- caller cancellation、ServiceError 与 transport error 使用不同 status/attributes；
- wrapper 不创建 exporter、processor、全局 provider 或 Context Manager；
- trace/metric provider 的 shutdown 仍由现有 `newOtelNodeServer` 管理。

LoggerProvider 不在本轮加入；结构化日志继续由 Pino/Winston，避免把 OTel Logs 与已有日志门面重复。

真实 Collector E2E 必须证明 Client → HTTP → Server 为同一 trace 的 parent/child，并覆盖 NATS
publish/consume、exporter outage/recovery 与 shutdown flush。

## 16. VitePress 文档站

### 16.1 技术选择

- 目录固定为 `./doc`；
- 使用稳定版 `vitepress@1.6.4`；
- 使用 VitePress 默认 SPA client navigation，不设置 `mpa: true`；
- 不直接增加 Vue、vue-i18n、第三方 router、sidebar 或 search plugin；
- 使用内建 locales、theme locales、local search 与 dead-link gate；
- cache 写入 `.artifacts/vitepress-cache`。

### 16.2 Locale

英文为默认根路由。六种联合国官方语言加台湾、香港本地化：

| 路径 | `lang` | `dir` |
|---|---|---|
| `/` | `en-Latn` | `ltr` |
| `/ar-Arab/` | `ar-Arab` | `rtl` |
| `/zh-Hans/` | `zh-Hans` | `ltr` |
| `/fr-Latn/` | `fr-Latn` | `ltr` |
| `/ru-Cyrl/` | `ru-Cyrl` | `ltr` |
| `/es-Latn/` | `es-Latn` | `ltr` |
| `/zh-Hant-TW/` | `zh-Hant-TW` | `ltr` |
| `/zh-Hant-HK/` | `zh-Hant-HK` | `ltr` |

这些是含 ISO 15924 script subtag 的 BCP 47 language tag；不把单独 script code 当作 locale。

### 16.3 内容结构

每个 locale 完整镜像：

```text
index.md
guide/
  getting-started.md
  architecture.md
  service-call.md
  streaming.md
  config-registry-store.md
  broker-events.md
  health-observability.md
reference/
  packages.md
  verification.md
```

翻译必须本地化表达：

- `zh-Hans` 使用自然简体中文；
- `zh-Hant-TW` 使用台湾常用术语与语气；
- `zh-Hant-HK` 使用香港常用繁体粤语书面表达；
- 其他语言使用自然开发者文体；
- 不使用简繁机械转换，不使用官样、公告式或生硬机器翻译。

locale parity test 要求相对路径集合完全一致，并明确断言三套中文正文不相同。

根 scripts 增加：

```json
{
  "doc:dev": "vitepress dev doc",
  "doc:build": "vitepress build doc",
  "doc:preview": "vitepress preview doc",
  "verify:doc": "bun test test/doc-site.test.ts && bun run doc:build"
}
```

`verify` 纳入 `verify:doc`。

## 17. 真实版本与外部服务

2026-07-21 从官方 release/API fresh 核实的实施版本：

| 能力 | 版本或本机验证 digest |
|---|---|
| Consul | 2.0.2 |
| etcd | `gcr.io/etcd-development/etcd:v3.7.0@sha256:6ecefbe2510c4a30573a62a4d6dd175acf881ca67003fcd91849a16df7a724d5` |
| Kubernetes/K3s | `rancher/k3s:v1.36.2-k3s1@sha256:6a47cea22c4b834d4ba72c89d291696b79ebe406251f90b446e4dff03513dd87` |
| NATS Server | 2.14.3 |
| OpenTelemetry Collector | 0.156.0 |
| Apache ZooKeeper | `zookeeper:3.9.5@sha256:4c6f15fbd5491a3e01b0108c046891125553329a4956848ba3014cedff5386ee` |
| VitePress | 1.6.4 stable |
| yaml | 2.9.0 |
| node-zookeeper-client | 1.1.3 |

上述三个 digest 已在本机 `linux/arm64` 真实 pull。etcd `/health` 返回 200 与 `health:true`；ZooKeeper
开启 `ruok` 4LW 白名单后返回 `imok`；privileged K3s 容器内使用 admin kubeconfig 调用 `/readyz` 返回
`ok`。K3s API ready 时 Node 尚未出现，因此该预检只证明 API harness 可实施，不冒充完整 Node Ready。
预检前后临时 container/network/volume 均为零。

Consul、NATS 与 Collector 的既有固定 digest 在相应 suite 中继续使用；任何尚未固定的新镜像首次 pull 后把
RepoDigest 写入测试定义与报告，后续门禁不依赖 mutable tag。

## 18. 验证矩阵

### 18.1 每个能力的本地门禁

每个新增或修改包必须完成：

- 红测试先行；
- targeted unit tests；
- 100% line/function coverage；
- package typecheck；
- source policy；
- package contract、manifest、owner；
- packed runtime 与 published type smoke；
- Bun、Node、Deno portable lanes；非 portable provider只跑诚实声明的 runtime。

### 18.2 Docker 与真实网络

不得用 fake 服务代替以下验收：

- Consul Store：CRUD、prefix、CAS、session TTL、ACL、restart、零残留；
- etcd Store/Config/Registry：range、txn CAS、lease、watch、compaction、restart、publisher kill；
- Kubernetes Registry：真实 K3s API、最小 RBAC、EndpointSlice CAS、foreign slice、410 relist、namespace 清理；
- ZooKeeper Registry：ephemeral、session expiry、watch re-arm、ACL、publisher kill；
- NATS Broker/Event：Core 与 JetStream typed round trip、PubAck、ackAck、nak/term；
- OTel：真实 Client → HTTP → Server 与 NATS traces/metrics；
- 自动注册：真实 Consul + HTTP bind + discovery + Client call + deregister/drain，并在真实 registration failure
  后证明已绑定端口回滚；
- ServiceError：unary/Fetch parity、malformed/oversize、unknown error masking、metadata/header bounds；
- streaming：真实 request upload 增量到达、Node 缺少 `duplex: "half"` 的拒绝、request cancel、response
  incremental/backpressure、never-consumed response、显式 body cancel、headers-scoped selector feedback、
  server stop/hard force、端口重绑；
- File Store：真实文件系统、独立进程 kill、temp 残留、checksum 损坏与最后成功快照恢复；
- Core hooks：四类 hook 顺序、各阶段 failure、shared deadline、caller cancellation、多失败聚合与 diagnostics。

每个 suite 结束后检查容器、网络、volume、端口、进程、timer、reader、watcher、subscription 与 remote record
均归零。

### 18.3 仓库总门禁

只有以下命令 fresh 退出 0 才能声明目标完成：

```text
bun run fmt:check
bun run verify:workspace
bun run verify:manifests
bun run verify:file-inventory
bun run typecheck
bun run build
bun run test:coverage
bun run test:coverage:workspaces
bun run test:examples:node
bun run test:published
bun run verify:doc
bun run test:e2e:prepared
bun run verify
```

仓库契约必须 fresh 回读并精确断言 36 个发布包、4 个私有 example、40 个 workspace。根 workspace 显式加入
所有 nested provider；`scripts/published/cli.ts`、`scripts/verify-workspace.test.ts`、
`test/repository-contract.test.ts`、`scripts/release-config.test.ts` 与全部 packed runtime/types fixtures 同步
每个新增 export，不以手写旧计数通过。

## 19. 实施顺序

依赖方向决定实施顺序：

1. 修复工作区基线计数，补 `@likego/struct` bytes codec；
2. 补 Core App identity/hooks 与 Health readiness；
3. 补 `@likego/server`、ServiceError、Client middleware、自动注册；
4. 补 Fetch Transport、Stream Client 与真实 streaming；
5. 补 Selector；
6. 建 `@likego/store` 与 file provider；
7. 建 Consul/etcd Store、YAML、etcd Config；
8. 建 etcd/Kubernetes/ZooKeeper Registry；
9. 建 Broker/Event 与 NATS typed provider；
10. 增加 OTel wrappers 与 Collector 联合验证；
11. 建立八语言 VitePress 文档站；
12. 更新 ADR、能力矩阵、README、inventory、manifests、Changesets；
13. 运行全部真实 Docker 与仓库总门禁；
14. 独立进行规范符合性、代码质量与最终 broad review。

不在多个并行 agent 中修改同一个生产文件。每个阶段完成后先做 targeted verification，再进入下一阶段。

## 20. 完成定义

“完整落地”要求同时满足：

- 本文列出的公共 API 与 provider 已真实存在；
- 每个 provider 的 capability 与 runtime 声明与实测一致；
- endpoint 分派和 Registry metadata 来自同一声明；
- bind/register/deregister/drain 顺序有真实联合证据；
- unary 与 Fetch streaming 都有真实 Client/Server 闭环；
- Store、Config、Registry 的外部服务测试不是 mock；
- typed Struct codec 被 Client/Server/Event 实际消费；
- Broker 不伪造 ack，Event decode 不替应用决定 settlement；
- OTel trace propagation 在真实 Collector 可见；
- 八种 locale 文档完整、可构建、可导航且本地化自然；
- 仓库恰好包含 36 个发布包、4 个私有 example、40 个 workspace，全部新增 export 有 packed
  runtime/types 证据；
- 全量命令 fresh 退出 0；
- 没有 Docker、进程、端口、timer 或远端记录残留；
- 没有未经说明的已知失败。

未经用户另行授权，本轮不 commit、push、创建 PR、publish 或 deploy。

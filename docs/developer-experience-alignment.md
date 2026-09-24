# go-like 开发者体验对齐基线

源码核对日期：2026-09-23；上游参考提交保留原调查基线。

## 目标

go-like 的公共 API、包导航和 examples 应尽量复用 go-micro、go-kratos 与
go-zlab/go-kratos 已经建立的用户心智。只有 TypeScript、标准 Web API、运行时差异或已经批准的产品边界能够
证明上游形态不可直接采用时，才允许偏离。

禁止仅以“实现更完整”“测试更方便”“将来可能扩展”作为创建新公共概念的理由。

## 精确参考基线

| 项目              | 默认分支精确提交                                                                                                                   | 本项目采用的参考范围                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| go-micro          | [`9d306dcfc1a912a8a9493f31fee0bb983475258d`](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)    | package 能力域、Client、Transport、Registry、Config、Store、Broker 等 SPI |
| go-kratos         | [`668db92c2c001e9552594ba5a8aede8456af6d7e`](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)  | App、Server、生命周期 option、Registrar/Discovery 与 middleware 体验      |
| go-zlab/go-kratos | [`ecd00dd24491d09642c76542f94e392c6d639336`](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336) | 第三方 Web、Cron、队列和消息组件作为 Server 接入 App 的方式               |

上表固定提交中的 go-zlab 模块依赖 Kratos v2.9.2，因此只参考 adapter 用户体验，不把它当作 Kratos v3 的类型基线。

## 参考优先级

上游之间存在差异时，不同时发布两套 facade：

1. App、Server 和第三方 adapter 生命周期以 go-kratos v3 与 go-zlab 为准。
2. 微服务能力域、包职责和业务 SPI 以 go-micro 为准。
3. 同一概念只能有一条 canonical happy path；高级入口只能暴露同一模型的底层能力。
4. 用户已经明确批准的产品边界优先于上游功能数量。

因此 go-like 只提供一套 App 启动模型，也不复制 go-micro 的全局默认实例。与 go-micro 同角色的 Transport 保留
`init/options/string`；内部 Server 保留 `options/string`，Broker 保留 provider 诊断名和每次发布、订阅的原生
option。采用 Kratos 风格契约的 Registry 只承担注册和发现。

## 允许保留的偏离

以下偏离具有明确理由：

- 运行时值使用 TypeScript lower camel case；类型和接口使用 PascalCase。
- Go 的阻塞调用映射为 Promise，公共契约使用结构类型，不要求继承。
- HTTP 数据面使用标准 `Request`、`Response`、`Headers`、Fetch 与 Web Streams。
- provider 独立发布为 npm package，以隔离 peer dependency 与 runtime dependency。
- Registry 的应用契约、Selector 与 `Filter` 位于 `@go-like/registry`；provider 作者使用的错误、快照和公共
  constructor option 辅助位于 `@go-like/registry/provider`，避免实现细节挤入应用入口。
- 外部 Web 使用 `@go-like/web`；内部同步通信使用 `@go-like/transport` 与
  `@go-like/transport-http`。这些名称和边界已经由用户批准。
- Hono、Elysia 与 H3 2.x 直接把 `app.fetch` 交给 `@go-like/web`，H3 1.x 使用官方 `toWebHandler(app)`；go-like 不发布只做转发的框架 wrapper。
- Go 通过 `cron.NewServer`、`asynq.NewServer` 的 package selector 保留来源；TypeScript named import 会把多个
  `newServer` 压到同一作用域。会被同一应用并排装配的 adapter 因此保留 `newCronerServer`、
  `newBullMqWorkerServer`、`newBrokerServer` 等描述性工厂名，避免用户在每次 import 时手工 alias；这只是语言
  命名差异，不增加第二套生命周期或产品概念。
- Node/Bun 进程信号没有标准 Web API，因此通过 runtime 子路径提供一个 App signal option；它不能演变成第二套
  App runner 或公共 runtime host SPI。
- JavaScript Promise 不可取消，独立发布的 provider 需要共享“caller 仅放弃等待、资源 owner 继续清理”的
  安全实现，因此保留 provider-facing `@go-like/core/lifecycle`；应用 happy path 不需要导入该子路径。
- JavaScript listener 通常异步绑定端口，因此内部 unary Server 的 `endpoint(ctx)` 返回
  `string | Promise<string>`，并与 `start(ctx)` 共享同一次 bind；Transport 专属监听设置通过
  `listenOption(...)` 传递，不进入 Core `Server`。`address(...)` 只负责 bind，`advertise(...)` 在 wildcard、
  容器端口映射或 Ingress 场景显式给出注册端点，不猜测网络拓扑。
- Go 可以把配置反序列化到目标对象，TypeScript interface 在运行时不存在，因此 Config 使用 Standard Schema
  校验和转换。`onReloadError(...)` 观察可恢复重载失败，`onTerminalError(...)` 观察初次就绪后的第一次
  不可恢复后台失败；二者均不增加生命周期。
- Protobuf-ES descriptor/codec、Connect client/protocol handler 与 ctx-first generated glue 只进入独立的
  `@go-like/protoc-gen-like` / `@go-like/transport-grpc-buf` 边界，不改变原有 unary Message Transport。
- Event Store、历史 replay 与更多 Registry provider 仍是已经批准的排除项。

## Generated RPC 形态

生成 API 保持一个 ctx-first 形态，不增加 option bag 或 Go-style tuple：

```ts
export interface OrderServiceHandler {
  getOrder(
    ctx: Context,
    request: MessageShape<typeof GetOrderRequestSchema>
  ): MessageInitShape<typeof OrderSchema> | Promise<MessageInitShape<typeof OrderSchema>>
  watchOrders(
    ctx: Context,
    request: MessageShape<typeof WatchOrdersRequestSchema>
  ): AsyncIterable<MessageInitShape<typeof OrderEventSchema>>
}

export interface OrderServiceClient {
  getOrder(
    ctx: Context,
    request: MessageInitShape<typeof GetOrderRequestSchema>
  ): Promise<MessageShape<typeof OrderSchema>>
  watchOrders(
    ctx: Context,
    request: MessageInitShape<typeof WatchOrdersRequestSchema>
  ): AsyncIterable<MessageShape<typeof OrderEventSchema>>
}

export function registerOrderServiceHandler(
  server: ServiceRegistrar,
  handler: OrderServiceHandler
): void

export function newOrderServiceClient(client: ConnectTransport): OrderServiceClient
```

Handler unary/server-streaming 请求是解码后的 `MessageShape`，client-streaming/bidi 请求是
`AsyncIterable<MessageShape<...>>`；响应接受 `MessageInitShape`，其中 unary 允许直接值或 `Promise`，
client-streaming 返回原生 `Promise<MessageInitShape<...>>`，server-streaming/bidi 返回
`AsyncIterable<MessageInitShape<...>>`。Client unary/server-streaming 请求接受 `MessageInitShape`，
client-streaming/bidi 请求接受 `AsyncIterable<MessageInitShape<...>>`；解码响应是 `MessageShape`，其中
unary/client-streaming 返回 `Promise`，server-streaming/bidi 返回 `AsyncIterable`。生成代码只提供
`registerXHandler(server, handler)` 与 `newXClient(client)` 胶水，并借用调用方提供的 Connect transport；raw
descriptor/transport 保留为 advanced escape hatch。

`@go-like/transport-grpc-buf` 根入口的标准 `Request` / `Response` Fetch handler 只证明 Connect 与
gRPC-Web unary/server-streaming；request-streaming 与 bidi 明确拒绝。`/native` 使用官方 Connect Node primitive
提供托管的标准 gRPC client/server，四种 cardinality 已在 Node 26.7.0、Bun 1.4.0、Deno 2.9.5 的物理发布包
测试中通过。Node 是上游支持 runtime；Bun 与 Deno 的兼容性 lane 记录实际执行版本和结果，不设置通用的固定版本准入门禁。official health/reflection、validation、
canonical error details、Google runtime 与 Buf online services 仍不在当前实现。`@go-like/protoc-gen-like`
由 npm/pnpm/Yarn package script 启动，是 project-local Node 22+ dev tool；Bun 只用于本仓库内部 build/package。
Deno-only 环境没有 Node 时在 CI 生成并消费产物，不提供第二套 launcher。

上述四类 RPC 结果只对应基础互操作。当前仍有 Connect 2.1.2 取消暂停流后 deadline timer 滞留、
Bun 1.4.2 Fetch 取消传播和 Deno 2.9.5/2.9.7 HTTP/2 慢消费排空限制；完整可靠性矩阵没有全部通过。
准确范围见 [grpc-buf README](../packages/transport/grpc-buf/README.md)，不能据此承诺所有运行时均已生产验证。

## Transport 装配形态

HTTP/internal unary 与标准 gRPC 共享 Kratos 风格的装配顺序，不共享 wire registrar 类型：

下面 HTTP 示例的 `newOrderServiceClient` / `registerOrderServiceHandler` 是应用基于 `Endpoint` 和
`HandlerRegistrar` 编写的胶水；它们与上一节 protobuf 生成函数同名，但不能互换。仓库内的
`protoc-gen-like` 只生成 protobuf/Connect 胶水，不生成 Struct HTTP client。

```ts
const client = newClient(
  withTransport(newHTTPTransport()),
  withAddress("https://orders-a.internal", "https://orders-b.internal"),
  withSelector(newRoundRobinSelector())
)
const orders = newOrderServiceClient(client)

const server = newServer(
  transport(newNodeHTTPTransport()),
  address("0.0.0.0:9000"),
  advertise("orders.internal:9000")
)
registerOrderServiceHandler(server, orderService)
```

服务发现只替换构造时的地址来源；HTTP 使用 `orders-http`，标准 gRPC 使用 `orders-grpc`：

```ts
const client = newClient(
  withTransport(newHTTPTransport()),
  withService("orders-http"),
  withDiscovery(discovery),
  withSelector(newRoundRobinSelector())
)
const orders = newOrderServiceClient(client)
```

标准 gRPC 使用下面的 owner import，并搭配对应 protobuf 文件生成的 service API：

```ts
import {
  address,
  advertise,
  newClient,
  newServer,
  withAddress
} from "@go-like/transport-grpc-buf/native"

const client = newClient(withAddress("https://orders.internal"))
const orders = newOrderServiceClient(client)

const server = newServer(address("0.0.0.0:9000"), advertise("orders.internal:9000"))
registerOrderServiceHandler(server, orderService)
```

## Canonical 生命周期

目标公共体验只保留：

```ts
export interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}

export interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

const app = newApp(name("orders"), server(httpServer, cronServer), signal())

await app.run()
```

- `Server.start(ctx)` 可以在接纳完成后返回，也可以持续到整个运行期结束；Core 接受两种上游实现，
  不额外要求所有第三方 adapter 维持 pending Promise。
- `Server.stop(ctx)` 请求停止；`App` 本身不实现 `Server`。
- `server(...servers)` 一次接收多个 Server。
- Core 通过 `Promise.allSettled` 并发停止 child Server 并收集全部结果，不承诺资源依赖顺序；需要顺序的清理应由
  同一个 Server 或显式 App hook 表达。
- `signal()` 位于 Node-compatible runtime 子路径，只负责把 SIGINT、SIGQUIT、SIGTERM 接入同一个 App
  生命周期；App 编排仍只存在于 `app.run()`。

## 当前公开入口

| 能力     | Canonical API                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client   | `newClient(withTransport(...), withAddress(...))` 在构造时确定直连地址；服务发现改用 `withService(...)`、`withDiscovery(...)`，两者共用 `withSelector(...)`。可显式加入 `withBlock()` 等待服务第一次出现原始 endpoint，并在结束时调用 `client.close(ctx)`。调用期只保留 `withFilter(...)`、`withRetry(...)` 等行为 option。                                                                                                       |
| Registry | 应用从 `@go-like/registry` 导入 `Registrar`、`Discovery`、`Registry`、`Watcher`、`ServiceInstance`、`Selector`、`Filter` 与内建 selector/filter；provider 实现从 `@go-like/registry/provider` 导入共享辅助。                                                                                                                                                                                                                      |
| Server   | 内部 unary 服务先使用 `newServer(transport(...), address(...), advertise(...), middleware(...), use(...), listenOption(...))`，再以 `registerXHandler(server, handler)` 或 `server.registerHandler(...)` 注册。`rateLimitMiddleware(limiter)` 可作为全局或 operation middleware；`endpoint(ctx)` 暴露真实注册端点，Core App 使用 `registrar(...)` 统一注册。                                                                      |
| Config   | `newConfig(source(...), resolver(...), schema(...), onReloadError(...))` 返回只含 `load(ctx)`、`scan(ctx, schema)`、`value(key)`、`watch(key, observer)`、`close(ctx)` 的 Config。resolver 在 merge 后、schema 与发布前按声明顺序运行；`placeholderResolver()` 只解析当前快照引用。File、Env、Consul、etcd、Vault 与 Kubernetes 都实现同一 `ConfigSource`。App 用 `beforeStart`/`afterStop` 组合 Config，不能传给 `server(...)`。 |
| Store    | Memory、Consul、etcd、Vault provider 构造后立即执行 `read/write/delete/list`；File provider 因独占目录锁和快照文件所有权同时实现 Store 与 `Server`，只在 `start/stop` 运行期内读写。                                                                                                                                                                                                                                              |
| Broker   | Memory、NATS 与 RabbitMQ provider 共用 `publish(...)`、`subscribe(...)`、`Subscriber.unsubscribe(ctx)`；RabbitMQ canonical 入口 `newRecoveringRabbitMqBroker(...)` 复用 `amqplib` recovery setup 重建 package-owned channel、topology 与 consumer，`newRabbitMqBroker(channel)` 只作为明确的 borrowed-channel 入口。`newBrokerServer(...)` 把一次订阅接入 Core 生命周期，但不拥有应用的 connection、stream 或 durable consumer。  |
| Web/框架 | 外部接入保持标准单参数 `Handler`；Hono、Elysia 与 H3 2.x 直接提供 `app.fetch`，H3 1.x 使用官方 `toWebHandler(app)`，不需要 go-like 框架桥接包。                                                                                                                                                                                                                                                                                   |
| RPC      | `@go-like/protoc-gen-like` 生成 ctx-first Handler/Client；`@go-like/transport-grpc-buf` 根入口提供 Connect/gRPC-Web portable Fetch，`/native` 提供托管标准 gRPC。Fetch 只覆盖 unary/server-streaming；标准 gRPC 四种 cardinality 覆盖 Node 26.7.0、Bun 1.4.0、Deno 2.9.5。                                                                                                                                                        |

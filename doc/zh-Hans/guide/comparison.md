# go-like 与其他工具的比较

公平的比较应该从所有权开始，而不是从功能数量清单开始。这里的所有权，是指谁创建资源、谁负责停止它、谁观察它的最终状态。NestJS、Fastify、Hono、Elysia、Koa 和 tRPC 解决的是 TypeScript 应用栈的不同部分。go-micro 和 go-kratos 是 Go 生态的框架参考，它们在 transport 和代码生成上也有不同选择。go-like 则是一组面向 TypeScript 的构建块，强调显式生命周期、内部 unary call（一次请求对应一次响应的内部调用）、provider 契约和跨 runtime 组合。

本页把证据分成几档：

- **Source**：当前 go-like checkout 暴露了所述 API 或边界。
- **Pinned external**：比较使用研究记录中固定的 release、commit 或官方文档。它不是新跑的 benchmark，也不表示未固定版本的 `main` 分支没有变化。
- **Declared**：仓库里有示例或测试 lane。这不等于该 lane 已通过。
- **Gap**：当前仓库没有证明兼容性承诺。

本轨道使用的 go-like source baseline 是 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`。本地研究记录里存在一个 go-micro commit 不一致：一条比较记录写的是 `9d306dcfc1a912a8a9493f31fee0bb983475258d`，而详细的固定版本备忘录检查的是 `v6.9.0` 的 `3c39d17fadaa9ec21b671be4afef3e63846406e6`。请把它们视为需要复核的比较输入，不要把它们当成当前 upstream 保证。

## 在技术栈中的位置

| 工具      | 主要解决的问题                       | 通常由它拥有的部分                                                                                                                                                       | go-like 可以补充、但不替换的部分                                                         |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| NestJS    | 约定驱动的 Node 应用框架             | Modules、providers、controllers、decorators、application context、framework lifecycle、HTTP 或 microservice adapter                                                      | 围绕原生应用增加结构式 lifecycle boundary 或 internal call contract，前提是自己写 bridge |
| Fastify   | Node HTTP server 和请求处理 pipeline | Route table、hooks、plugins、encapsulation、Node listener、request/reply objects                                                                                         | 围绕 Fastify 所拥有的资源增加 lifecycle 或 provider adapter                              |
| Hono      | Web Standards 路由和 middleware      | Routes、middleware、sub-apps、`app.fetch`、runtime adapter 选择                                                                                                          | Core App、显式资源生命周期、内部 Client/Transport、discovery                             |
| Elysia    | Bun 优先的 typed Web framework       | Route tree、schema 组合、decorators、hooks、Bun 或 Web Standard adapter                                                                                                  | 保留原生 Elysia 行为的同时增加 Core lifecycle 和内部 service building blocks             |
| Koa       | 精简的 Node middleware kernel        | Middleware stack 和 Node listener；router 通常由外部提供                                                                                                                 | 不再引入另一套路由器的前提下补上 lifecycle 和内部 service contract                       |
| tRPC      | 类型安全的 procedure layer           | Router/procedure paths、input/output parsers、context factory、HTTP/Fetch/WS adapters                                                                                    | Provider ownership、service discovery、selector policy、显式 App lifecycle               |
| go-micro  | Go 微服务和 agent-oriented 生态      | Go Context、service/client/transport/registry/broker 抽象，以及额外的 agent/flow/MCP/A2A 范围                                                                            | go-like 借用部分词汇，不借用 Go ABI、goroutine 或 transport 兼容性                       |
| go-kratos | Go 云原生服务框架                    | App lifecycle、Go Context、HTTP/gRPC transports、middleware、registry、config、Protobuf/code generation                                                                  | go-like 共享显式生命周期词汇，但刻意选择 TypeScript/Web API，不提供 gRPC/IDL             |
| go-like   | 显式的 TypeScript 服务构建块         | Context、App/Server lifecycle、standard Fetch edge、内部 unary Message transport、Client/Server、Registry/Discovery/Selector、Config/Store/Cache/Broker/Health、adapters | 应用仍拥有框架路由、原生数据面、业务策略、认证和部署                                     |

所以，go-like 并不是要赢一场“谁的框架最大”的比较。真正的问题是：应用是否需要这些边界保持显式、并且可以组合。

## 所有权矩阵

| 关注点                 | NestJS                                        | Fastify                            | Hono / Elysia / Koa                                         | tRPC                                       | go-like                                                         |
| ---------------------- | --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| 外部 route table       | Controllers 和 decorators                     | Fastify instance                   | Framework instance 或外部 router                            | Procedure router，不是普通 REST routes     | 外部 framework 或 application                                   |
| Web handler ABI        | Adapter 所有的 request/reply abstraction      | Node request/reply                 | 对 Hono 和 Web Standard adapter 来说，Standard Fetch 是核心 | Fetch/Node/Express/Fastify adapters        | 标准的 `(Request) => Response \| Promise<Response>`             |
| Application lifecycle  | Application context 和 hooks                  | `ready`、`listen`、`close`、hooks  | Runtime adapter 和 framework lifecycle 各不相同             | 由 host/adapter 负责                       | `newApp`、`App.run`、`App.stop`、hooks、结构式 Servers          |
| Resource lifecycle     | Container/framework hooks                     | Plugin 和 server hooks             | 由 application/runtime 负责                                 | 由 application/adapter 负责                | 显式的 `Server.start(ctx)` / `stop(ctx)` 契约和 adapter 所有权  |
| Dependency composition | Nest container/providers                      | Plugin decoration 和 encapsulation | Context/env 和组合；没有通用 DI container                   | 显式 context factory 和 router composition | 显式 constructors 与 functional options；没有 DI container      |
| Internal transport     | Microservice transports 和 framework adapters | 不是 service discovery 抽象        | 不是 service discovery 抽象                                 | Procedure adapters 和可选 WebSocket        | `Transport`、`Client`、`Listener`、`Socket`、unary `Message`    |
| Discovery 和 selection | Transport-specific 或外部提供                 | 外部提供                           | 外部提供                                                    | 外部提供                                   | `Registry`、`Discovery`、`Watcher`、Filters、五种 Selector 策略 |
| Retry                  | Framework 或 provider-specific                | Application/plugin-specific        | Application-specific                                        | Middleware/adapter-specific                | 默认一次；`withRetry` 需要授权和总尝试次数                      |
| Streaming              | Framework/provider 选择                       | Node/Web stream 选择               | 原生 Web Streams 和 framework API                           | 取决于 adapter 的 HTTP/WS                  | 对外 Web streaming 是原生能力；内部 RPC 仍为 unary              |
| Global instrumentation | Framework/provider integration                | Plugin ecosystem                   | Middleware ecosystem                                        | Middleware/adapters                        | 显式 wrappers；不安装 global provider                           |

前五行的标签描述的是架构位置，不是质量排名。框架拥有 route table，在 route composition 是主要问题时很有用；这只是和 go-like 把路由留给应用所做的不同所有权选择。

## Lifecycle 与 Context

当前 go-like source 定义了：

```ts
interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}
```

`Server` 契约是结构式的。只要 adapter 能诚实地说明资源如何被接纳、最终状态如何产生，原生 worker、listener、scheduler、Broker subscription、logger destination 或 telemetry provider 都可以加入 Core。

go-like Context 同样是结构式的，内部使用 `AbortSignal`。它暴露 `deadline()`、`done()`、`err()` 和 `value(key)`，并提供 `background`、`withCancel`、`withCancelCause`、`withTimeout`、`withDeadline`、`withoutCancel` 和 `withValue` 等构造函数。

这和 Go 的显式 Context-first 风格相似，但与 `context.Context` 并不 ABI-compatible。它不提供 goroutines、channels 或 gRPC。正确的迁移问题应该是“取消和所有权在哪里跨过这条边界？”，而不是“哪个类型名称一模一样？”

Core 不承诺 sibling Servers 按声明的反向顺序关闭。它会并发调用 sibling `stop(ctx)`，然后等待 terminal `start` Promises 并聚合失败。Nest application context、Fastify plugin graph、Elysia lifecycle 或 host adapter 可能有不同的顺序和终态语义。比较时要看真正的所有者，不要只看“graceful”这个标签。

## Transport 与服务调用

go-like 的内部调用链是刻意拆开的：

```text
Client
  -> Discovery snapshot, optional
  -> ordered Filter callbacks, optional
  -> Selector.select
  -> opaque ServiceEndpoint URL
  -> Transport.dial or resident logical owner
  -> send(Message)
  -> @go-like/server route and unary handler
  -> recv(Message)
  -> feedback and owner release
```

typed `Endpoint` 把 `Struct` request/response validation 绑定到现有的 `Message` 边界上。它不是 IDL，也不是生成式 protocol。`withAddress(...)` 会绕过 Discovery 和 Selector，因此进程内 Memory Transport 路径很适合做第一条测试。

NestJS 的 microservice transport 选项、tRPC procedure adapter 和 Go framework transport，都不能和这张 DAG 直接互换。它们可能拥有不同的 route identity、serialization model、connection pool 或 retry layer。比较时应记录这些差异，不要把所有名字里有“RPC”的方框都当成同一种能力。

## Retry 与 streaming 范围

最重要的反向比较是语义：

- go-like 默认每次调用只尝试一次。
- `withRetry(...)` 要求提供 `authorization: "idempotent" | "caller-approved"`、正数 `maxAttempts` 和 `shouldRetry`。
- 这个 authorization 是调用方声明，不是系统证明该操作幂等。
- 每次重试都会重新进入 discovery 和 selection，因此可能选到新的 endpoint。
- 如果 response 已经收到，但后续 feedback 或 cleanup 失败，不会重新 replay 这次 response。

Go 比较研究记录了不同的默认值和能力：go-micro 的 `DefaultRetries` 不能简单说成“总共五次请求”，因为当 retry approval 仍为 true 时，它的 loop boundary 可能产生六次迭代；它的 public stream 形态和默认 `CloseSend` 实现也会随 provider 变化。go-kratos 把 Protobuf/gRPC generation 与 HTTP streaming 形态结合起来，而 SSE 和 WebSocket 的方向与关闭行为并不相同。这些是 provider 和架构选择，不是 go-like 少了几个 flag。

对 go-like 来说：

```text
Web framework or Fetch Handler
  -> Web Streams, SSE, or WebSocket behavior owned by the application/framework

go-like internal Client/Transport
  -> one unary Message request and one unary Message response
  -> no full-duplex RPC Stream SPI
```

Web `ReadableStream` 不是内部 RPC channel。不要把 streamed HTTP body 和多帧 `send`/`recv` transport 当成同一个 feature。

## Runtime 比较

| Runtime 问题                                                 | go-like 证据                                                                                        | 比较时的结论                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 共享代码能否使用 Fetch 和 `AbortSignal`？                    | Root Web 以及选定的 transport/config provider 使用标准 Web API 或注入的 Fetch                       | 可以有相似的可移植性目标，但类型不会替 runtime 实现行为 |
| 同一个 package 能否绑定 Node listener 和 Deno listener？     | Runtime-specific 子路径是明确的；`@go-like/web/node` 和 `@go-like/transport-http/node` 是 Node 路径 | 不要写“所有包到处都能原样运行”                          |
| 自定义 PEM TLS、mTLS、ALPN 和 HTTP/2 能否通过 Fetch 可移植？ | Node transport 子路径拥有原生能力；root Fetch path 不暴露全部控制项                                 | 应比较 host 能力和 import path，而不只是 package 名称   |
| 应用是否保留 framework router？                              | Hono、Elysia 和 H3 示例都传入原生 Fetch handler                                                     | go-like 是 framework route ownership 的补充             |
| package version 是否证明已经发布？                           | Root 和 packages 都是 private/workspace `0.0.1`；仓库文档说明尚未发布                               | 不能据此声称 npm 可用或生态成熟                         |

当前仓库有 Hono、Elysia、H3 和 vanilla Fetch 的直接 source 示例。没有当前的 NestJS 或 Fastify bridge，也没有对应 compatibility suite。这些框架是迁移读者的对象，不是已经支持的直接集成。

## 按工具详细比较

### NestJS

NestJS 是约定驱动的应用框架。它的 modules、providers、controllers、decorators、interceptors、pipes 和 application hooks 共同组成一个完整的 container 与 request model。go-like 没有提供 Nest-compatible module container 或 controller bridge。

合理的集成边界，是由应用自己围绕 Nest application 或 host 实现一个结构式 `Server` adapter。这个 adapter 需要定义 Nest 何时已经接纳 listener、`stop(ctx)` 如何映射到 Nest close，以及超时后发生什么。当前仓库没有证明这类 bridge，所以文档不应该展示直接调用 `newNodeServer(nestApp, ...)`。

### Fastify

Fastify 拥有 route table、plugin encapsulation、hooks 和 Node listener。它的 plugin graph 很适合用来比较 dependency scope，但 `decorate` 不是 Nest 风格的通用 provider container。go-like 不会自动把 Fastify 的 `request`/`reply` ABI 转成 Fetch Handler，仓库当前也没有测试 Fastify bridge。

保留 Fastify 的 routes 和 plugins。如果接入 go-like，就围绕 Fastify owner 写显式结构式 Server，或自己实现一个单独的 Fetch boundary。不要把 Fastify 自己的 request injection 或原生 shutdown 叫作 go-like Transport 或 Client 契约。

### Hono

Hono 是当前已经展示的最清晰的互补关系。现有示例在 Hono 中创建 routes，把 `app.fetch` 传给 `newNodeServer`，再把这个 host 放进 Core App。路由和 middleware 仍由 Hono 拥有；应用选择时，go-like 负责 host lifecycle boundary。

### Elysia

Elysia 提供 Bun-first 的 route 和 schema composition，也在相关 adapter path 暴露 Web Standard handler。保留 Elysia 的 route tree、decorators、derives、hooks、streams 和 Bun-specific behavior。go-like 可以拥有 App 和显式资源边界，但不会把 `.listen()` 变成跨 runtime 的 go-like API。

### Koa

Koa 是一个小型 Node middleware kernel，不内置 router。这正好说明了有些框架会有意把更多 application composition 留在核心之外。go-like 不应该通过增加 router 来填这个空白。保留 Koa middleware 和外部 router，只在需要的地方增加 lifecycle 或内部调用边界。

### tRPC

tRPC 拥有类型安全的 procedure router 和 procedure middleware。它可以使用 Fetch、Node、Express、Fastify 或 WebSocket adapter，但它不是 Registry、Selector、connection pool 或 application lifecycle manager。go-like 的 typed Endpoint 是对 unary Message 做的更小的 runtime Struct binding，不是另一个 procedure DSL，也不是生成式 IDL。

### go-micro 与 go-kratos

这两个 Go 项目可以作为 Context-first call、service lifecycle、Registry、Discovery、Selector 和 transport 词汇的架构参考，但不是兼容目标：

- Go `context.Context` 和 go-like `Context` 都强调显式取消，但 runtime 表示不同。
- go-micro 的 Registry watcher model 与 go-like 的完整替换 snapshot，不应该被教成相同的 event stream。
- go-kratos 的 Protobuf/gRPC 和 generated code 是一种架构选择，go-like 明确不做这个承诺。
- go-micro 和 go-kratos 的 provider 默认值、retry loop、stream half-close 行为和 selector 默认值都与版本有关。发布新的比较版本前，应使用研究记录中的 fixed upstream commit table 重新核对。

## 怎么选

| 如果你的主要问题是……                            | 先从……开始            | 在这些情况下再加 go-like                                             |
| ----------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| Controllers、modules、decorators 和 DI          | NestJS                | 需要围绕现有资源或内部服务调用增加显式边界，并且愿意自己写 adapter   |
| Node HTTP routes、hooks 和 plugin encapsulation | Fastify               | 需要超出 host 的生命周期组合，或需要内部 unary service contract      |
| 跨 runtime 的 Web Standards routes              | Hono                  | 需要 App/Server lifecycle、内部调用或 provider ownership             |
| Bun-first 的 schema 和 route composition        | Elysia                | 保留 Elysia 的同时，需要显式 lifecycle 和 transport boundary         |
| 精简的 Node middleware                          | Koa 加一个 router     | 需要补的是缺失的 lifecycle 或内部调用契约，而不是再加一个 router     |
| 类型安全的 procedures                           | tRPC                  | 同时需要显式 service discovery、provider ownership 或 Core lifecycle |
| Go 微服务栈                                     | go-micro 或 go-kratos | 正在构建独立的 TypeScript 组合，而不是做 source-compatible port      |
| 跨 runtime 的 TypeScript 服务构建块             | go-like               | 只使用解决当前边界问题的 packages 和 providers                       |

正确答案可能是两套系统一起用。当显式所有权模型确实消除了一个实际歧义时，go-like 最有价值；一个已经完整的 framework application 如果把每个 package 都加进来，就违背了小型构建块的目标。

## 证据锚点

本页对 go-like 的判断可以追溯到当前 tree 和 package entrypoints：

- `README.md`：产品范围和明确排除项；
- `packages/core/src/app.ts`：`App`、`Server`、startup、stop 和 timeout 行为；
- `packages/web/src/context.ts`：标准 Handler 和 Context bridge；
- `packages/client/src/index.ts`：Client options、pooling、retry 和 attempt pipeline；
- `packages/server/src/index.ts`：内部 unary handlers 和 route dispatch；
- `packages/transport/src/types.ts` 和 `packages/transport/src/endpoint.ts`：Message 与 typed Endpoint 边界；
- `packages/registry/src/types.ts` 和 `packages/registry/src/selector.ts`：snapshots、filters、selectors 和 feedback。

研究记录还保存了以下固定版本的外部比较输入：

- [仓库记录的 go-micro comparison commit](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)；
- [go-kratos v3 comparison commit](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)；
- [go-zlab/go-kratos comparison commit](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336)；
- [NestJS lifecycle documentation](https://docs.nestjs.com/fundamentals/lifecycle-events)、[Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/)、[Hono API](https://hono.dev/docs/api/hono)、[Elysia lifecycle](https://elysiajs.com/essential/life-cycle)、[Koa](https://koajs.com/) 和 [tRPC routers](https://trpc.io/docs/server/routers)。

这些 URL 是比较参考，不表示本次文档阶段重新抓取或重新验证了每个 upstream 页面。修改与版本相关的比较陈述前，请重新核对 release tag 或 commit。

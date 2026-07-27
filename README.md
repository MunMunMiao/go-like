# LikeGo

LikeGo 是一套面向后端微服务、以 Go 风格设计的 TypeScript 工具包。它提供显式 `Context`、结构式
`Server` 生命周期、内部服务 Transport、Registry、外部 Web 接入，以及配置、任务、消息、日志、监控和
可观测性集成。

LikeGo 不提供大而全的应用框架。应用继续直接使用 Hono、H3、Elysia、Croner、BullMQ、NATS、RabbitMQ、
Pino、Winston、OpenTelemetry 等官方 API；LikeGo 只定义公共契约、生命周期所有权和必要的机械适配。

可直接运行的行业与框架案例见 [`examples/README.md`](examples/README.md)。每个目录都是在本仓库 workspace
内可独立启动、测试的 private 小程序；它们使用 `workspace:*` 依赖，复制单个目录不等于得到可独立安装的发布项目。

> [!IMPORTANT]
> 当前 `@likego/*` 包尚未发布到 npm；下文的 `bun add` 与 `bunx` 命令描述首发后的用法。当前源码请在仓库根目录执行
> `bun install --frozen-lockfile` 和 `bun run test:examples`；需要启动实际程序时，执行
> `bun run --cwd examples/vanilla-web start`。

## 设计准则

- `Context` 始终是有取消语义操作的独立首参，不藏入 option bag。
- 公共接口保持精简，使用结构类型；不要求继承、decorator、反射或依赖注入容器。
- 构造选项使用同步 functional options；Server 使用显式 `start`、`stop`，App 只通过 `run`、`stop`
  编排同一套生命周期。
- TypeScript 的可见性只由 `export` 决定；函数、工厂、option、常量和普通运行时值使用 `camelCase`，不复制
  Go 的首字母大写导出规则。类型、接口、类和 Error 构造器按 TypeScript 惯例使用 `PascalCase`。
- 可移植入口只依赖 ECMAScript 与标准 Web API，并在 Bun、Node.js、Deno 后端运行时验证。
- runtime 或供应商能力通过独立入口隔离；应用拥有第三方库的数据面，LikeGo 只接管明确移交的生命周期。
- 外部 HTTP 应用属于 `@likego/web`；内部微服务同步通信属于 `@likego/transport` 及其实现。
- gRPC、Protobuf、IDL 代码生成和全双工 HTTP stream 不属于 v1。

## 包结构

所有发布包位于 `packages/`。公共能力域与具体实现保持清晰依赖方向：

```text
packages/
  broker/                  @likego/broker
    memory/                @likego/broker-memory
    rabbitmq/              @likego/broker-rabbitmq
  cache/                   @likego/cache
    memory/                @likego/cache-memory
    redis/                 @likego/cache-redis
  event/                   @likego/event
  context/                 @likego/context
  client/                  @likego/client
  core/                    @likego/core
  create/                  @likego/create
  config/                  @likego/config
    consul/                @likego/config-consul
    etcd/                  @likego/config-etcd
    kubernetes/            @likego/config-kubernetes
    vault/                 @likego/config-vault
  health/                  @likego/health
  metadata/                @likego/metadata
  registry/                @likego/registry
    consul/                @likego/registry-consul
    etcd/                  @likego/registry-etcd
    kubernetes/            @likego/registry-kubernetes
    mdns/                  @likego/registry-mdns
    zookeeper/             @likego/registry-zookeeper
  resilience/              @likego/resilience
  server/                  @likego/server
  store/                   @likego/store
    consul/                @likego/store-consul
    etcd/                  @likego/store-etcd
    file/                  @likego/store-file
    memory/                @likego/store-memory
    vault/                 @likego/store-vault
  transport/               @likego/transport
    http/                  @likego/transport-http
    memory/                @likego/transport-memory
  web/                     @likego/web
  hono/                    @likego/hono
  h3/                      @likego/h3
  elysia/                  @likego/elysia
  croner/                  @likego/croner
  bullmq/                  @likego/bullmq
  nats/                    @likego/nats
  pino/                    @likego/pino
  winston/                 @likego/winston
  otel/                    @likego/otel
  prometheus/              @likego/prometheus
```

`@likego/config/env`、`@likego/config/file`、`@likego/config/node` 与 `@likego/config/yaml` 是配置子路径；
`@likego/registry/provider` 与 `@likego/store/provider` 只承接 provider 作者需要的校验、快照和错误辅助；
应用使用的 Registry、Selector、`Filter` 与 Store 契约仍从各自包根导入。`@likego/nats/broker`、
`@likego/nats/jetstream` 与 `@likego/nats/jetstream/broker` 分别承接 NATS Core、JetStream 生命周期和
Broker SPI。相同后端的 Config、Registry、Store 仍是不同职责，例如 Consul 对应三个独立包，不通过聚合包
混合能力域。

## 创建内部微服务

`@likego/create` 生成一个带独立 package manifest、安装后可测试并运行的内部 unary 微服务，不创建外部 Web 页面，也不引入
Proto、模板引擎或交互式配置：

```sh
bunx @likego/create orders-service
cd orders-service
bun install
bun run typecheck
bun run test
bun run start
```

生成项目把 transport contract、业务处理和 `newApp(..., server(...), signal())` 装配拆成独立文件。服务启动后
会打印实际 endpoint 与可复制的 `curl` 命令。

## 外部 Web 服务

`@likego/web` 的公共 ABI 是标准单参数 Web Handler：

```ts
type Handler = (request: Request) => Response | Promise<Response>
```

Node.js 可直接使用 `@likego/web/node` 承接 Handler；框架路由仍归应用所有：

```sh
bun add @likego/context @likego/core @likego/web
```

创建 `src/main.ts`：

```ts
import { name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import type { Handler } from "@likego/web"
import { newNodeServer, port } from "@likego/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ service: "orders", path })
}

const app = newApp(name("orders"), server(newNodeServer(handler, port(3000))), signal())

await app.run()
```

运行：

```sh
bun run src/main.ts
```

需要请求级 Go-style Context 时，使用 `contextHandler((ctx, request) => ...)` 显式桥接。Hono、H3、Elysia
可直接把原生应用交给 `newHonoHandler`、`newH3Handler`、`newElysiaHandler`，再组合任意 Handler Server；
LikeGo 不复制框架 router、middleware 或 codec。

## 内部 Transport

`@likego/transport` 定义与 go-micro 同角色的公共 `Transport`、`Client`、`Listener`、`Socket`、`Message`、
`TransportInfo` 和 options。`TransportInfo` 通过独立的 client/server Context 域暴露 kind、endpoint、operation
及请求/响应 metadata。`endpoint(...)` 可在同一 Message 边界上声明类型化 unary contract；
`@likego/transport/json` 使用标准 Web API 与 Standard Schema 完成 JSON decode 校验，不引入 IDL 或生成代码。
canonical `service/endpoint` 的两段 route token 只能使用 U+0021–U+007E 可见 ASCII，并且禁止 `/`、`*`，
以保证 Client、Server 和 operation middleware 不会把不同路由折叠为同一个名称。
当前提供两个明确 provider：

- `@likego/transport-http` 同时实现真实网络 client/server；portable client 使用标准 `fetch` 执行 HTTP I/O；
- `@likego/transport-memory` 实现进程内 unary `Message` 传输，地址空间归每个 Transport 实例私有持有，不注册
  全局 handler、不回退网络，也不绕过 Discovery、Selector 或 Client middleware。

HTTP provider 的主要入口如下：

- `newHTTPTransport().dial(...)` 创建基于标准 Fetch 的 unary client；
- `@likego/transport-http/node` 的 `newNodeHTTPTransport()` 同时提供 Node listener 与原生 client；Client
  支持 CA/mTLS/SNI，并通过 ALPN 优先使用 HTTP/2、回退 HTTP/1.1；
- `@likego/server` 的 `newServer(transport(...), handler(service, endpoint, fn))` 把 Transport listener、
  内部路由和 Core `Server` 生命周期组合起来；
- 直接使用底层 Transport 时，`listener.accept(...)` 承接内部 `Message` request/response。

```ts
import { background } from "@likego/context"
import { newHTTPTransport } from "@likego/transport-http"

const ctx = background()
const client = await newHTTPTransport().dial(ctx, "http://127.0.0.1:8081/internal")

await client.send(ctx, {
  header: { "Likego-Service": "orders", "Likego-Endpoint": "get" },
  body: new TextEncoder().encode("request")
})
const response = await client.recv(ctx)
await client.close(ctx)
```

`@likego/transport` 只描述内部服务通信，不承接外部 Web Handler。标准 `Request` / `Response` 的外部 HTTP
接入始终归 `@likego/web`；两条边界不通过名称相似的 Fetch transport 混在一起。

## Registry 与配置中心

`@likego/registry` 提供与 Kratos 同角色的 `Registrar`、`Discovery`、`Registry`、`Watcher` 和不可变
`ServiceInstance`。注册和注销直接接收同一个实例快照，watcher 只提供 `next(ctx)` 与 `stop(ctx)`。
`Filter`、`filterVersion(...)` 与 `filterLabel(...)` 也从包根导入，供 Client 在 Selector 之前按声明顺序过滤
完整发现快照。provider 实现辅助只从 `@likego/registry/provider` 导入。第一版包含：

| 包                            | 实现边界                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@likego/registry-consul`     | 标准 Fetch 调用 Consul HTTP API；注册、TTL、passing 发现、catalog、blocking watch 与 generation rollback。                         |
| `@likego/registry-etcd`       | 标准 Fetch 调用 etcd v3 JSON gateway；lease、原子 generation、revision watch、compaction 与 outage reconcile。                     |
| `@likego/registry-kubernetes` | 标准 Fetch 管理 namespaced `discovery.k8s.io/v1` EndpointSlice；最小 RBAC、resourceVersion CAS、watch 410 relist 与 foreign 隔离。 |
| `@likego/registry-mdns`       | portable DNS/TXT codec、cache、registration、watcher；`./node` 承接 UDP multicast host。                                           |
| `@likego/registry-zookeeper`  | 官方 Node client、ephemeral generation、提交后取消回滚、会话重建、one-shot watch 重挂、周期 reconcile 与 ACL。                     |

mDNS 使用 LikeGo 自有 `Likego-` wire namespace，不依赖 Node-only mDNS SDK。Registry 只提供服务发现事实，
不会猜测 HTTP scheme、从 metadata 隐式推导 endpoint，或把不同 provider 的一致性模型伪装成线性一致。
当前 Consul、mDNS、etcd、Kubernetes EndpointSlice 与 ZooKeeper provider 已满足第一版范围，后续不再以追赶
第三方 Registry 数量为目标。

Selector 提供 round-robin、random、显式权重 round-robin、带 in-flight/failure cooldown feedback 的 P2C，
以及对齐 Kratos P2C+EWMA 模型的延迟/健康度选择。EWMA 对 Bun 的真实 Fetch `ConnectionRefused`、
`ECONNRESET` 与历史 `ConnectionClosed` 做标准网络失败分类；不把重试、transport 或请求重放藏进选择算法。

## Config、Store 与消息

- `@likego/config` 管理不可变 last-good 快照和 source watcher。`newConfig(...)` 只接收 `source(...)`、
  `resolver(...)`、`schema(...)`、`onReloadError(...)` 等 functional option；公开对象只有 `load(ctx)`、
  `scan(ctx, schema)`、`value(key)`、`watch(key, observer)` 与 `close(ctx)`，不是 Core `Server`。resolver 在
  source 合并后、schema 与发布前按声明顺序运行；`placeholderResolver()` 只解析当前快照中的显式
  `${dotted.key}` 引用，不读取 ambient env。应用通过 `beforeStart` 加载，通过 `afterStop` 关闭。
  TypeScript 没有 Go 目标对象反射，因此校验和转换使用 Standard Schema。`onReloadError` 只补足
  `load(ctx)` 返回后 watcher 失败的异步错误通道。
- 环境值、文件、YAML、Consul、etcd、Kubernetes ConfigMap/Secret 与 Vault KV v2 都通过显式 Config source
  组合。
  `@likego/config-vault` 使用 metadata version 与真实轮询 watcher；`@likego/config/node` 提供真实 Node
  文件读取、内容哈希 revision 和可跨原子替换继续工作的 parent-directory watcher；portable `./file` 入口
  不直接导入 `node:` builtin。
- `@likego/store` 定义 Context-first `read/write/delete/list`、CAS、TTL、prefix 与稳定分页。
  `@likego/store-memory` 提供实例隔离、无后台 timer 的进程内实现；Consul、etcd 和 Vault 网络 provider
  构造后立即可执行 CRUD，不加入 App 生命周期。只有 `@likego/store-file` 因独占目录锁和快照文件所有权同时
  实现 Store 与 Core `Server`，必须在其 `start/stop` 运行期内读写。
- Vault Store 明确拒绝 TTL/CAS，用精确版本 soft delete 和进程内冻结 snapshot 补足 Vault LIST 没有服务端
  分页快照的边界；File provider 是单 owner 小型本地状态，不冒充多进程数据库。Consul Store 默认只使用
  `likego/store` 物理 root，Registry、Config 和应用自有 KV 均不会被 Store 扫描或解码。
- `@likego/cache` 与 Store 分离，定义 Context-first get/put/delete 与 TTL；当前提供无后台 timer 的
  memory provider，以及使用官方 node-redis client 的 Redis provider。
- `@likego/broker` 定义 bytes/topic publish/subscribe SPI，并保留每条 delivery 的原生对象。
  `Broker.subscribe(...)` 返回带 `topic` 与 `unsubscribe(ctx)` 的 `Subscriber`；`newBrokerServer(...)` 只把
  一次 subscription 的运行期接入 Core `Server`，不拥有借用的 connection、stream 或 durable consumer。
  `@likego/broker-memory` 提供 exact-topic 进程内广播、每订阅 FIFO 与显式排空；`@likego/event` 只增加
  typed codec。`@likego/broker-rabbitmq` 推荐复用 `amqplib@2` 官方 recovery setup，在应用拥有 connection
  的前提下重放活跃 topology、QoS 与 consumer；稳定 broker 的 `ack/nack/reject` 只路由到产生 delivery 的
  channel generation。显式 borrowed-channel 入口保留给完全自行管理恢复的应用。

NATS 生命周期入口可以接收应用直接持有的原生资源，也可以在 `start()` 时通过工厂创建资源；只有工厂创建但尚未
接纳的资源会在启动取消后回滚，直接资源仍归应用。Broker `newBrokerServer(...)` 的 `start()` 表示完整订阅
运行期，`stop()` 调用已接纳 `Subscriber.unsubscribe(ctx)` 并等待真实清理，不伪造底层 connection 已经关闭。

## 内部服务调用

`@likego/client` 是 go-micro 风格的内部 unary `Message` 调用层。配置 Discovery 后，`newClient` 会按服务名
懒加载常驻 watcher 并缓存完整替换快照；首次接纳先建立 watcher，再用一次 fresh get 对齐当前状态，避免
watch/get 竞态。后续空快照同样是权威替换，会使该服务 fail closed；每次 `call` 从当前快照选择端点，再执行
`dial/send/recv` 和 selection feedback。应用不再使用 Client 时调用 `client.close(ctx)` 停止 watcher
并关闭所持连接。
默认空 discovery 快照立即 fail closed；显式加入 `withBlock()` 时，只在该服务历史上首次出现原始 endpoint
之前等待，调用方 Context 仅限制自己的等待。首次就绪后的空快照仍立即 fail closed。
直连 Client 不创建 watcher；LikeGo 不额外引入 `ResidentClient` 或 stream client。portable Fetch 入口的
物理连接复用属于运行时；Node 原生入口在同一次 `transport.dial(...)` 返回的 Client 内复用 HTTP/1
keep-alive connection 或 HTTP/2 session，GOAWAY 后排空旧 stream 并在下一次请求建新 session，
`withConnClose()` 显式旁路复用。高层 `@likego/client` 按 address 保留至多一个空闲 Transport Client；
成功调用可跨次复用，活跃调用不会共享同一 owner，失败 attempt 与多余并发 owner 立即关闭。
idle pool 默认全 Client 最多 100 个 owner、60,000ms 过期；`poolSize(...)` 与 `poolTtl(...)`
可调整边界，其中 `poolSize(0)` 禁用 idle reuse，`poolTtl(0)` 只禁用时间过期。
`client.close(ctx)` 关闭空闲、活跃和迟到连接。

`newClient(...)` 至少使用 `withTransport(...)`；需要服务发现时再组合 `withDiscovery(...)` 与
`withSelector(...)`。每次调用可用 `withAddress(...)` 绕过 Discovery/Selector，或用
`withFilter(filterVersion(...), filterLabel(...))` 过滤实例。
只有显式传入 `withRetry(...)` 才允许重放请求。`closeTimeout(...)` 只限制逻辑 Transport Client 的关闭等待，
不冒充业务超时。`circuitBreakerMiddleware(...)` 按 canonical `service/endpoint` 隔离 breaker，并把显式 retry
的多个 attempt 作为一个逻辑 outcome；open operation 在 Discovery 和 Transport I/O 前拒绝。
`use(selector, ...middleware)` 可按精确 operation、最长尾部 `*` 前缀和 `*` fallback 安装 Client middleware；
类型化调用直接使用 `client.call(ctx, contract, value)`，原始 Message 调用继续保留。
两种调用的 `service`/`endpoint` 都使用同一 route-token 约束：只能使用 U+0021–U+007E 可见 ASCII，
并且禁止 `/`、`*`。

`@likego/server` 提供 go-micro 风格的内部 unary Server：用 `transport(...)` 选择底层传输，
`handler("service", "endpoint", fn)` 以分离身份注册原始 Message 路由，也可用 `handler(contract, fn)` 注册共享
类型化 contract；`listenOption(...)` 原样传递 provider 的 Transport
listen option。`middleware(...)` 安装全局链，`use(selector, ...middleware)` 按精确 operation、最长尾部
`*` 前缀和全局 `*` fallback 选择一条 operation 链；同 selector 后声明覆盖，空链可屏蔽宽规则。
`rateLimitMiddleware(limiter)` 的一个实例共享一个 limiter；需要 operation 隔离时，用 `use(...)` 为不同规则
组合独立 limiter。
`newServer(...)` 创建同时实现 Core `Server` 与 `Endpointer` 的实例；`endpoint(ctx)` 与启动共享同一次 bind，
返回注册端点。`address(...)` 只配置监听地址；wildcard bind、容器端口映射或 Ingress 场景必须通过
`advertise(...)` 显式给出可达 host 或完整端点，host-only 值保留真实绑定端口。应用需要自动注册时，把
Registry 作为 `registrar(...)` 交给 Core App；App 从所有实现 `Endpointer` 的 Server 读取端点，统一注册和注销
`ServiceInstance`。外部 Web 服务仍只使用 `@likego/web`。

## Server 自由组合

任何对象只要实现以下结构，就能由 `@likego/core` 编排：

```ts
interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}
```

因此 Cron、Web framework、broker consumer、日志 sink、telemetry provider、cache warmer 或业务 control loop
都不需要进入 Core。应用可以自行实现 Server，也可以使用以下薄适配包：

| 包                   | 生命周期职责                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `@likego/croner`     | 原生 Croner `Cron` 的启动、停止和可观察终态；表达式、timezone、overlap 仍归 Croner。              |
| `@likego/bullmq`     | 应用创建的原生 Worker 启动、暂停、取消、关闭与终态；Queue、connection、processor 仍归应用。       |
| `@likego/nats`       | 原生 NATS Subscription 与 JetStream ConsumerMessages 的接纳回滚、owner stop、被动退出和真实终态。 |
| `@likego/pino`       | Pino destination 生命周期，以及 Client、unary Server、Web、Broker 的显式请求日志包装。            |
| `@likego/winston`    | Winston Logger 生命周期，以及 Client、unary Server、Web、Broker 的显式请求日志包装。              |
| `@likego/otel`       | 应用配置的 provider shutdown，以及 Client、unary Server、Broker 的显式 W3C trace wrapper。        |
| `@likego/prometheus` | prom-client scrape Handler，以及 Client、unary Server、Web、Broker 的固定低基数请求指标。         |

同一原生资源只能有一个生命周期 owner。`Server.start(ctx)` 可以在启动接纳后返回，也可以持续到运行期结束；
LikeGo Core 接受两种上游常见实现。`Server.stop(ctx)` 请求停止；缺少可靠 force 原语时，适配器必须等待真实终态，
不能伪造资源已经关闭。Core 通过 `Promise.allSettled` 并发停止 child Server 并收集全部结果，不承诺资源依赖顺序；
有顺序要求的资源应由同一个 Server 或显式 App hook 编排。

## Context 语义

`@likego/context` 对齐 Go `context` 的可观察行为，提供：

- `background()`、`todo()`；
- `withCancel()`、`withCancelCause()`；
- `withDeadline()`、`withDeadlineCause()`、`withTimeout()`、`withTimeoutCause()`；
- `cause()`、`withoutCancel()`、`afterFunc()`；
- 值传播、父子取消、稳定 `canceled` / `deadlineExceeded` sentinel。

TypeScript 中 `done()` 返回标准 `AbortSignal`，deadline 使用 `Date`；没有 goroutine 或 channel 的部分按
JavaScript 可观察语义映射。具体差异和边界见 [`@likego/context` 文档](packages/context/README.md)。

`@likego/metadata` 在 Context 上提供大小写归一、不可变的多值 metadata 和显式 set/remove，并严格隔离
client/server 域；公共层不施加属于具体协议的任意数量或字节配额。
Client/Server 使用保留的 `Likego-Metadata` envelope 做 16 KiB 有界、可逆的 wire 映射，Transport provider 只需
无损承载 Message header。`propagateToClientContext(...)` 默认不传播任何 server metadata，只有显式
`exact`/`prefix` allowlist 才会复制到下游 client 域。Core 还会把同一个冻结 `AppInfo` 注入 startup/drain hook 与 child Server
启停 Context，调用方可用 `fromContext(ctx)` 读取；`AppInfo` 包含 id、name、version、metadata 与 endpoints，默认 id
由标准 `crypto.randomUUID()` 生成，也可用 functional option 显式覆盖。

Node.js/Bun 进程信号由显式 `@likego/core/node` 子路径的 `signal()` option 承接。它把 SIGINT、SIGQUIT、
SIGTERM 接入同一个 `app.run()` 生命周期；portable Core 不读取进程全局，也不伪装 Deno 支持。

## 运行时与验证

发布包统一由精确锁定的 `tsdown 0.22.14` 构建。配置从 67 个公开 export 与声明的 CLI bin 自动派生入口，输出 neutral ESM、
DTS、可达共享 chunk、包级 README/LICENSE，以及可直接发布的 `dist/package.json`；工作区依赖保持 external，
公共包的生产依赖在源码 manifest 中就使用对应包的精确版本，构建仍会按发布包清单复核并生成独立 manifest。
LikeGo 不生成 `.min.js`、`unpkg` 或 `jsdelivr` 压缩包。

根级包构建、逐包覆盖率与定向验证统一通过 Bun workspace filter 调度；`./packages/**` 配合
`--if-present` 精确执行 46 个公共包，仓库内部 testing workspace 不参与构建。包名 filter 用于单包或少量
provider。manifest、LCOV、发布 tarball 与 Docker 清理仍由 LikeGo 门禁独立验证，
不与 workspace 任务分发混在一起。

真实打包直接在每个包的 `dist` 目录执行，因此安装后的导出位于包根，而不是再嵌套一层 `dist/`。对 Deno，
declaration-only chunk 会带一个严格的 type companion JS；它只负责把 `.js` 声明引用连接到相邻 `.d.ts`，
不会进入运行时覆盖率分母或暴露新的公共 API。

根包和 46 个公共包从 `0.0.1` 起步；私有 example 与内部 testing 工具只执行源码、类型检查与测试，不声明版本、
不生成 `dist`，也不进入发布图。版本说明由精确锁定的 `@changesets/cli 2.31.1` 管理，Changesets 只修改 46 个
公共包，并使用官方 changelog 生成器写入各包 `CHANGELOG.md`；它不会自动提交。公共包之间的生产依赖使用精确
版本，因此底层包的 patch 可能按依赖图触发其他公共包的 patch，这是刻意保持发布图可安装的策略；仓库不使用
`fixed` 或 `linked` 版本组。

0.0.1 首发是一次性例外：首发实现记录已归档到
[`docs/releases/0.0.1/changesets`](docs/releases/0.0.1/changesets/)，首次发布前不要运行
`bun run version:packages`，完成全部门禁后直接运行 `bun run release`。首发完成后的标准流程是：先用
`bun run changeset` 记录变更，再用 `bun run version:packages` 应用版本并通过
`bun update --filter '*'` 同步 `bun.lock`，审查并提交这些版本文件，最后只运行 `bun run release`。release
会先拒绝 dirty tree 和未被 version 命令消费的 active Changeset，再全新构建、验证 46 个 `dist` 并写入构建印章，
最后调用 Changesets。首发成功后还要运行 `git push --follow-tags`，把 Changesets 创建的 annotated package tags
推送到 origin；PR 门禁据此退出首发豁免。首发后的 PR 修改公共包 `src/**`、`package.json` 或 `LICENSE` 时必须
携带 Changeset，包级测试、README、内部 testing workspace 和私有 example 不触发该门禁。私有 workspace
由独立 Bun workspace 测试与 Docker 门禁验证，不参与 release build。源码包的
`publishConfig.directory` 指向 `dist`，生成后的扁平 `dist/package.json` 只保留 public access；禁止直接运行裸
`changeset publish` 绕过构建和验证门禁。

代码格式唯一使用精确锁定的 `oxfmt 0.60.0`。`bun run fmt` 修改工程源码，`bun run fmt:check` 只读检查；
`dist`、coverage、测试构建、报告、证据、fixture、probe、临时/外部材料以及 Git/IDE 目录不进入格式化范围。

当前固定验证矩阵：

- Bun `1.3.14`；
- Node.js `24.18.0` LTS 与 `26.5.0` current；
- Deno `2.9.4`；
- Docker 真实服务：Consul、etcd、Vault、K3s、ZooKeeper、Redis/BullMQ、NATS/JetStream、
  OpenTelemetry Collector、mDNS multicast、Node 进程信号与 HTTP/streaming 联合链路。

RabbitMQ Broker、Redis Cache、Kubernetes Config、Vault Config 与 Vault Store 由根
`test:providers:docker` 通过五个 Bun package filter 使用包内固定 digest 脚本串行验证，
并作为 `bun run verify` 的发布阻断阶段执行。

```sh
bun install --frozen-lockfile
bun run fmt:check
bun run verify:doc
bun run verify
```

发布门禁会构建 46 个真实 tarball，在 monorepo 外安装后验证 runtime、类型入口和 CLI bin；父 workspace 的 tarball
不得包含嵌套实现 workspace。单元测试中的 fake 只用于确定性状态机，不代替协议、TTL、重连、ack、flush
或 UDP multicast 的真实服务证据。

`.github/workflows/verify.yml` 在 pull request 与 `main` push 上使用固定 Bun/Action commit 执行同一完整
`bun run verify`，并在成功或失败后保留 `.artifacts` 机器证据；局部测试只能用于诊断，不能替代该终态。

VitePress 文档位于 `doc/`，默认英文 SPA，并提供阿拉伯语、西班牙语、法语、俄语、简体中文、香港繁体与
台湾繁体。所有语言 tag 都带 ISO 15924 script subtag；阿拉伯语使用 RTL。运行 `bun run doc:dev` 本地浏览，
运行 `bun run verify:doc` 检查八语言路径一致性、dead links 与生产构建。

## 架构文档

- [包拓扑、Transport 与 Web 边界设计](docs/superpowers/specs/2026-07-19-likego-package-transport-web-design.md)
- [内核公共 API](docs/adr/0001-kernel-public-api.md)
- [构建、运行时与覆盖率](docs/adr/0002-build-runtime-and-coverage.md)
- [常驻集成所有权](docs/adr/0003-resident-adapter-ownership.md)
- [注册中心与选择器](docs/adr/0004-service-registry-and-selection.md)
- [操作级韧性](docs/adr/0005-operation-resilience.md)
- [Store 契约与 Provider 边界](docs/adr/0006-store-contract-and-providers.md)
- [Broker、Event 与原生消息语义](docs/adr/0007-broker-event-native-semantics.md)
- [内部服务声明、分派与自动注册](docs/adr/0008-service-declaration-and-registration.md)
- [Go 工具包能力对比](docs/capability-comparison.md)
- [v1 实现与证据矩阵](docs/v1-evidence-matrix.md)
- [中文仓库文件清单](docs/file-inventory.md)

## 许可证

LikeGo 和每个发布包均采用 [MIT License](LICENSE)。

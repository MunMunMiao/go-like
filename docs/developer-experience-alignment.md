# LikeGo 开发者体验对齐基线

源码核对日期：2026-07-24

## 目标

LikeGo 的公共 API、包导航和 examples 应尽量复用 go-micro、go-kratos 与
go-zlab/go-kratos 已经建立的用户心智。只有 TypeScript、标准 Web API、运行时差异或已经批准的产品边界能够
证明上游形态不可直接采用时，才允许偏离。

禁止仅以“实现更完整”“测试更方便”“将来可能扩展”作为创建新公共概念的理由。

## 精确参考基线

| 项目              | 默认分支精确提交                                                                                                                   | 本项目采用的参考范围                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| go-micro          | [`9d306dcfc1a912a8a9493f31fee0bb983475258d`](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)    | package 能力域、Client、Transport、Registry、Config、Store、Broker 等 SPI |
| go-kratos         | [`668db92c2c001e9552594ba5a8aede8456af6d7e`](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)  | App、Server、生命周期 option、Registrar/Discovery 与 middleware 体验      |
| go-zlab/go-kratos | [`ecd00dd24491d09642c76542f94e392c6d639336`](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336) | 第三方 Web、Cron、队列和消息组件作为 Server 接入 App 的方式               |

go-zlab 当前模块仍依赖 Kratos v2.9.2，因此只参考 adapter 用户体验，不把它当作 Kratos v3 的类型基线。

## 参考优先级

上游之间存在差异时，不同时发布两套 facade：

1. App、Server 和第三方 adapter 生命周期以 go-kratos v3 与 go-zlab 为准。
2. 微服务能力域、包职责和业务 SPI 以 go-micro 为准。
3. 同一概念只能有一条 canonical happy path；高级入口只能暴露同一模型的底层能力。
4. 用户已经明确批准的产品边界优先于上游功能数量。

因此 LikeGo 只提供一套 App 启动模型，也不复制 go-micro 的全局默认实例。与 go-micro 同角色的 Transport 保留
`init/options/string`；内部 Server 保留 `options/string`，Broker 保留 provider 诊断名和每次发布、订阅的原生
option。采用 Kratos 风格契约的 Registry 只承担注册和发现。

## 允许保留的偏离

以下偏离具有明确理由：

- 运行时值使用 TypeScript lower camel case；类型和接口使用 PascalCase。
- Go 的阻塞调用映射为 Promise，公共契约使用结构类型，不要求继承。
- HTTP 数据面使用标准 `Request`、`Response`、`Headers`、Fetch 与 Web Streams。
- provider 独立发布为 npm package，以隔离 peer dependency 与 runtime dependency。
- Registry 的应用契约、Selector 与 `Filter` 位于 `@likego/registry`；provider 作者使用的错误、快照和公共
  constructor option 辅助位于 `@likego/registry/provider`，避免实现细节挤入应用入口。
- 外部 Web 使用 `@likego/web`；内部同步通信使用 `@likego/transport` 与
  `@likego/transport-http`。这些名称和边界已经由用户批准。
- Hono、H3、Elysia 等 package 保持平铺；只有真实解决兼容或生命周期问题时才导出 wrapper。
- Go 通过 `cron.NewServer`、`asynq.NewServer` 的 package selector 保留来源；TypeScript named import 会把多个
  `newServer` 压到同一作用域。会被同一应用并排装配的 adapter 因此保留 `newCronerServer`、
  `newBullMqWorkerServer`、`newBrokerServer` 等描述性工厂名，避免用户在每次 import 时手工 alias；这只是语言
  命名差异，不增加第二套生命周期或产品概念。
- Node/Bun 进程信号没有标准 Web API，因此通过 runtime 子路径提供一个 App signal option；它不能演变成第二套
  App runner 或公共 runtime host SPI。
- JavaScript Promise 不可取消，独立发布的 provider 需要共享“caller 仅放弃等待、资源 owner 继续清理”的
  安全实现，因此保留 provider-facing `@likego/core/lifecycle`；应用 happy path 不需要导入该子路径。
- JavaScript listener 通常异步绑定端口，因此内部 unary Server 的 `endpoint(ctx)` 返回
  `string | PromiseLike<string>`，并与 `start(ctx)` 共享同一次 bind；Transport 专属监听设置通过
  `listenOption(...)` 传递，不进入 Core `Server`。`address(...)` 只负责 bind，`advertise(...)` 在 wildcard、
  容器端口映射或 Ingress 场景显式给出注册端点，不猜测网络拓扑。
- Go 可以把配置反序列化到目标对象，TypeScript interface 在运行时不存在，因此 Config 使用 Standard Schema
  校验和转换。`onReloadError(...)` 只提供 `load(ctx)` 返回后 watcher 失败的异步错误通道，不增加生命周期。
- gRPC、Protobuf、IDL、Event Store、历史 replay、更多 Registry provider 均是已经批准的排除项。

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
| Client   | `newClient(withTransport(...))` 是直连最小构造；需要发现时再组合 `withDiscovery(...)`、`withSelector(...)`，可显式加入 `withBlock()` 等待服务第一次出现原始 endpoint，并在结束时调用 `client.close(ctx)` 停止懒加载 watcher。构造期另有 `middleware(circuitBreakerMiddleware(...))`、`closeTimeout(...)`，每次调用使用 `withAddress(...)`、`withFilter(...)`、`withRetry(...)`。                                                  |
| Registry | 应用从 `@likego/registry` 导入 `Registrar`、`Discovery`、`Registry`、`Watcher`、`ServiceInstance`、`Selector`、`Filter` 与内建 selector/filter；provider 实现从 `@likego/registry/provider` 导入共享辅助。                                                                                                                                                                                                                        |
| Server   | 内部 unary 服务使用 `newServer(transport(...), address(...), advertise(...), handler(service, endpoint, fn), middleware(...), use(selector, ...middleware), listenOption(...))`；`rateLimitMiddleware(limiter)` 可作为全局或 operation middleware。`endpoint(ctx)` 暴露真实注册端点，Core App 使用 `registrar(...)` 统一注册。                                                                                                    |
| Config   | `newConfig(source(...), resolver(...), schema(...), onReloadError(...))` 返回只含 `load(ctx)`、`scan(ctx, schema)`、`value(key)`、`watch(key, observer)`、`close(ctx)` 的 Config。resolver 在 merge 后、schema 与发布前按声明顺序运行；`placeholderResolver()` 只解析当前快照引用。File、Env、Consul、etcd、Vault 与 Kubernetes 都实现同一 `ConfigSource`。App 用 `beforeStart`/`afterStop` 组合 Config，不能传给 `server(...)`。 |
| Store    | Memory、Consul、etcd、Vault provider 构造后立即执行 `read/write/delete/list`；File provider 因独占目录锁和快照文件所有权同时实现 Store 与 `Server`，只在 `start/stop` 运行期内读写。                                                                                                                                                                                                                                              |
| Broker   | Memory、NATS 与 RabbitMQ provider 共用 `publish(...)`、`subscribe(...)`、`Subscriber.unsubscribe(ctx)`；RabbitMQ canonical 入口 `newRecoveringRabbitMqBroker(...)` 复用 `amqplib` recovery setup 重建 package-owned channel、topology 与 consumer，`newRabbitMqBroker(channel)` 只作为明确的 borrowed-channel 入口。`newBrokerServer(...)` 把一次订阅接入 Core 生命周期，但不拥有应用的 connection、stream 或 durable consumer。  |
| Web/框架 | 外部接入保持标准单参数 `Handler`；Hono、H3、Elysia 等薄适配只把原生应用转换为 Handler，不复制 router、middleware 或 codec。                                                                                                                                                                                                                                                                                                       |

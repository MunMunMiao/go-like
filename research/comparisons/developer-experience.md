# Go 框架范式与 TypeScript 适配取舍

研究基线核对日期：2026-09-23。本文保留比较依据与设计理由；当前调用方式见[服务调用指南](../../doc/guide/service-call.md)和各包 README。

## 研究问题

go-like 的公共 API、包导航和 examples 应尽量复用 go-micro、go-kratos 与
go-zlab/go-kratos 已经建立的用户心智。只有 TypeScript、标准 Web API、运行时差异或已经批准的产品边界能够
证明上游形态不可直接采用时，才允许偏离。

研究不以功能数量或假设的未来扩展证明新增公共概念的必要性。

## 精确参考基线

| 项目              | 默认分支精确提交                                                                                                                   | 本项目采用的参考范围                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| go-micro          | [`9d306dcfc1a912a8a9493f31fee0bb983475258d`](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)    | package 能力域、Client、Transport、Registry、Config、Store、Broker 等 SPI |
| go-kratos         | [`668db92c2c001e9552594ba5a8aede8456af6d7e`](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)  | App、Server、生命周期 option、Registrar/Discovery 与 middleware 体验      |
| go-zlab/go-kratos | [`ecd00dd24491d09642c76542f94e392c6d639336`](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336) | 第三方 Web、Cron、队列和消息组件作为 Server 接入 App 的方式               |

上表固定提交中的 go-zlab 模块依赖 Kratos v2.9.2，因此只参考 adapter 用户体验，不把它当作 Kratos v3 的类型基线。

## 采用的参考模型

上游之间存在差异时，不同时发布两套 facade：

1. App、Server 和第三方 adapter 生命周期以 go-kratos v3 与 go-zlab 为准。
2. 微服务能力域、包职责和业务 SPI 以 go-micro 为准。
3. 同一概念只能有一条 canonical happy path；高级入口只能暴露同一模型的底层能力。
4. 用户已经明确批准的产品边界优先于上游功能数量。

因此 go-like 只提供一套 App 启动模型，也不复制 go-micro 的全局默认实例。与 go-micro 同角色的 Transport 保留
`init/options/string`；内部 Server 保留 `options/string`，Broker 保留 provider 诊断名和每次发布、订阅的原生
option。采用 Kratos 风格契约的 Registry 只承担注册和发现。

## TypeScript 与 Web 平台的适配取舍

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
  `@go-like/protoc-gen-like` / `@go-like/transport-grpc-buf` 边界，不改变内部 Fetch JSON 与 SSE Transport。
- Event Store、历史 replay 与更多 Registry provider 仍是已经批准的排除项。

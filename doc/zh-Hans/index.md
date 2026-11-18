# go-like

go-like 是一组给 Bun 和 Node.js 后端服务用的显式 TypeScript 构建块。`@go-like/core` 是零运行时依赖的插座面板：Context、应用生命周期、内部调用、配置、发现、记录、缓存、消息、任务、健康检查，以及观测基座。其余十九个包是插头。插头用应用自己创建的生态客户端填入一个或多个插座。`@go-like/protoc-gen-like` 是构建期 Protobuf 生成器，不依赖 core。

应用仍然是组合根。它构造原生对象，传给插头构造函数，再把结果装到 `newApp` 上。没有服务器、日志器或观测 provider 的全局注册表。

> [!IMPORTANT]
> 此 checkout 是私有的 `0.0.1` workspace。Manifest 版本不能证明 npm 可用。示例使用 workspace 包；除非已独立确认某个已发布版本，否则应在 checkout 中运行。

> [!NOTE]
> 英文 `doc/` 树是这条文档轨道的规范来源。包源码、manifest 和针对性测试才是 API 权威。仓库里存在的测试或 E2E 脚本只表示已声明的覆盖；在命令实际跑过并记录退出状态之前，它不是通过结果。

## 选择路径

| 读者                       | 从这里开始                                 | 然后读                                                                         | 可以继续的时候                                                |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 刚接触 go-like             | [快速开始](/zh-Hans/guide/getting-started) | [架构](/zh-Hans/guide/architecture)、[诊所项目](/zh-Hans/guide/zero-to-one)    | 能启动一个 Web 服务、传入 Context、暴露健康检查并停止它       |
| 有经验的 TypeScript 工程师 | [架构](/zh-Hans/guide/architecture)        | [服务调用](/zh-Hans/guide/service-call)、[工具比较](/zh-Hans/guide/comparison) | 能说出每个资源的所有者、所在层级和终态边界                    |
| Go 或 Kratos 读者          | [快速开始](/zh-Hans/guide/getting-started) | [术语](/reference/terminology)、[服务调用](/zh-Hans/guide/service-call)        | 能对应 Context 和 Server 概念，同时不假设 gRPC 或 Go ABI 兼容 |
| 框架用户                   | [工具比较](/zh-Hans/guide/comparison)      | [迁移与接入](/zh-Hans/guide/migration)、[架构](/zh-Hans/guide/architecture)    | 能保留原生路由器，只加上需要的生命周期或调用边界              |
| 插头作者                   | [插头](/zh-Hans/reference/providers)       | [验证](/zh-Hans/reference/verification)、[声明与证据](/reference/claims)       | 能说明一个插头的插座、runtime、所有权和证据界限               |

## 规范学习路径

`doc/guide/` 下的四页规范路径是逐步推进的：

1. [快速开始](/zh-Hans/guide/getting-started) 跑通一个标准 Fetch Handler、一个 Node 宿主、一个进程信号和一个 App。
2. [诊所预约：从 0 到 1](/zh-Hans/guide/zero-to-one) 把生命周期落成具体领域、内部 unary 调用、缓存、健康检查、测试和停机练习。
3. [工具比较](/zh-Hans/guide/comparison) 说明 go-like 与 NestJS、Fastify、Hono、Elysia、Koa、tRPC、go-micro、go-kratos 的有意差异。
4. [迁移与接入](/zh-Hans/guide/migration) 把迁移前的包映射到 20 个包的布局。

[包参考](/zh-Hans/reference/packages) 是 20 个包、75 个公共入口的清单。[插头](/zh-Hans/reference/providers) 指向每个生态插头的 README。

## 心智模型

三条规则贯穿整个库：

1. **Context 在前。** 每次 I/O 都把 `ctx: Context` 作为第一个参数。Context 携带取消、截止时间、AppInfo、请求 metadata，以及当前观测状态。
2. **显式组合。** 应用构造每一个实现并传进去。插头不会把自己注册成全局对象。
3. **一件事一条路径。** 用 `newBrokerServer` 订阅，用 `newScheduleServer` 调度，用 `JobQueue.worker` 消费队列，用 `newResourceServer` 接入原生资源，用 `readyProbe` 加上 `createHealthHandler` 发布就绪。

```text
应用的 main.ts
  用应用创建的原生对象构造插头
  newTelemetry({...})  newConfig(...)  newServer(...)  newClient(...)
        |
        v
@go-like/core  newApp(...)
  telemetry(tel)     最先接纳，最后排空
  resources(...)     按顺序启动，每个 start 都会等待，按相反顺序停止
  server(...)        一起启动，一起停止
  registrar(r)       在 server 层被接纳之后
  readyProbe(...)    只在启动完成到停止之间就绪
```

读完本站其余页面，五个名词就够了：

- **插座**是 core 声明的结构契约（`Server`、`LogHandler`、`Registry`、`Broker`、`Store`，以及其他）。插头实现插座。它不包裹 core 的调用点。
- **Context** 是可取消工作的显式作用域。
- **Server** 是 `start(ctx)` 和 `stop(ctx)`。在 `resources(...)` 里，`start` 在资源可用时 resolve。在 `server(...)` 里，`start` 可以一直 pending，直到原生对象结束。
- **App** 接纳这些层级、hook、注册和停机。它不是依赖注入容器。
- **Handler** 是标准 Web 函数 `(Request) => Response | Promise<Response>`。Handler 本身不是监听服务器。

对外 Web 和内部服务调用保持分开。生成的 Protobuf RPC 是更后面的可选路径：`@go-like/protoc-gen-like` 生成 ctx 在前的粘合代码，`@go-like/connectrpc` 把 Connect 和 gRPC-Web 适配到 Fetch，`@go-like/connectrpc/node` 托管标准 gRPC。见[流式传输](/zh-Hans/guide/streaming)。

## 应用仍然拥有的部分

当前产品边界把这些留给应用或原生库：

- 路由、框架 middleware、Web Streams 和 WebSocket 升级；
- 业务策略、凭据和授权；
- 原生确认、租约、重试和协议细节；
- OpenTelemetry SDK 的构造、日志器配置和 exporter 选择；
- 持久性、事务，以及内存参考实现跨进程时的任何含义；
- 从 manifest 推断出的 npm 发布、托管 CI 状态或生产就绪声明。

## 公共清单

本 workspace 发布 **20** 个 `@go-like/*` 包，在此 checkout 中版本都是 `0.0.1`，以及 **75** 个公共入口。`@go-like/core` 贡献 41 个入口。其余 34 个入口属于插头和生成器。生成的 `dist/package.json` metadata 导出不是额外的源码 API。

用[包参考](/zh-Hans/reference/packages)选择入口，用[插头](/zh-Hans/reference/providers)打开插头 README。[声明与证据](/reference/claims)记录公开措辞背后的证据级别。

## 验证边界

一次历史仓库契约审计在 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675` 上报告了本地结果：`bun run typecheck`、`bun run test:unit` 和 `bun run fmt:check` 通过。该报告计为 2,736 个单元测试、1,514 个已格式化文件，以及 66 个源码导出入口的导入审计成功。这个计数描述的是迁移前的树。当前清单是 75 个入口。该审计没有确立 `build`、`doc:build`、Docker provider E2E、已发布 tarball 的消费者、npm 发布、托管 CI，或 60 分钟 soak。

在把源码或脚本上的说法变成发布声明之前，先读[验证](/zh-Hans/reference/verification)。

## 下一步

- [快速开始](/zh-Hans/guide/getting-started)：跑通一个 Web handler 和第一个生命周期检查点。
- [架构](/zh-Hans/guide/architecture)：层级、Context 作用域、启停顺序、就绪和预算。
- [诊所预约：从 0 到 1](/zh-Hans/guide/zero-to-one)：一条业务不变量，从 HTTP 到内部策略调用、健康检查和停机。
- [服务调用](/zh-Hans/guide/service-call)：带类型的 Memory Transport，然后是发现、选择和重试。
- [配置、注册中心、存储与缓存](/zh-Hans/guide/config-registry-store)：四份契约，每个生态共用一个客户端。
- [消息、事件与任务](/zh-Hans/guide/broker-events)：字节、codec、时间表和队列。
- [健康与可观测性](/zh-Hans/guide/health-observability)：探针、`newTelemetry`，以及四个观测插头。
- [工具比较](/zh-Hans/guide/comparison)和[迁移与接入](/zh-Hans/guide/migration)：相对其他工具的所有权，以及 import codemod。
- [包参考](/zh-Hans/reference/packages)、[插头](/zh-Hans/reference/providers)、[错误](/reference/errors)、[术语](/reference/terminology)和[验证](/zh-Hans/reference/verification)。

Node 26.12.1 与 Bun 1.4.4 上的托管 gRPC 慢消费者排空记录在[原生 gRPC 排空矩阵](/reference/claims#native-grpc-drain-status)。更早的 Connect 2.1.2 与 Bun 1.4.2 Fetch 取消观察仍留在[声明与证据](/reference/claims#stream-cancellation-limits)。

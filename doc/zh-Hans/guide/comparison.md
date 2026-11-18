# go-like 与其他工具的比较

公平的比较从所有权开始。NestJS、Fastify、Hono、Elysia、Koa 和 tRPC 解决 TypeScript 应用的不同部分。go-micro 和 go-kratos 是 Go 参考，传输和代码生成都不同。go-like 是一块插座面板：显式的生命周期层级、内部调用，以及为你选择的后端准备的插头。

本页的证据标签：

- **Source** 表示当前 checkout 暴露了该 API。
- **Pinned external** 表示已记录的 release、commit 或官方页面。它不是新跑的 benchmark。
- **Declared** 表示存在示例或测试。它不是通过结果。
- **Gap** 表示本仓库没有证明一项兼容性承诺。

这条文档轨道的历史基线是 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`。研究记录里有两个 go-micro commit：`9d306dcfc1a912a8a9493f31fee0bb983475258d`，以及 v6.9.0 备忘录所用的 `3c39d17fadaa9ec21b671be4afef3e63846406e6`。把两者都当作需要复核的输入。

## 在技术栈中的位置

| 工具      | 它通常拥有的部分                                             | go-like 在旁边补上的部分                                          |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| NestJS    | Module、controller、decorator、application context           | 只有自己写那个适配器时，才有一个结构式 `Server`                   |
| Fastify   | 路由、hook、插件、Node 监听器                                | 围绕 Fastify 仍拥有的资源，加一条生命周期或调用边界               |
| Hono      | 路由、middleware、`app.fetch`                                | App 层级、内部调用、插头                                          |
| Elysia    | 路由树、schema、hook、它自己的适配器                         | 同样这些，同时 `.listen()` 仍属于 Elysia                          |
| Koa       | Middleware 和外部路由器                                      | 生命周期和内部调用，而不是另一套路由器                            |
| tRPC      | Procedure、解析器、适配器                                    | 发现、选择和 App 生命周期                                         |
| go-micro  | Go Context、service、registry、broker，以及更宽的 agent 表面 | 只有词汇。没有 Go ABI                                             |
| go-kratos | App 生命周期、HTTP/gRPC、registry、config、Protobuf          | 一份 TypeScript 组合。gRPC 路径是 Connect-ES，不是 Google runtime |
| go-like   | 插座、层级、Fetch 与 SSE 调用、插头                          | 应用仍拥有路由、策略、认证和原生协议细节                          |

## 所有权

| 关注点       | go-like                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| 外部路由     | 框架或应用的 `Handler`                                                                    |
| Web handler  | `(Request) => Response \| Promise<Response>`                                              |
| 进程生命周期 | `newApp`、三个层级、hook                                                                  |
| 依赖         | 构造函数和选项。没有容器                                                                  |
| 内部调用     | `Transport`、`Client`、`Server`、`defineService`、SSE `ServerStream`                      |
| 发现         | `Registry`、`Discovery`、filter、五种 Selector                                            |
| 重试         | 一次尝试，除非 `withRetry` 授权更多                                                       |
| 流           | 边缘是 Web Streams；内部是 JSON 或 SSE；`@go-like/connectrpc/node` 上有四种 gRPC 调用形态 |
| 埋点         | Core 记录工作单元。插头填入观测插座。没有全局注册                                         |

## 生命周期与 Context

```ts
import type { Server } from "@go-like/core/lifecycle"

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

type Lifecycle = Server
void null as unknown as Lifecycle
```

`Server` 是结构式的：`start(ctx)` 和 `stop(ctx)`。在资源层，`start` 在资源可用时 resolve。在 server 层，`start` 可以一直 pending，兄弟的停止并发运行。资源的停止按声明的相反顺序运行。Nest context、Fastify 插件图或 Elysia hook 有自己的顺序。比较所有者，而不是「graceful」这个词。

Context 暴露 `deadline()`、`done()`、`err()` 和 `value(key)`，以及 `background`、`withCancel`、`withTimeout`、`withDeadline`、`withoutCancel` 和 `withValue`。它内部使用 `AbortSignal`。它不是 Go 的 `context.Context`，也不是 gRPC API。

## 调用、重试与流

内部路径是 Client、可选的 Discovery、filter、Selector、transport、`POST /<service>/<endpoint>`，然后是服务端 handler。带类型的 endpoint 用 Struct 校验 JSON。它不是 IDL。`withEndpoint("discovery:///name")` 选择一个服务。直接地址列表不选择。

调用只做一次尝试，除非 `withRetry` 把 `authorization` 设为 `"idempotent"` 或 `"caller-approved"`，并给出正的 `maxAttempts` 和 `shouldRetry`。这份授权是声明。已经收到的响应，不会因为后来的反馈失败而被重放。

```text
Web Handler
  Web Streams、框架 SSE 或 WebSocket

@go-like/core 的 client 与 server
  一个 JSON body，或 stream: true 时的 SSE

@go-like/connectrpc
  Fetch 上的 Connect 与 gRPC-Web unary 和 server-streaming

@go-like/connectrpc/node
  标准 gRPC 的 unary、server-streaming、client-streaming 和 bidi
```

go-micro 的默认重试循环和 go-kratos 的 HTTP 流形态都与版本有关。在发布一份依赖它们的比较之前，复核已固定的 commit。

## Runtime

共享入口使用 Fetch 和 `AbortSignal`，或一份注入的能力。自定义 TLS、HTTP/2 和 mTLS 位于 `@go-like/core/transport/http/node` 和 `@go-like/connectrpc/node`。Hono、Elysia、H3 和普通 Fetch 示例把 Fetch handler 传给 core 宿主。本仓库没有 NestJS 或 Fastify 桥。Manifest 版本 `0.0.1` 不能证明 npm 发布。

## 按工具

**NestJS。** Module、provider 和 controller 仍属于 Nest。集成是应用拥有的、包住 Nest 应用的 `Server`，带有显式的接纳和关闭。本仓库不包含那个适配器。

**Fastify。** 路由、封装和监听器仍属于 Fastify。go-like 不会把 `request` / `reply` 转成 Fetch `Handler`。

**Hono。** `examples/hono` 把 `app.fetch` 传给 `newNodeServer`，并把该宿主放进 `server(...)`。路由留在 Hono。

**Elysia。** 保留路由树和 Bun 专属行为。示例把 Fetch handler 和 Node 宿主一起使用。`.listen()` 不是 go-like API。

**Koa。** 保留 middleware 和外部路由器。只在能说出所有者的地方加上生命周期或调用边界。

**tRPC。** Procedure 仍属于 tRPC。go-like 的 endpoint 是 JSON Fetch 上的 Struct，不是 procedure 路由器。

**go-micro 与 go-kratos。** 它们是 Context 在前的调用、生命周期和发现词汇的参考。go-like 里的 watcher 产出完整替换快照。托管的 gRPC 入口是 `@go-like/connectrpc/node`。

## 选什么

使用真正拥有你手头问题的那个框架。缺的是接纳、取消、发现，或一份有明确所有者的后端契约时，再加一个 go-like 插座。把每个插头都装进一个已经完成的框架应用，就去掉了小契约的好处。

## 证据锚点

当前树：

- `packages/core/src/app/app.ts` 和 `packages/core/src/app/tiers.ts`：层级、预算和停止顺序；
- `packages/core/src/lifecycle/index.ts`：`Server` 和 `Endpointer`；
- `packages/core/src/web/context.ts`：`Handler` 和 `contextHandler`；
- `packages/core/src/client/index.ts`：调用选项、发现和重试；
- `packages/core/src/server/index.ts`：内部分发；
- `packages/core/src/transport/service.ts`：`defineService`；
- `packages/core/src/registry/selector.ts`：filter、Selector 和反馈；
- `packages/connectrpc/src/node.ts`：托管 gRPC。

已固定的外部输入，本次文档修改没有重新验证：

- [go-micro 比较 commit](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)；
- [go-micro v6.9.0 commit](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6)；
- [go-kratos v3 commit](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)；
- [go-zlab/go-kratos commit](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336)；
- [NestJS 生命周期](https://docs.nestjs.com/fundamentals/lifecycle-events)、[Fastify server](https://fastify.dev/docs/latest/Reference/Server/)、[Hono](https://hono.dev/docs/api/hono)、[Elysia 生命周期](https://elysiajs.com/essential/life-cycle)、[Koa](https://koajs.com/)、[tRPC 路由器](https://trpc.io/docs/server/routers)。

为比较而记录的第三方 TypeScript 版本，不是兼容性承诺：NestJS `@nestjs/core@11.1.28`、Fastify `5.11.2`、Hono `4.12.34`、Elysia `1.4.29`、Koa `3.2.1`、tRPC `@trpc/server@11.18.0`。Elysia 示例的 manifest 是该示例的固定版本；这张表是研究快照。

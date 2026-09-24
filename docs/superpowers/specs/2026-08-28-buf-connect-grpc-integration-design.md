# go-like Buf、Connect 与 gRPC 集成边界

> **历史记录，已被取代：** 本文保留 2026-08-28 的设计演进，不再代表当前公开 API。package 位置、Client 构造期寻址、共享 Selector 路径、启动前 Handler 注册与标准 gRPC owner 以 [2026-08-30 HTTP/gRPC transport 对齐设计](./2026-08-30-http-grpc-transport-alignment-design.md) 和 [对应实施计划](../plans/2026-08-30-http-grpc-transport-alignment.md) 为准；下方正文仅供追溯当时决策。

日期：2026-08-28

状态：设计已确认，尚未实施

范围：定义 go-like 作为框架提供方对 Buf 本地工具链、Protobuf-ES、Connect-ES portable runtime 与 client connection 资源所有权的集成边界。本文不授权实现、提交、推送、发布或部署。

> 2026-08-28 修订：代码生成和 portable 实施以 [protoc-gen-like 与 portable RPC 胶水设计](./2026-08-28-protoc-gen-like-design.md) 为准。旧稿中的 package 名、Google/Buf runtime 混合边界，以及未经单独设计便预定义 native HTTP/2 与 Discovery API 的结论已经撤销；使用 Buf/Connect runtime 达成真 gRPC 的目标没有撤销。
>
> 2026-08-28 连接修订：生成的 `newXClient(transport)` 继续只借用 Connect-ES `Transport`；框架另行提供长生命周期 client connection owner，统一负责连接复用、mTLS 配置与关闭。Node、Bun、Deno 必须保持同一 package root 和公共开发者 API，runtime 差异只允许留在内部实现。该 owner 不属于当前 portable 第一阶段实施计划，具体命名与 options 仍须在实现前冻结。

## 1. 结论

go-like 集成 Buf/Connect 的方式与 Kratos 集成 grpc-go 的原则一致：框架补自己的胶水与生命周期，成熟 runtime 持有 codec、protocol handler、client 和 stream state machine。go-like 不重写 Protobuf 或 RPC wire。

新增包固定为：

```text
packages/protoc-gen-like
@go-like/protoc-gen-like

packages/grpc-buf
@go-like/grpc-buf
```

职责固定为：

- Buf CLI 只编排本地 `.proto` lint 与 generation；
- `protoc-gen-es` 生成 messages、schemas 与 service descriptors；
- `protoc-gen-like` 生成 ctx-first Handler、注册函数、ctx-first Client 与 client factory；
- Connect-ES / Protobuf-ES 执行实际 router、client、codec、Connect wire、gRPC-Web wire 与 streaming；
- `@go-like/grpc-buf` 第一阶段提供 Like Context/Metadata bridge 和 portable Fetch handler，后续在同一根入口提供长生命周期 client connection owner；
- Buf Schema Registry、Buf Cloud、remote plugin、托管生成与在线服务不进入范围。

`grpc-buf` 中的 `buf` 是 runtime/vendor qualifier，不是协议归属声明。不发布 `/node`、`/web`、`/client` 这类 runtime-specific 公共子路径，也不实现现有 `@go-like/transport.Transport`。当前 portable 第一阶段不实现 client connection owner、native server、direct transport、Discovery 或 Google runtime API；其中 connection owner 已确认属于 `@go-like/grpc-buf` 的后续阶段，其余能力仍需各自设计。

## 2. Runtime vendor 与 wire protocol

必须分开两个维度：

| 维度           | 值                                     | 本项目的含义                                                      |
| -------------- | -------------------------------------- | ----------------------------------------------------------------- |
| runtime/vendor | Buf/Connect、Google `@grpc/grpc-js` 等 | 谁提供 client/server、protocol handler、connection 和 stream 实现 |
| wire protocol  | 标准 gRPC、gRPC-Web、Connect           | 网络上的 content type、path、framing、status 与 trailers 规则     |

Buf/Connect runtime 不只会说 Connect wire。Connect-ES 2.1.2 的 router 明确拥有 [gRPC、gRPC-Web 与 Connect 三套 protocol handler](https://github.com/connectrpc/connect-es/blob/104238c58152e324ac16a99563f5eeea8ae7136d/packages/connect/src/router.ts#L77-L120)，并为 gRPC-Web 设置独立的 `protocolName = "grpc-web"` 与 handler factory。[Connect-ES gRPC-Web handler](https://github.com/connectrpc/connect-es/blob/104238c58152e324ac16a99563f5eeea8ae7136d/packages/connect/src/protocol-grpc-web/handler-factory.ts#L72-L98)

因此：

- “使用 Buf runtime”不能推导出 wire 一定是 Connect；
- “wire 是 gRPC-Web”不能推导出实现一定来自 gRPC 项目官方 `grpc-web` npm package；
- “本轮 portable contract 不提供标准 gRPC”是 go-like 的实施范围，不是 Connect-ES 没有标准 gRPC 实现，也不撤销已确认的 Buf 真 gRPC 目标。

## 3. gRPC-Web 的定义与当前实现

gRPC-Web 起源于 Google 的 gRPC-Web 工作，当前由 gRPC 开源项目维护。规范位于 core gRPC 仓库，不属于 Buf：[gRPC `PROTOCOL-WEB.md`](https://github.com/grpc/grpc/blob/58ea2e00fcc2502c06115f5d57c864c828826243/doc/PROTOCOL-WEB.md#L1-L34)。

该规范定义了至少这些可互操作行为：

- `application/grpc-web` / `application/grpc-web-text` content type；
- 不依赖 HTTP/2 独有 framing；
- response status/trailers 编码进 response body 的最后一个 length-prefixed frame；
- frame 首字节最高位标识 trailer；
- text 模式使用 base64。[wire differences](https://github.com/grpc/grpc/blob/58ea2e00fcc2502c06115f5d57c864c828826243/doc/PROTOCOL-WEB.md#L34-L106)

当前项目不使用 gRPC 项目官方 `grpc-web` npm runtime。实际实现来自 Connect-ES 2.1.2：

- server 使用 `@connectrpc/connect` 的 gRPC-Web handler 解析请求、执行共享的 MethodImpl，并把 gRPC status/trailers 写为 body trailer frame；
- browser/Web API client 使用 `@connectrpc/connect-web` 的 `createGrpcWebTransport()` 与 Fetch；[client implementation](https://github.com/connectrpc/connect-es/blob/104238c58152e324ac16a99563f5eeea8ae7136d/packages/connect-web/src/grpc-web-transport.ts#L117-L240)
- Connect-ES 2.1.2 不实现 `grpc-web-text`，所以本项目也不得宣称支持 base64 text mode。[explicit limitation](https://github.com/connectrpc/connect-es/blob/104238c58152e324ac16a99563f5eeea8ae7136d/packages/connect-web/src/grpc-web-transport.ts#L117-L126)

这是一份由 Buf/Connect runtime 提供、遵循 gRPC 项目规范的 gRPC-Web 实现；不是 Buf 定义新协议，也不是把 Connect wire 冒充 gRPC-Web。

## 4. 为什么 Kratos 能“复用 transport”

这里的 `transport` 同名但分层不同。

Kratos 公共 `transport` 只定义：

- `Server.Start/Stop`；
- `Endpointer.Endpoint`；
- Context 中的 `Transporter` 观测接口。

Kratos 的 gRPC server 直接嵌入 grpc-go `*grpc.Server`，client 直接返回 `*grpc.ClientConn`。它们没有实现一套公共 `dial/listen/Message/Socket` SPI。[Kratos common transport](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/transport.go#L16-L58)、[Kratos gRPC server](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/grpc/server.go#L123-L192)

go-like 当前 `@go-like/transport.Transport` 则是 go-micro 风格的具体 unary service transport SPI：`dial/listen`、`Socket.send/recv` 与单个二进制 `Message`。现有 `@go-like/server` 和 `@go-like/client` 都按一次 recv、一次 handler、一次 send 工作。它不能无损表达 request stream、response stream、half-close、initial metadata 与 trailers。

所以结论不是“Kratos 可以复用，go-like 架构坏了”，而是：

- Kratos 复用的是浅层生命周期与 Context contract；
- go-like 现有 `Transport` 对自己的 Struct unary consumer 是有效设计，但名字比实际能力更宽；
- 新 RPC 可以复用 Like Context、Metadata、`TransportInfo`、Core Server/Endpointer 和 Web host，不能冒充旧 `Transport` implementation；
- 本轮不重命名或重构旧 SPI。没有当前 consumer 要求一套新的 universal RPC Transport abstraction。

这也是新包从 `packages/transport/grpc` 移到 `packages/grpc-buf` 的原因：目录表达 Buf runtime integration，而不是声称满足旧 unary Transport SPI。

## 5. 开发者 Handler 与 Client

Canonical API 由薄生成器产生；开发者不直接操作 raw router ABI：

```ts
export interface OrderServiceHandler {
  getOrder(
    ctx: Context,
    req: GetOrderRequest
  ): MessageInitShape<typeof OrderSchema> | Promise<MessageInitShape<typeof OrderSchema>>
  watchOrders(
    ctx: Context,
    req: WatchOrdersRequest
  ): AsyncIterable<MessageInitShape<typeof OrderEventSchema>>
  uploadEvents(
    ctx: Context,
    req: AsyncIterable<UploadEvent>
  ): Promise<MessageInitShape<typeof UploadSummarySchema>>
  syncOrders(
    ctx: Context,
    req: AsyncIterable<OrderCommand>
  ): AsyncIterable<MessageInitShape<typeof OrderEventSchema>>
}

export function registerOrderServiceHandler(
  router: ConnectRouter,
  handler: OrderServiceHandler
): void
```

Client factory 接受 upstream Connect-ES `Transport`，但生成代码必须别名为 `ConnectTransport`，避免与 Like `Transport` 混淆：

```ts
import type { Transport as ConnectTransport } from "@connectrpc/connect"

export function newOrderServiceClient(transport: ConnectTransport): OrderServiceClient
```

本阶段只验证 `createConnectTransport()`、`createGrpcWebTransport()` 与测试用 `createRouterTransport()`。生成器不选择 wire、不创建连接，也不拥有 `close()`：同一个长生命周期 owner 暴露的 `ConnectTransport` 可以被多个生成 client 共享，只有 owner 可以结束底层资源。

## 6. `@go-like/grpc-buf` 第一阶段公共 API

portable 第一阶段的根入口只拥有：

```ts
export type Routes = (router: ConnectRouter) => void

export function newHandler(routes: Routes): (request: Request) => Promise<Response>

export function fromHandlerContext(context: HandlerContext): Context

export function callOptions(ctx: Context, options?: CallOptions): CallOptions
```

`newHandler()`：

1. 创建 `createConnectRouter({ connect: true, grpcWeb: true, grpc: false })`；
2. 调用一次 `routes(router)`；
3. 用 Connect-ES 公开的 `createFetchHandler()` 包装实际 protocol handlers；
4. 按 pathname 分派标准 `Request`，未匹配返回 `404`；
5. codec、compression、framing、errors 与 stream state 继续归 Connect-ES。

它可交给 Bun、Deno、Edge/Serverless Fetch host，或现有 `@go-like/web/node`。`newHandler()` 本身不拥有 listener，也不实现 Core Server；当现有 Web host 托管它时，由 Web host 实现 bind、Endpoint、Start 与 Stop。

portable 能力只承诺：

- Connect unary 与 server streaming；
- gRPC-Web unary 与 server streaming；
- 标准 Fetch Request/Response、取消与 metadata bridge。

request streaming、bidi、native HTTP/2 trailers 与 `grpc-web-text` 均不在承诺内。

## 7. Client connection owner、连接复用与 mTLS

最终 client contract 已确认以下不变量：

- 框架提供一个长生命周期 connection owner，并从它暴露 Connect-ES `Transport`；生成的 `newXClient(transport)` 不增加 runtime 分支；
- 同一 authority 与同一 TLS identity 的多个生成 client 共享该 owner，连接池、HTTP/2 session、多路复用、keepalive 与 GOAWAY 处理继续由选定的 upstream/runtime executor 实现；
- owner 的 `close()` 必须幂等且终止其生命周期；关闭后任何 unary 或 streaming 调用都必须明确失败，不能由 upstream session manager 静默重连而“复活”；
- mTLS 复用现有 `@go-like/transport` 的 `TLSConfig` 语义：CA、client certificate chain、private key 与 server name 在创建 owner 时一次配置，不能由每个生成 client 或每次 RPC 重复持有；
- Node、Bun、Deno 使用同一个 `@go-like/grpc-buf` package root 和相同公共签名。条件导出或 runtime adapter 只能是内部实现手段，不得形成公开的 `/node`、`/bun`、`/deno` 分叉；
- 浏览器仍可通过 Connect/gRPC-Web 与标准 Fetch 调用，但 Web 页面不能直接注入 PEM client key；浏览器 mTLS 由浏览器、操作系统或前置代理管理，不能伪装成与服务端 runtime 相同的可编程 TLS API。

默认 Fetch 是否已经复用连接由具体 runtime 决定。需要可控 session、mTLS 或显式关闭时，owner 必须持有 runtime 的可关闭 executor/session，而不是让生成代码接触 `node:http2`、Bun TLS 或 Deno `HttpClient`。现有 `@go-like/transport/http` 的 owned executor 与 `close()` 是可复用的生命周期模式，但 Connect streaming 不能被降级成旧 unary `Socket.send/recv` 接口。

本节冻结所有权与可移植性边界，不冻结 owner 的名称、constructor options、默认 wire 或 Discovery target 语法。它们必须由单独的小型设计和真实 Node/Bun/Deno 测试确定，不能从本文件猜出公共 API。

## 8. Context、Metadata 与 TransportInfo

`fromHandlerContext(rpc)` 必须如实桥接：

- `done()` 直接使用 `rpc.signal`；
- deadline 从 `rpc.timeoutMs()` 捕获；
- request headers 写入 Like server metadata；
- `TransportInfo.kind()` 返回实际 `rpc.protocolName`，当前只能是 `connect` 或 `grpc-web`；
- `TransportInfo.endpoint()` 返回 `new URL(rpc.url).origin`；
- `TransportInfo.operation()` 返回 `/${rpc.service.typeName}/${rpc.method.name}`；
- response header 从 `rpc.responseHeader` 当前值读取，不把 trailer 混进单一 reply-header facade。

完整 request URL 不能同时充当 endpoint 与 operation；把 kind 固定写成 `grpc` 也会让 Connect 和 gRPC-Web 请求产生虚假 observability 数据。

`callOptions(ctx, overrides?)` 只映射 client metadata、signal、deadline，并保留 upstream `onHeader`、`onTrailer` 与 `contextValues`。首版不增加第二套 interceptor 或 middleware ABI。

## 9. Buf 工具链边界

框架仓库可以保留 private fixture 的 `.proto`、`buf.yaml` 与 `buf.gen.yaml`，用于生成一致性与 runtime 测试。这些不是 `@go-like/grpc-buf` 的运行配置，也不是要求业务复制的框架配置。

应用拥有自己的 schema 与生成配置。框架 runtime 不依赖 Buf CLI 或 `protoc-gen-es`。

`@go-like/protoc-gen-like` 作为 project-local npm devDependency 提供 `protoc-gen-like` executable。仓库内部使用 Bun 构建，但发布产物固定以 `--target=node --format=cjs` 编译，并保留 `#!/usr/bin/env node`；它与 [`@bufbuild/protoc-gen-es` 2.14.0](https://github.com/bufbuild/protobuf-es/blob/v2.14.0/packages/protoc-gen-es/package.json) 一致要求 Node 22 或更高版本，消费者不需要安装 Bun。npm、pnpm 或 Yarn 的 package script 把依赖提供的 executable 放入 `PATH`，[Buf local plugin](https://buf.build/docs/reference/cli/buf/generate/) 再按名称查找；应用的 `buf.gen.yaml` 只写 `local: protoc-gen-like`，不得写 `bun ...` 或硬编码 `node_modules/.bin`。

Node 只属于本地/CI code-generation toolchain，不改变生成产物和 `@go-like/grpc-buf` 的 Bun、Node、Deno、browser runtime 边界。没有 Node 的 Deno-only 环境首版不承诺本地生成；它可以在 Node CI 中生成并提交产物。本阶段不为此增加 Deno launcher、Bun standalone executable、多平台原生包或 Buf remote plugin。

明确不集成：

- Buf Schema Registry、Buf Cloud、Studio；
- remote module、remote plugin、在线 lint/breaking；
- 托管生成、schema 发布与组织管理；
- Struct 与 Protobuf 自动转换；
- 自制 codec、compression、framing、trailers 或 stream state machine。

## 10. 真 gRPC 与当前实施边界

用户提供的 `/tmp/likego-buf-es-runtime.K7Pf2F/REPORT.md` 记录了固定版本互通实验：`@connectrpc/connect-node` 2.1.2 在 Node 26.7、Bun 1.4、Deno 2.9.5 上以 h2c 与 TLS/ALPN 完成标准 gRPC 的 unary、server-streaming、client-streaming、bidi，独立 `buf curl --protocol grpc` 也调用成功。它证明 Buf/Connect runtime 能实现标准“真 gRPC”；Bun 与 Deno 是版本锁定的实测兼容，不能写成 Connect-ES 的长期官方支持。

因此，使用 `@connectrpc/connect-node` 的标准 gRPC 实现仍归 `@go-like/grpc-buf`。使用 Google-origin gRPC 项目的 `@grpc/grpc-js` 时，才独立设计 `packages/grpc-google` 与 `@go-like/grpc-google`。wire protocol 相同不构成混用两个 runtime vendor 的理由。

当前 portable 第一阶段不实现或占位导出：

- `newServer()`、`newTransport()`、native h2c/TLS host；
- `grpc://`、`grpcs://`、`discovery:///` target；
- client connection owner、HTTP/2 session manager、Registry watcher、Selector feedback；
- Google `@grpc/grpc-js` adapter；
- health、reflection、canonical error details、validation、retry 或 hedging。

真 gRPC 与 client connection owner 都是已确认目标，但其 Buf runtime server API、owner 的精确公共签名与 Discovery contract 必须由独立设计和计划决定，不能从 portable API 猜测。用户提供的实验报告只验证了 h2c 与 TLS/ALPN，没有验证 mTLS；在 Node、Bun、Deno 分别完成 client certificate、复用与关闭测试前，不得宣称跨 runtime mTLS 支持。当前仓库不得创建 Google package 目录、dependency、export 或 placeholder。

## 11. 验证要求

正式实现必须留下：

1. generator unit test 覆盖四种 cardinality、安全标识符和多个 service；
2. local `buf lint` / `buf generate` 同时运行 `protoc-gen-es` 与 `protoc-gen-like`；published package 的 `bin` 指向存在且可执行的 Node CJS 文件，保留 Node shebang，并由 Node 22+ 通过项目级 package script 被 Buf 实际调用；
3. generated output 独立 typecheck，并以负类型用例证明 proto `string` 不能传 number；
4. `createRouterTransport()` 证明生成的注册函数和 client factory 调到同一 Handler；
5. Fetch `Request/Response` 真实覆盖 Connect 与 gRPC-Web unary/server-streaming、404 和取消；
6. Bun、Node、Deno 从构建 package 运行 portable fixture；
7. 现有 `@go-like/web/node` 托管 `newHandler(routes)`，由 Core App 完成真实 bind、endpoint 收集、start/stop；
8. `TransportInfo` 测试分别证明 `connect` / `grpc-web` kind、origin endpoint 与 canonical operation；
9. browser bundle gate 证明没有 Node builtin、`@connectrpc/connect-node` 或 `@grpc/grpc-js`；
10. 所有 Buf fixture 只使用 local module/plugin，不访问在线服务。

后续 connection-owner 阶段还必须独立证明：多个生成 client 共享同一 owner；每个 runtime 的连接复用行为；幂等且不可复活的关闭；Node、Bun、Deno 的真实 mTLS 握手；浏览器对可编程 client certificate 的明确拒绝或不暴露。以上门禁不是当前 portable 第一阶段完成声明的一部分。

## 12. 完成标准

只有同时满足以下条件，portable Buf 集成才可宣称完成：

1. 同一 descriptor 生成 ctx-first Handler、register、ctx-first Client 与 client factory；
2. Connect-ES / Protobuf-ES 持有真实 codec、protocol 与 stream；
3. package 名、文档与 `TransportInfo` 都不混淆 vendor 和 wire；
4. Connect 与 gRPC-Web 的已承诺 cardinality 在 Bun、Node、Deno 上有刚运行的证据；
5. 现有 Web host/Core lifecycle 组合验证通过；
6. runtime package 没有 Buf online service、native host、Google runtime 或旧 Like Transport SPI 占位；
7. 未验证的浏览器、Edge、portable request streaming/bidi 或跨 runtime mTLS 没有被写成支持；实验报告中的标准 gRPC 证据只作为独立实施阶段的输入，不冒充当前 package 已交付；
8. 文档明确区分生成 client、借用的 Connect `Transport` 与拥有底层资源的 connection owner，不让每个 service client 自行建连或关闭。

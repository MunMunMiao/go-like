# protoc-gen-like 与 portable RPC 胶水设计

> **历史记录，已被取代：** 本文保留 2026-08-28 portable 第一阶段的设计上下文，不再代表当前公开 API。package 位置、Client 构造期寻址、共享 Selector 路径、启动前 Handler 注册与标准 gRPC owner 以 [2026-08-30 HTTP/gRPC transport 对齐设计](./2026-08-30-http-grpc-transport-alignment-design.md) 和 [对应实施计划](../plans/2026-08-30-http-grpc-transport-alignment.md) 为准；不要从下方历史正文复制当前签名。

日期：2026-08-28

状态：设计已确认，尚未实施

范围：定义薄 `protoc-gen-like`、生成的 ctx-first Handler/Client 胶水，以及由 Buf/Connect runtime 提供的 portable Fetch RPC 入口。本文不实施 native HTTP/2 host、client connection owner、Discovery 或 Google `@grpc/grpc-js` 集成，但固定生成 client 与后续 owner 之间的借用关系。

## 1. 结论

go-like 增加自己的 RPC 胶水生成器，但不实现 Protobuf 编译器、message generator、codec、Connect/gRPC server、Connect/gRPC client、HTTP/2 framing、trailers 或 stream state machine。

职责固定为：

- Buf CLI 编排本地 `.proto` lint 与 code generation；
- `protoc-gen-es` 生成 messages、schemas 与 service descriptors；
- `protoc-gen-like` 读取同一 descriptor，生成 go-like 风格的 ctx-first Handler、注册函数、ctx-first Client 与 client factory；
- Connect-ES 继续执行真正的 router、client、protocol、codec 与 streaming；
- `@go-like/grpc-buf` 第一阶段提供 Like Context/Metadata 桥接和 portable Fetch handler；
- Buf Schema Registry、Buf Cloud、remote plugin、托管生成与在线服务不进入范围。

这个边界对应 `protoc-gen-go` + `protoc-gen-go-grpc`、`protoc-gen-go` + `protoc-gen-micro` 的职责拆分：message generator 与 RPC glue generator 是两个工具，底层协议仍由成熟 runtime 执行。

包名中的 `buf` 标识本包集成的 runtime vendor，不是 wire protocol 名。标准 gRPC、gRPC-Web 与 Connect 是三种不同 wire；Connect-ES 对三者都有独立 protocol handler。本轮只承诺 portable Fetch 可实际提供的 Connect 与 gRPC-Web，不因 Connect-ES 具备标准 gRPC handler 就预留尚未设计的 native API。已确认的“真 gRPC”目标若继续使用 Buf/Connect runtime，仍属于 `@go-like/grpc-buf`；若未来明确采用 Google `@grpc/grpc-js`，则另行设计 `@go-like/grpc-google`，不得在本包中兼容或占位。

gRPC-Web 不是 Buf 定义的协议。它起源于 Google 的 gRPC-Web 工作，当前 wire delta 由 gRPC 开源项目维护在 [`grpc/grpc` 的 `PROTOCOL-WEB.md`](https://github.com/grpc/grpc/blob/58ea2e00fcc2502c06115f5d57c864c828826243/doc/PROTOCOL-WEB.md#L34-L106)：`application/grpc-web` content type、body 内 trailer frame 与 status 等 wire 行为属于协议，任何实现都必须互通。当前项目不使用 gRPC 项目官方 `grpc-web` npm runtime；它使用 Connect-ES 2.1.2 自己的 [gRPC-Web server handler](https://github.com/connectrpc/connect-es/blob/104238c58152e324ac16a99563f5eeea8ae7136d/packages/connect/src/protocol-grpc-web/handler-factory.ts#L72-L98) 与 [`@connectrpc/connect-web` Fetch client](https://github.com/connectrpc/connect-es/blob/104238c58152e324ac16a99563f5eeea8ae7136d/packages/connect-web/src/grpc-web-transport.ts#L117-L240)。这是一份由 Buf/Connect runtime 提供的 gRPC-Web wire 实现，不是 Connect wire 冒充 gRPC-Web。

## 2. 包边界

新增两个 public root package：

```text
packages/protoc-gen-like
@go-like/protoc-gen-like

packages/grpc-buf
@go-like/grpc-buf
```

`@go-like/protoc-gen-like` 是构建期工具：

- npm package 提供 `protoc-gen-like` binary；
- binary 仿照 [`@bufbuild/protoc-gen-es` 2.14.0 executable](https://github.com/bufbuild/protobuf-es/blob/v2.14.0/packages/protoc-gen-es/bin/protoc-gen-es)，由仓库内 Bun 构建为 `--target=node --format=cjs` 的 JavaScript，并保留 `#!/usr/bin/env node`；package 声明 `engines.node >= 22`，消费者不需要 Bun；
- 根入口只导出可测试的 plugin definition；
- production dependency 只包含运行 plugin 所需的 `@bufbuild/protoplugin`；
- 不依赖 Buf CLI、`protoc-gen-es`、Connect server/client 或任意 Buf 在线服务。

`@go-like/grpc-buf` 是 runtime package：

- 第一阶段根入口只导出 `Routes`、`newHandler()`、`fromHandlerContext()` 与 `callOptions()`；
- 不发布 `/node`、`/web`、`/client` 子路径；
- 不重导出整套 Connect/Protobuf API；
- 不实现或占位导出 `newServer()`、`newTransport()`、Discovery options、native gRPC options 或 Google runtime adapter；
- 不实现现有 `@go-like/transport.Transport`。该接口拥有 dial/listen、单 Message send/recv 的 unary 语义，而本包直接使用 Connect-ES 的 RPC `Transport` 与 Fetch handler contract。

后续 client connection owner 仍放在同一个 package root，并在 Node、Bun、Deno 保持相同公共签名；不得为 runtime 差异增加公开 `/node`、`/bun` 或 `/deno` 子路径。当前第一阶段的精确 export 清单是阶段门禁，不是永久禁止根入口增加已经单独设计和验证的 owner。

完成这两个 root package 后，source package inventory 从 43 增加到 45；因为都只发布根入口，23 个 public source subpath 不变。

## 3. 本地生成流水线

应用把三个构建期工具安装为 project-local devDependencies：

```sh
npm install --save-dev \
  @bufbuild/buf@1.72.0 \
  @bufbuild/protoc-gen-es@2.14.0 \
  @go-like/protoc-gen-like
```

`package.json` 通过 package script 启动 Buf，使 npm、pnpm 或 Yarn 自动把依赖提供的 executables 加入 `PATH`：

```json
{
  "scripts": {
    "proto:generate": "buf generate"
  }
}
```

应用自己的 `buf.gen.yaml` 使用两个 local plugin：

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: gen
    opt:
      - target=ts
  - local: protoc-gen-like
    out: gen
    opt:
      - target=ts
```

流水线为：

```text
.proto
  ├─ protoc-gen-es      -> *_pb.ts
  └─ protoc-gen-like  -> *_like.ts
```

应用执行 `npm run proto:generate`，或使用对应 package manager 的同名 script。Buf 只通过 `local: protoc-gen-es` / `local: protoc-gen-like` 从 `PATH` 查找 executable；配置不得写 `bun ...` 或硬编码 `node_modules/.bin`，以免破坏 npm、pnpm、Yarn PnP 与 Windows 的 package-manager shim。

应用拥有自己的 `.proto`、`buf.yaml`、`buf.gen.yaml` 与生成目录。框架仓库只保留 private test fixture；fixture 配置不是要求业务复制的框架配置。Node 22+ 只是本地/CI 生成工具要求，生成的 TypeScript 与 `@go-like/grpc-buf` runtime 仍可运行于 Bun、Node、Deno 或 browser。没有 Node 的 Deno-only 环境首版应在 Node CI 中生成并提交产物；不增加 Deno launcher、Bun standalone executable、多平台原生包或 Buf remote plugin。

插件通过 `@bufbuild/protoplugin` 的 `createEcmaScriptPlugin()`、`GeneratedFile`、`ImportSymbol`、`importShape()`、`importSchema()` 与 `safeIdentifier()` 生成源码。固定语法可以通过 `GeneratedFile.print()` 输出；不引入 TypeScript compiler AST 或 `ts-morph`。Buf 自己的 `protoc-gen-es` 与 Go 的 `protogen.GeneratedFile.P()` 采用相同级别的 code printer，而不是完整语言 AST。

动态 service/method/type 标识符不得直接裸插值。生成器必须让 printer 管理 import alias，并对导出名和 property name 使用安全标识符规则。

公开 Handler/Client property 使用 `safeIdentifier(method.localName)`；Connect adapter 的 implementation key 与 upstream client lookup 继续使用 descriptor 的原始 `method.localName`。例如 proto `Delete` 生成公开 `delete$()`，内部显式转发到 Connect 的 `delete` property，不能因统一改名而让 router 注册成 `Unimplemented`。

## 4. 生成的 Handler

对于同时包含四种 cardinality 的 service，生成器输出同一个业务接口：

```ts
import type { MessageInitShape } from "@bufbuild/protobuf"
import type { ConnectRouter } from "@connectrpc/connect"
import type { Context } from "@go-like/context"
import { fromHandlerContext } from "@go-like/grpc-buf"
import {
  GetOrderRequestSchema,
  OrderCommandSchema,
  OrderEventSchema,
  OrderService,
  OrderSchema,
  UploadEventSchema,
  UploadSummarySchema,
  WatchOrdersRequestSchema,
  type GetOrderRequest,
  type Order,
  type OrderCommand,
  type OrderEvent,
  type UploadEvent,
  type UploadSummary,
  type WatchOrdersRequest
} from "./order_pb.js"

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

上例的 message 名仅表示生成形态；实际 import 由 descriptor 决定。每个方法的第一个业务参数始终是 Like `Context`，第二个参数始终是单条 request 或 request `AsyncIterable`。

私有 adapter 执行以下唯一转换：

```text
Connect (request, HandlerContext)
  -> Like (fromHandlerContext(HandlerContext), request)
```

四种签名严格跟随 Connect-ES 2.1.2：unary 接受同步 `MessageInitShape` 或原生 `Promise`，client-streaming 只接受原生 `Promise`，server-streaming 与 bidi 直接返回业务 `AsyncIterable`。adapter 只交换 `(request, HandlerContext)` 与 `(ctx, request)` 的参数顺序，不扩大为广义结构 thenable 声明，也不增加第二次 await 包装。异常或 rejected promise 原样进入 Connect-ES 的错误路径，不生成 `[error, response]` tuple，也不在第一阶段增加 `ServiceError` 映射。

`registerXHandler()` 只调用 `router.service()`。第一阶段不增加自定义 Handler DSL、middleware ABI 或注册 options；需要上游原生高级能力的开发者可以直接使用 Connect-ES `ServiceImpl` 与 `router.service()`。

## 5. 生成的 Client

同一 service descriptor 生成 ctx-first Client：

```ts
import type { MessageInitShape } from "@bufbuild/protobuf"
import type { Transport as ConnectTransport } from "@connectrpc/connect"
import type { Context } from "@go-like/context"

export interface OrderServiceClient {
  getOrder(ctx: Context, req: MessageInitShape<typeof GetOrderRequestSchema>): Promise<Order>

  watchOrders(
    ctx: Context,
    req: MessageInitShape<typeof WatchOrdersRequestSchema>
  ): AsyncIterable<OrderEvent>

  uploadEvents(
    ctx: Context,
    req: AsyncIterable<MessageInitShape<typeof UploadEventSchema>>
  ): Promise<UploadSummary>

  syncOrders(
    ctx: Context,
    req: AsyncIterable<MessageInitShape<typeof OrderCommandSchema>>
  ): AsyncIterable<OrderEvent>
}

export function newOrderServiceClient(transport: ConnectTransport): OrderServiceClient
```

factory 内部只做：

```text
createClient(OrderService, transport)
  + 每次调用把 (ctx, request) 转成 (request, callOptions(ctx))
```

`newXClient()` 接受 Connect-ES 导出的 `Transport`，生成代码固定使用 `ConnectTransport` import alias，避免与现有 `@go-like/transport.Transport` 混淆。生成器本身不选择 wire、不创建网络连接，也不提供 `close()`。它只借用调用方提供的 transport；多个 service client 可以共享同一个长生命周期 connection owner 暴露的 transport，底层资源只能由 owner 关闭。

本阶段只验证 `createConnectTransport()`、`createGrpcWebTransport()` 与测试用 `createRouterTransport()`；其他 upstream transport 不构成本阶段的支持承诺。后续 owner 负责连接复用、mTLS 与显式关闭，但不会改变这里生成的 Handler/Client 签名，也不会把 runtime-specific API 生成进业务胶水。

第一阶段生成的 client 方法固定为 `(ctx, request)`，不增加第三个 options 参数。需要逐次设置 `onHeader`、`onTrailer` 或 Connect `ContextValues` 的高级调用方，直接使用 upstream `createClient()` 与公开的 `callOptions(ctx, overrides)`；等真实用例证明 ctx-first client 也必须承载逐次 options 后，再独立扩展生成接口。

## 6. Context 与 metadata 桥

`fromHandlerContext(rpc)` 返回结构化 Like `Context`：

- `done()` 直接返回 `rpc.signal`，不另造 AbortController；
- `deadline()` 在创建时根据 `rpc.timeoutMs()` 捕获绝对 deadline；
- `err()` 在 signal 未取消时返回 `null`，取消后按捕获 deadline 区分 `deadlineExceeded` 与 `canceled`；
- request headers 通过 `@go-like/metadata.newServerContext()` 写入 server metadata 域；
- `rpc.protocolName`、URL origin、service/method 与 headers 通过 `@go-like/transport.newServerContext()` 写入现有 `TransportInfo` 域；
- 不复制或假装跨网络传递 Connect `ContextValues`；
- 不分配 listener、timer 或 owner，因此 handler/stream 完成后没有额外 dispose API。

`TransportInfo` 的字段语义固定为：

- `kind()` 返回实际 `rpc.protocolName`，portable handler 中只能是 `connect` 或 `grpc-web`，不得固定伪报为 `grpc`；
- `endpoint()` 返回 `new URL(rpc.url).origin`，不得包含 `/package.Service/Method` 路径；
- `operation()` 返回 `/${rpc.service.typeName}/${rpc.method.name}`，方法路径只出现一次。

`callOptions(ctx, overrides?)`：

- 把 client metadata 转成 request `Headers`；
- 把 `ctx.done()` 转成 `signal`；
- 把剩余 deadline 转成 `timeoutMs`；
- Context signal 与显式 signal 同时存在时使用标准 `AbortSignal.any()` 合并；
- 显式 timeout 只能收紧 Context deadline，不能取消它；
- 显式 headers 覆盖同名 Context metadata；
- 原样保留显式 `onHeader`、`onTrailer` 与 `contextValues`。

首版不把 response initial metadata 与 trailers 塞入现有单一 reply-header facade。需要直接设置 response headers/trailers 的 Handler 使用 upstream `ServiceImpl`；需要逐次读取它们的 Client 使用 upstream `createClient()` 与 `callOptions(ctx, overrides)`。生成的 ctx-first Handler/Client 首阶段不伪造这两个尚无 Like 公共承载模型的能力。

## 7. `newHandler()`：portable Fetch 一等入口

公共接口：

```ts
import type { ConnectRouter } from "@connectrpc/connect"

export type Routes = (router: ConnectRouter) => void

export function newHandler(routes: Routes): (request: Request) => Promise<Response>
```

实现固定为：

1. `createConnectRouter({ connect: true, grpcWeb: true, grpc: false })`；
2. 调用一次 `routes(router)`；
3. 使用 `@connectrpc/connect/protocol` 公开的 `createFetchHandler()` 包装 `router.handlers`；
4. 以每个 upstream handler 的 `requestPath` 构造不可变 pathname map；
5. 匹配后把标准 `Request` 交给 upstream handler，未匹配返回 `404`；
6. codec、protocol negotiation、compression、stream framing 与错误响应继续由 Connect-ES 处理。

根入口不得静态 import `node:http2`、`@connectrpc/connect-node`、`@grpc/grpc-js` 或任何 Node-only 模块。它可以直接交给 Bun、Deno、Edge/Serverless Fetch host，或现有 `@go-like/web/node`。

本轮 portable contract 承诺 Connect 与 gRPC-Web 的 unary、server-streaming。request-streaming 与 bidi 不因 Web Streams 存在而被宣称支持；标准 gRPC native host 不属于本轮实施计划。

## 8. 测试与生成证据

框架仓库保留一个 private fixture，至少包含：

```text
test/fixtures/codegen/
  buf.yaml
  buf.gen.yaml
  proto/order/v1/order.proto
```

fixture 的 proto 同时包含 unary、server-streaming、client-streaming 与 bidi，用于证明四种 Handler/Client 签名来自同一 descriptor。

必须留下以下可重复证据：

1. generator unit test 从受控 descriptor 生成 TypeScript，覆盖四种 methodKind、安全标识符、多个 service 与无 service 文件；
2. local `buf lint` / `buf generate` 同时执行 `protoc-gen-es` 与构建后的 `protoc-gen-like` binary；binary 固定为 Node-target CJS，package 的 `bin` 指向存在且可执行的文件，shebang、engine、`--version` 与 published consumer 的真实 Buf 调用共同证明它由 Node 22+ 执行且不依赖 Bun；
3. generated output 经过独立 TypeScript typecheck；string proto field 传 number 的负类型用例必须由 `@ts-expect-error` 锁定；
4. `createRouterTransport()` 集成测试证明生成的注册函数与 client factory 调用同一业务 Handler，并传递 Context metadata 与 deadline；`callOptions()` 单测独立证明显式 response header/trailer callbacks 原样保留；
5. `newHandler()` 通过真实 Fetch `Request`/`Response` 覆盖 Connect 与 gRPC-Web unary/server-streaming、404 与取消；
6. 现有 `@go-like/web/node` 托管 `newHandler(routes)`，并由 Core App 完成真实 bind、endpoint 收集、start/stop；这条测试证明框架生命周期集成，而不只证明内存 Fetch；
7. Bun、Node、Deno 从构建后的 package 运行 portable fixture；真实浏览器与命名 Edge 平台仍需后续单独证据；
8. public API/type tests 精确锁定两个新 package 的根入口与零 public subpath；
9. bundle/import gate 证明 portable runtime 根入口不包含 Node builtin；
10. generator snapshot 证明 `newXClient()` 只借用传入 transport，不构造 connection、不导出 `close()`，多个 service 不生成各自的资源 owner；
11. published consumer 以 project-local devDependency 和 package script 运行 `local: protoc-gen-like`，不依赖全局安装、不硬编码 `node_modules/.bin`；
12. 所有 Buf 配置只使用 local module/plugin，不配置 BSR、remote module、remote plugin 或在线服务。

生成文件是测试 fixture 的构建产物，不成为 go-like package 的 public export。生成一致性测试必须运行生成器并检查行为或完整输出，不能只 grep generator 源码。

## 9. 真 gRPC 目标与本轮边界

用户提供的 `/tmp/likego-buf-es-runtime.K7Pf2F/REPORT.md` 记录了固定版本实验：`@connectrpc/connect-node` 2.1.2 在 Node 26.7、Bun 1.4、Deno 2.9.5 上以 h2c 和 TLS/ALPN 完成标准 gRPC 四种 cardinality，且 `buf curl --protocol grpc` 作为独立客户端调用成功。该证据证明 Buf/Connect runtime 能实现“真 gRPC”；Bun、Deno 仍是版本锁定的实测兼容，不是上游正式支持承诺。

供应方边界据此固定为：

- 使用 Connect-ES / `@connectrpc/connect-node` 实现的标准 gRPC，属于 `@go-like/grpc-buf`；
- 使用 Google-origin gRPC 项目的 `@grpc/grpc-js` 时，独立设计 `packages/grpc-google` 与 `@go-like/grpc-google`，绝不塞进 Buf package；
- wire 相同不代表 runtime 可混用，package 按 runtime vendor 隔离。

本轮仍不创建 `newServer()`、`newTransport()`、native h2c/TLS host、client connection owner、direct `grpc://` / `grpcs://` transport、Discovery resolver 或 Selector feedback。真 gRPC 与 client connection owner 由后续独立 Buf-runtime 设计与实施计划承担；owner 必须保持同一 package root、跨 Node/Bun/Deno 的相同公共签名，并拥有连接复用、mTLS 配置与终止性关闭，本轮不预定义其名称或 options。

canonical gRPC error details、health、reflection、validation、retry、hedging、compression、mTLS、Buf 在线服务与 schema 发布同样不进入本轮。现有实验报告没有测试 mTLS，因此不能把 h2c 或单向 TLS/ALPN 成功外推成 Bun、Node、Deno 的 mTLS 支持。

## 10. 对原设计的取代范围

本设计只取代 `2026-08-28-buf-connect-grpc-integration-design.md` 中以下旧结论：

- “go-like 不实现 RPC code generator”；
- “业务必须直接实现 `ServiceImpl`”；
- “不生成 `RegisterXHandler` / `NewXClient`”；
- “Like protoc plugin 属于明确排除项”；
- “只有一个新增 package，inventory 变为 44”。

原设计关于 Connect/Protobuf runtime 所有权、实际 wire 必须如实标识、显式取消和 Buf 在线服务排除项继续有效。原设计中的 package 名、Google/Buf runtime 混合边界，以及未经验证便预定义 native/Discovery API 的结论不再有效；使用 Buf runtime 达成真 gRPC 的目标继续有效。

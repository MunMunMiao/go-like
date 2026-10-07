# @go-like/protoc-gen-like

`@go-like/protoc-gen-like` 是 project-local Node 22+ build-time Buf protoc plugin，用于生成 go-like portable
RPC 代码。它不是 provider package，也不是 portable application runtime 的依赖；Bun 只用于本仓库内部
build/package。生成的 `MessageShape` / `MessageInitShape` 是 Protobuf-ES 类型。Struct HTTP 契约使用
`@go-like/transport` 的 `defineService`；托管标准 gRPC Client 用 `withEndpoint` 选择根 URL 或
`discovery:///<name>`。`withAddress` 与 `withService` 已删除。

生成代码直接 import 的 runtime dependencies 必须由 Node/npm consumer 声明：

```sh
npm install @bufbuild/protobuf @connectrpc/connect @go-like/context @go-like/transport-grpc-buf
```

codegen toolchain 只在 build time 使用，作为 dev dependencies 安装：

```sh
npm install --save-dev @bufbuild/buf @bufbuild/protoc-gen-es @go-like/protoc-gen-like
pnpm add --save-dev @bufbuild/buf @bufbuild/protoc-gen-es @go-like/protoc-gen-like
yarn add --dev @bufbuild/buf @bufbuild/protoc-gen-es @go-like/protoc-gen-like
```

在 `package.json` 中通过 npm、pnpm 或 Yarn package script 运行项目本地 Buf：

```json
{
  "scripts": {
    "proto:generate": "buf generate"
  }
}
```

`buf.gen.yaml` 使用 PATH 上的 project-local binary，不依赖远程 plugin/module 或 Bun：

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: gen
    opt:
      - target=ts
      - import_extension=js
  - local: protoc-gen-like
    out: gen
    opt:
      - target=ts
      - import_extension=js
```

上游 `protoc-gen-es` 生成 Protobuf-ES message codec 与 descriptor；本 plugin 只生成 ctx-first
Handler/Client glue。典型输出形态如下：

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
`AsyncIterable<MessageShape<...>>`；输出接受 `MessageInitShape`，其中 unary 允许直接值或 `Promise`，
client-streaming 返回原生 `Promise<MessageInitShape<...>>`，server-streaming/bidi 返回
`AsyncIterable<MessageInitShape<...>>`。Client unary/server-streaming 请求接受 `MessageInitShape`，
client-streaming/bidi 请求接受 `AsyncIterable<MessageInitShape<...>>`；解码输出是 `MessageShape`，其中
unary/client-streaming 返回 `Promise`，server-streaming/bidi 返回 `AsyncIterable`。生成代码只实现
`registerXHandler(server, handler)` 与 `newXClient(client)` 胶水；它接收并借用 caller-owned Connect transport，
不创建或关闭 owner。raw Connect descriptor/transport 是 advanced escape hatch。

需要向 caller 返回明确的业务错误时，handler 使用上游 `ConnectError` 声明 status 和 Protobuf details。
普通 `Error` 仍由 Connect 服务端按通用 `Internal` 处理；生成器不添加错误分类或重试策略。

`@go-like/transport-grpc-buf` 根入口的 portable Fetch evidence 只覆盖 Connect/gRPC-Web unary 与
server-streaming，不据四种 generated cardinality 宣称 Fetch request-streaming 或 bidi。托管的标准 gRPC
client/server 位于 `@go-like/transport-grpc-buf/native`，四种 cardinality 已在 Node 26.7.0、Bun 1.4.0、
Deno 2.9.5 的物理发布包测试中通过。Deno-only 环境没有 Node 时应在 Node-enabled CI 生成并消费提交或交付的
产物；当前不承诺第二套 launcher。

上述四种调用的基础互操作通过不代表全部生命周期场景通过。当前还存在 Deno native 慢消费与停止并存时的提前断流、
Bun Fetch 静默响应流的取消传播，以及未修补的 Connect 2.1.2 取消后 deadline timer 滞留；具体版本、证据范围和
调用方取消契约见 [runtime 文档](../transport/grpc-buf/README.md)。生成器不为这些边界添加重试或强制 drain。

仓库 source 使用 Bundler 模块解析，不能用 source-linked 执行结果代替发布包兼容性检查。外部消费者安装构建后的
包，并在项目脚本中调用本地 `buf` / `protoc-gen-like`；生成的 `.js` 相对 import 由 TypeScript 编译后的文件满足。
对 Deno 消费者也先生成、编译，再运行产物，不需要手改生成代码的 import。

当前范围不包含 official health/reflection、validation、canonical error-details mapping、Google gRPC runtime
或 Buf online services，也没有 placeholder API。

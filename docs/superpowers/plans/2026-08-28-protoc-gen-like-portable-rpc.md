# protoc-gen-like Portable RPC 第一阶段实施计划

> **历史记录，已被取代：** 本文保留 2026-08-28 第一阶段的计划上下文，不再代表当前公开 API。package 位置、Client 构造期寻址、共享 Selector 路径、启动前 Handler 注册与标准 gRPC owner 以 [2026-08-30 HTTP/gRPC transport 对齐实施计划](./2026-08-30-http-grpc-transport-alignment.md) 为准；不要从下方历史正文复制当前签名。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第一阶段发布一个薄 `protoc-gen-like` 和 `@go-like/grpc-buf` 的 portable Fetch 入口，让应用从同一 `.proto` 获得 ctx-first Handler、注册函数、ctx-first Client、client factory，并在 Bun、Node、Deno 上复用 Connect-ES 的真实 codec、router、client、Connect wire 与 gRPC-Web wire。

**Architecture:** `protoc-gen-es` 继续生成 message/schema/service descriptor；`protoc-gen-like` 只用 Buf `GeneratedFile` printer 生成 Like 调用胶水；本阶段的 `@go-like/grpc-buf` 只桥接 Like Context/Metadata 与 Connect `HandlerContext`/`CallOptions`，并用 Connect 公开的 Fetch adapter 做 pathname dispatch。生成 client 借用调用方提供的 Connect `Transport`。已确认的长生命周期 connection owner 将在后续计划中负责连接复用、mTLS 与关闭，不改变生成代码，也不形成 public runtime subpath。

**Tech Stack:** Bun 1.4、TypeScript 7、Buf CLI 1.72、Protobuf-ES / Protoplugin 2.14、Connect-ES / Connect-Web 2.1、标准 Fetch Web API、oxfmt、oxlint。

**Evidence input:** `/tmp/likego-buf-es-runtime.K7Pf2F/REPORT.md` 已记录同一版本组合在 Node、Bun、Deno 上通过 `@connectrpc/connect-node` 标准 gRPC h2c/TLS 四类 RPC，并由 `buf curl --protocol grpc` 独立互通。该报告没有测试 mTLS。它保留“Buf runtime 真 gRPC”目标，但不授权本 portable 计划增加 native API；正式实现仍须把相关测试迁入仓库后才能形成持续支持声明。

**Spec:** [docs/superpowers/specs/2026-08-28-protoc-gen-like-design.md](../specs/2026-08-28-protoc-gen-like-design.md)

## Global Constraints

- 本轮只实施 codegen、Context/Metadata bridge 与 portable Fetch handler；不创建 `newServer()`、`newTransport()`、connection owner、`grpc://` resolver、Discovery watcher、HTTP/2 session、health、reflection、validation 或 canonical error 空壳。已确认的 Buf/Connect 真 gRPC 与 connection owner 目标由独立设计与计划承担，不能从本计划推导精确 API。
- 不实现 Protobuf codec、Connect/gRPC client/server、framing、trailers 或 stream state machine；这些能力只调用 Buf/Connect 的公开 API。
- 不接入 BSR、Buf Cloud、remote module、remote plugin、托管生成、schema publish 或任何在线服务。
- 仓库内 `buf.yaml`、`buf.gen.yaml` 与 `.proto` 只属于 private test fixture；它们不是框架 runtime 配置，也不是业务 package。
- 生成器固定使用 `GeneratedFile.print()`、`import()`、`importShape()`、`importSchema()` 与 `safeIdentifier()`；不新增 TypeScript AST、`ts-morph`、模板引擎或通用 codegen abstraction。
- `protoc-gen-like` 发布为 Node 22+ npm executable；仓库可以继续用 Bun 构建，但 published binary 必须是已编译的 Node JavaScript，不能要求消费者安装 Bun 或现场执行 TypeScript。
- `@go-like/grpc-buf` 根入口必须保持 Web API portable，不静态导入 `node:*`、`@connectrpc/connect-node`、`@grpc/grpc-js` 或 runtime-specific host。
- `@go-like/grpc-buf` 不实现现有 `@go-like/transport.Transport`；生成的 client factory 接受 upstream `Transport as ConnectTransport`。
- 生成 client 只借用 transport，不创建或关闭底层连接；后续 owner 可被多个生成 client 共享，并独占幂等、终止性的 `close()`。
- Node、Bun、Deno 的最终框架 API 必须保持同一 package root 与公共签名；runtime 条件导出或 adapter 只能是内部实现，不增加公开 `/node`、`/bun`、`/deno` 子路径。
- 连接复用、mTLS 与关闭不属于本计划的完成声明。尤其不得把现有 h2c/TLS 报告写成已验证跨 runtime mTLS。
- 若未来明确采用 Google `@grpc/grpc-js`，另行设计 `packages/grpc-google` 与 `@go-like/grpc-google`；本计划不得创建目录、dependency、export、task 或 placeholder。
- Handler 错误通过 throw/rejected promise 传播；不生成 `[error, response]` tuple，不在本阶段增加 `ServiceError` 映射。
- Handler cardinality 严格匹配 Connect-ES 2.1.2：unary 返回 `MessageInitShape | Promise<MessageInitShape>`，client-streaming 只返回原生 `Promise<MessageInitShape>`，server-streaming 与 bidi 返回 `AsyncIterable<MessageInitShape>`；只使用原生 Promise，不生成广义结构 thenable 声明或 `Promise<AsyncIterable>`。
- 当前生成的 client contract 固定为 `(ctx, request)`；逐次 Connect options 由 raw `createClient()` + `callOptions(ctx, overrides)` 承载，不偷偷扩展第三参数。
- 所有 production source 修改先看到对应定向测试按预期失败，再做最小实现；不得降低现有严格类型、coverage、lint 或 published package 门禁。
- 两个新 package 都只发布根入口，因此 public package roots 从 43 变为 45，public source subpaths 保持 23。
- 当前工作区已有主人确认的未跟踪设计文档；执行者不得重置、覆盖或删除它们及其他无关改动。
- 当前请求未授权 commit、push、publish、release 或 deploy；所有任务完成后保留工作区 diff，等待主人单独授权。

---

## Task 1: 建立两个最小 package root 与依赖边界

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `tsconfig.base.json`
- Create: `packages/protoc-gen-like/package.json`
- Create: `packages/protoc-gen-like/tsconfig.json`
- Create: `packages/protoc-gen-like/tsconfig.test.json`
- Create: `packages/protoc-gen-like/bunfig.toml`
- Create: `packages/protoc-gen-like/README.md`
- Create: `packages/protoc-gen-like/LICENSE`
- Create: `packages/protoc-gen-like/src/index.ts`
- Create: `packages/protoc-gen-like/test/public-api.test.ts`
- Create: `packages/protoc-gen-like/test/public-types.ts`
- Create: `packages/grpc-buf/package.json`
- Create: `packages/grpc-buf/tsconfig.json`
- Create: `packages/grpc-buf/tsconfig.test.json`
- Create: `packages/grpc-buf/bunfig.toml`
- Create: `packages/grpc-buf/README.md`
- Create: `packages/grpc-buf/LICENSE`
- Create: `packages/grpc-buf/src/index.ts`
- Create: `packages/grpc-buf/test/public-api.test.ts`
- Create: `packages/grpc-buf/test/public-types.ts`

**Public interfaces:**

```ts
// @go-like/protoc-gen-like
export const protocGenLike: Plugin

// @go-like/grpc-buf portable 第一阶段
export type Routes = (router: ConnectRouter) => void
export function newHandler(routes: Routes): (request: Request) => Promise<Response>
export function fromHandlerContext(rpc: HandlerContext): Context
export function callOptions(ctx: Context, overrides?: CallOptions): CallOptions
```

- [ ] **Step 1: 写 package contract 的 RED tests**

`packages/protoc-gen-like/test/public-api.test.ts` 精确断言 runtime export 只有：

```ts
expect(Object.keys(plugin)).toEqual(["protocGenLike"])
```

`packages/grpc-buf/test/public-api.test.ts` 精确断言本阶段 runtime exports 只有：

```ts
expect(Object.keys(grpc)).toEqual(["callOptions", "fromHandlerContext", "newHandler"])
```

`public-types.ts` 分别锁定上方四个公共签名，并以负类型断言证明该 package 不是现有 `@go-like/transport.Transport`；不得测试或占位 native/discovery/Google API。该精确清单只约束本阶段交付，后续经过独立设计的 connection owner 仍从同一根入口增加。

- [ ] **Step 2: 确认 workspace 覆盖并增加 pinned dependency**

在根 `package.json`：

- 现有 `packages/*` 已同时覆盖 `packages/protoc-gen-like` 与 `packages/grpc-buf`，不增加显式 workspace；
- devDependencies 固定 `@bufbuild/buf: 1.72.0`、`@bufbuild/protoc-gen-es: 2.14.0`；
- 暂不加入 proto scripts，留给 Task 4 在真实 fixture 存在后一次完成。

两个新 package 固定依赖：

```text
@go-like/protoc-gen-like
  dependency: @bufbuild/protoplugin 2.14.0
  devDependency: @bufbuild/protobuf 2.14.0

@go-like/grpc-buf
  @bufbuild/protobuf 2.14.0
  @connectrpc/connect 2.1.2
  @go-like/context 0.0.1
  @go-like/metadata 0.0.1
  @go-like/transport 0.0.1
```

`@connectrpc/connect-web: 2.1.2` 只作为 fixture/dev dependency；`@go-like/core` 与 `@go-like/web` 只作为 Web host lifecycle 集成测试的 workspace dev dependencies；Buf CLI 与 `protoc-gen-es` 不得进入任一 runtime dependency。

- [ ] **Step 3: 建立最小 package 配置**

复用 `packages/transport/http` 的 package/tsconfig/bunfig 结构：

- 两个 package 都只声明 `exports: { ".": "./src/index.ts" }`；
- `publishConfig.directory` 为 `dist`；
- runtime tsconfig 只 reference `context`、`metadata`、`transport`；test tsconfig 可使用 dev-only 的 `core` 与 `web`；
- plugin tsconfig 不 reference runtime package；
- plugin package 声明 `bin: { "protoc-gen-like": "bin/protoc-gen-like.cjs" }`、`engines.node: ">=22"` 与 `preferUnplugged: true`，使构建期要求与 `@bufbuild/protoc-gen-es` 2.14.0 对齐；该 `bin` 路径以最终 `dist/package.json` 为基准，Task 3 的构建必须生成同路径文件；
- `tsconfig.base.json` 增加两个根 alias；
- README 只说明职责、最小用法与明确排除项，不复制 Buf 官方文档；必须说明 `buf` 是 runtime/vendor qualifier、Connect 与 gRPC-Web 是本轮实际 wire、当前没有 native API；同时说明 Buf 真 gRPC 是独立实施目标，而 Google runtime 从不属于该 package。generator README 还必须给出 npm/pnpm/Yarn project-local 安装与 package-script 用法，并区分 Node codegen toolchain 和 portable application runtime。

先让 `src/index.ts` 暂时不导出目标符号。

- [ ] **Step 4: 安装并确认 RED**

Run:

```sh
bun install
bun test --isolate --no-orphans packages/protoc-gen-like/test/public-api.test.ts packages/grpc-buf/test/public-api.test.ts
bunx tsc -p packages/protoc-gen-like/tsconfig.test.json --pretty false
bunx tsc -p packages/grpc-buf/tsconfig.test.json --pretty false
```

Expected: install exit 0；API/type checks 因目标 export 尚不存在而失败，且失败只指向本任务缺失 contract。

## Task 2: 实现 Context、Metadata 与 CallOptions 桥

**Files:**

- Create: `packages/grpc-buf/src/context.ts`
- Modify: `packages/grpc-buf/src/index.ts`
- Create: `packages/grpc-buf/test/context.test.ts`
- Modify: `packages/grpc-buf/test/public-api.test.ts`
- Modify: `packages/grpc-buf/test/public-types.ts`

**Interfaces:**

```ts
export function fromHandlerContext(rpc: HandlerContext): Context

export function callOptions(ctx: Context, overrides?: CallOptions): CallOptions
```

- [ ] **Step 1: 写 `fromHandlerContext()` RED tests**

使用结构化 `HandlerContext` fixture，至少证明：

- `done()` 与 `rpc.signal` 是同一对象；
- `timeoutMs()` 在构造时被捕获为绝对 deadline，之后不会漂移；
- signal 未取消时 `err()` 为 `null`；deadline 之前取消映射 `canceled`，deadline 到期后取消映射 `deadlineExceeded`；
- `requestHeader` 转为 `@go-like/metadata` server metadata，保留规范化 key 与可表达的多值；
- 用 `protocolName: "connect"` 与 `protocolName: "grpc-web"` 两个 fixture 分别证明 `kind()` 等于实际协议、operation 是 full method、endpoint 只是 URL origin，并能读取 request headers 与当前 response headers；
- 不创建 timer、额外 AbortController 或 cleanup handle。

Run:

```sh
bun test --isolate --no-orphans packages/grpc-buf/test/context.test.ts --test-name-pattern fromHandlerContext
```

Expected: fail，因为 `fromHandlerContext` 尚未实现。

- [ ] **Step 2: 实现最小 structural Context**

实现只做：

```text
background-like structural Context
  -> metadata.newServerContext(request headers)
  -> transport.newServerContext(TransportInfo)
```

约束：

- request `Headers` 在边界转成普通 metadata record，再交给现有 `newMetadata()` 校验；
- 不调用 `withCancel()`、`withTimeout()`，也不把 `rpc.signal.reason` 当作 Like `ContextError`；
- `kind()` 使用实际 `rpc.protocolName`，当前只接受 `connect` 或 `grpc-web` fixture，不得固定写成 `grpc`；
- `operation()` 使用 `/${rpc.service.typeName}/${rpc.method.name}`；
- `endpoint()` 使用 `new URL(rpc.url).origin`，不得包含 RPC pathname；
- `replyHeaders()` 读取 `rpc.responseHeader` 当前值，不把 trailer 混入；
- `value()` 的 base 返回 `null`；
- 所有额外 Context value 只由现有 metadata/transport helpers 写入。

不得导出新 Context class、raw Connect context getter 或 response writer。

- [ ] **Step 3: 写 `callOptions()` RED tests**

至少证明：

- client metadata 成为 `Headers`；
- Context signal 成为 `CallOptions.signal`；
- Context deadline 成为非负剩余 `timeoutMs`；
- 显式 timeout 只能取更小值；
- 两个 signal 用 `AbortSignal.any()` 合并，并响应任一取消；
- 显式 headers 覆盖同名 Context metadata，保留未覆盖 metadata；
- `onHeader`、`onTrailer`、`contextValues` 引用原样保留；
- 无 metadata、deadline、signal、overrides 时不制造无意义字段。

Run:

```sh
bun test --isolate --no-orphans packages/grpc-buf/test/context.test.ts --test-name-pattern callOptions
```

Expected: fail，因为 `callOptions` 尚未实现。

- [ ] **Step 4: 实现最小 options merge 并跑 GREEN**

使用标准 `Headers`、`AbortSignal.any()`、`Date.now()` 与 `Math.min()`；不增加 signal combiner、deadline class 或 options builder。

Run:

```sh
bun test --isolate --no-orphans packages/grpc-buf/test/context.test.ts
bunx tsc -p packages/grpc-buf/tsconfig.test.json --pretty false
```

Expected: all pass。

## Task 3: 实现薄 `protoc-gen-like`

**Files:**

- Modify: `packages/protoc-gen-like/package.json`
- Modify: `packages/protoc-gen-like/src/index.ts`
- Create: `packages/protoc-gen-like/bin/protoc-gen-like.ts`
- Create: `packages/protoc-gen-like/test/generator.test.ts`
- Modify: `packages/protoc-gen-like/test/public-api.test.ts`
- Modify: `packages/protoc-gen-like/test/public-types.ts`

**Generated interfaces:**

```ts
export interface XHandler {
  /* four descriptor-derived cardinalities */
}
export function registerXHandler(router: ConnectRouter, handler: XHandler): void

export interface XClient {
  /* four descriptor-derived cardinalities */
}
export function newXClient(transport: ConnectTransport): XClient
```

- [ ] **Step 1: 用真实 WKT descriptor 写 generator RED test**

在测试中用 `@bufbuild/protobuf/wkt` 的 `CodeGeneratorRequestSchema`、`FileDescriptorProtoSchema`、`DescriptorProtoSchema`、`ServiceDescriptorProtoSchema` 与 `MethodDescriptorProtoSchema` 构造受控 request；调用：

```ts
request.parameter = "target=ts,import_extension=js"
const response = protocGenLike.run(request)
```

参数必须显式设置；Protoplugin 默认生成 JS + DTS，不能拿默认输出冒充 `_like.ts` 测试。

同一个文件至少包含：

- `OrderService` 的 unary、server-streaming、client-streaming、bidi；
- 第二个 service，证明 import/name 不互相覆盖；
- 一个名为 `Delete` 的 method；descriptor `localName` 为 `delete`，公开安全名必须为 `delete$`；
- 一个无 service 文件，证明不生成空 `_like.ts`。

完整输出 snapshot 必须证明：

- 文件名为原 proto stem 加 `_like.ts`；
- imports 由 printer 生成并带正确 type-only 标记；
- Handler 顺序始终 `(ctx, request)`；
- 保留字公开名 `delete$` 显式转发到 Connect implementation/client 的原始 `delete` property；
- unary 精确返回 `MessageInitShape | Promise<MessageInitShape>`，client-streaming 只返回 `Promise<MessageInitShape>`，server-streaming/bidi 返回 `AsyncIterable<MessageInitShape>`；输出只使用原生 Promise，且不存在 `Promise<AsyncIterable>`；
- adapter 只交换 ctx/request 参数顺序：unary 与 client-streaming 都直接返回业务 Handler 的结果，server-streaming 与 bidi 直接返回业务 `AsyncIterable`；
- client factory 只做 `createClient()` + `callOptions(ctx)`；
- upstream `Transport` import 在生成代码中固定别名为 `ConnectTransport`，不得与 Like `Transport` 混淆；
- generated client 不构造 connection、不生成 `close()`，同一 transport 可以传给多个 service factory；
- 代码中不存在 AST、framing、codec、server host 或 discovery 逻辑。

Run:

```sh
bun test --isolate --no-orphans packages/protoc-gen-like/test/generator.test.ts
```

Expected: fail，因为 plugin 尚未生成文件。

- [ ] **Step 2: 用一个 source module 实现 generator**

`src/index.ts` 只创建并导出：

```ts
export const protocGenLike = createEcmaScriptPlugin({
  name: "protoc-gen-like",
  version: "0.0.1",
  generateTs(schema) {
    for (const proto of schema.files) {
      if (proto.services.length === 0) continue
      const output = schema.generateFile(`${proto.name}_like.ts`)
      output.preamble(proto)
      for (const service of proto.services) printService(output, service)
    }
  }
})
```

同一 source module 内的私有 `printService(output, service)` 用 `method.methodKind` 的四分支打印 Handler、adapter、Client 与 factory；每个有 service 的 `DescFile` 只生成一个 `${file.name}_like.ts`。公开 Handler/Client property 使用 `safeIdentifier(method.localName)`，Connect adapter object key 与 upstream client lookup 必须继续使用原始 `method.localName`。所有 import 由 printer-managed `ImportSymbol` 处理。不要添加 visitor、IR、template registry 或第二个 generator package。

- [ ] **Step 3: 增加最小 Node executable**

`bin/protoc-gen-like.ts` 仅包含 shebang、两条 import 与一次调用：

```ts
#!/usr/bin/env node
import { runNodeJs } from "@bufbuild/protoplugin"
import { protocGenLike } from "../src/index.ts"

runNodeJs(protocGenLike)
```

package manifest：

```json
{
  "bin": { "protoc-gen-like": "bin/protoc-gen-like.cjs" },
  "engines": { "node": ">=22" },
  "preferUnplugged": true,
  "scripts": {
    "build": "bun x --bun tsdown --config-loader native && bun build ./bin/protoc-gen-like.ts --target=node --format=cjs --packages=external --outfile=dist/bin/protoc-gen-like.cjs && chmod +x dist/bin/protoc-gen-like.cjs"
  }
}
```

这里的 Bun 命令只属于 go-like 仓库的构建环境；发布包只包含 Node-target JavaScript。不得发布要求 Bun 的 shebang、Bun standalone executable 或让消费者现场执行 `.ts`。不新增 CLI framework、argument parser 或配置文件 loader；stdin/stdout plugin protocol 由 `runNodeJs()` 负责。

- [ ] **Step 4: 跑 generator 与 package GREEN**

Run:

```sh
bun test --isolate --no-orphans packages/protoc-gen-like/test
bunx tsc -p packages/protoc-gen-like/tsconfig.test.json --pretty false
bun run --cwd packages/protoc-gen-like build
test -x packages/protoc-gen-like/dist/bin/protoc-gen-like.cjs
head -n 1 packages/protoc-gen-like/dist/bin/protoc-gen-like.cjs | rg '^#!/usr/bin/env node$'
node packages/protoc-gen-like/dist/bin/protoc-gen-like.cjs --version
node -e 'const p=require("./packages/protoc-gen-like/dist/package.json"); if (p.bin?.["protoc-gen-like"] !== "bin/protoc-gen-like.cjs" || p.engines?.node !== ">=22") process.exit(1)'
```

Expected: all pass；binary 存在且 executable；`--version` 输出 `protoc-gen-like 0.0.1`；dist manifest 的 `bin` 与 engine 精确匹配，Node 进程不需要 Bun。

## Task 4: 用一个 private Buf fixture 证明生成胶水可调用

**Files:**

- Modify: `package.json`
- Create: `test/fixtures/protobuf-rpc/buf.yaml`
- Create: `test/fixtures/protobuf-rpc/buf.gen.yaml`
- Create: `test/fixtures/protobuf-rpc/proto/order/v1/order.proto`
- Create: `test/fixtures/protobuf-rpc/handler.ts`
- Create: `test/fixtures/protobuf-rpc/type-errors.ts`
- Create: `test/fixtures/protobuf-rpc/integration.test.ts`
- Create: `test/fixtures/protobuf-rpc/tsconfig.json`
- Generated: `test/fixtures/protobuf-rpc/.artifacts/gen/**`

- [ ] **Step 1: 定义唯一四-cardinality fixture**

`order.proto` 定义一个 `OrderService`：

```proto
rpc GetOrder(GetOrderRequest) returns (Order);
rpc Delete(GetOrderRequest) returns (Order);
rpc WatchOrders(WatchOrdersRequest) returns (stream OrderEvent);
rpc UploadEvents(stream UploadEvent) returns (UploadSummary);
rpc SyncOrders(stream OrderCommand) returns (stream OrderEvent);
```

至少有一个 `string id` 字段供负类型测试。不得增加业务 package、HTTP annotations、validation plugin 或在线 module dependency。

- [ ] **Step 2: 写 local-only Buf pipeline**

`buf.gen.yaml` 只运行两个 local plugin：

```yaml
version: v2
clean: true
plugins:
  - local:
      - node
      - node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es
    out: test/fixtures/protobuf-rpc/.artifacts/gen
    opt:
      - target=ts
      - import_extension=js
  - local:
      - node
      - packages/protoc-gen-like/dist/bin/protoc-gen-like.cjs
    out: test/fixtures/protobuf-rpc/.artifacts/gen
    opt:
      - target=ts
      - import_extension=js
```

执行固定以 repository root 为 cwd，两个 plugin 的 `out` 都使用同一个 root-relative `test/fixtures/protobuf-rpc/.artifacts/gen`；生成测试直接断言该目录，不增加 cwd/path fallback。

根 scripts 增加：

```json
{
  "proto:lint": "bunx --bun buf lint test/fixtures/protobuf-rpc",
  "proto:generate": "bun run --cwd packages/protoc-gen-like build && bunx --bun buf generate test/fixtures/protobuf-rpc --template test/fixtures/protobuf-rpc/buf.gen.yaml",
  "proto:typecheck": "tsc -p test/fixtures/protobuf-rpc/tsconfig.json --pretty false",
  "proto:check": "bun run proto:lint && bun run proto:generate && bun run proto:typecheck",
  "test:protobuf": "bun run proto:check && bun test --isolate --no-orphans test/fixtures/protobuf-rpc/integration.test.ts"
}
```

这是框架仓库的 private fixture，所以显式写 repository-local 文件路径并用 Node 启动两个 plugin；它不是提供给业务复制的 `buf.gen.yaml`。所有 local executable 与 output path 都以 repository root 为基准；root script 不得切换 cwd，也不得从网络解析 plugin。

- [ ] **Step 3: 写 generated developer DX 与负类型 RED checks**

`handler.ts` 使用真实生成入口：

```ts
import type { OrderServiceHandler } from "./.artifacts/gen/order/v1/order_like.js"

export const handler = {
  getOrder(ctx, req) {
    return { id: req.id, state: "READY" }
  },
  delete$(ctx, req) {
    return { id: req.id, state: "DELETED" }
  },
  async *watchOrders(ctx, req) {
    yield { orderId: req.customerId, type: "READY", sequence: 1 }
  },
  async uploadEvents(ctx, requests) {
    let count = 0
    for await (const _ of requests) count += 1
    return { count }
  },
  async *syncOrders(ctx, requests) {
    for await (const request of requests) {
      yield { orderId: request.orderId, type: request.action, sequence: 1 }
    }
  }
} satisfies OrderServiceHandler
```

`type-errors.ts` 必须包含：

```ts
import { background } from "@go-like/context"
import type { OrderServiceClient } from "./.artifacts/gen/order/v1/order_like.js"

declare const client: OrderServiceClient

// @ts-expect-error proto string fields reject number inputs
void client.getOrder(background(), { id: 123 })
```

先只运行 `protoc-gen-es`，不运行 Like plugin。

Run:

```sh
bun run proto:typecheck
```

Expected: fail，因为 `order_like.ts` 不存在；这证明类型检查确实依赖新 generator，而不是手写替身。

- [ ] **Step 4: 生成并 typecheck 到 GREEN**

Run:

```sh
bun run proto:lint
bun run proto:generate
bun run proto:typecheck
```

Expected: all exit 0；生成目录同时包含 `order_pb.ts` 与 `order_like.ts`；`@ts-expect-error` 被真实类型错误消费。

- [ ] **Step 5: 用 `createRouterTransport()` 验证生成 Handler/Client**

`integration.test.ts`：

```ts
import { createRouterTransport } from "@connectrpc/connect"
import { handler } from "./handler.js"
import {
  newOrderServiceClient,
  registerOrderServiceHandler
} from "./.artifacts/gen/order/v1/order_like.js"

const transport = createRouterTransport((router) => {
  registerOrderServiceHandler(router, handler)
})
const client = newOrderServiceClient(transport)
```

覆盖四种 cardinality，并证明：

- 业务 Handler 第一个参数是 Like Context；
- client metadata 到达 Handler server metadata；
- client Context deadline 到达 Handler；
- `client.delete$()` 经原始 Connect `delete` property 调到 `handler.delete$()`，不会得到 `Unimplemented`；
- thrown Error 通过 Connect 路径成为 `ConnectError` / `Code.Internal` rejected call，不被 tuple 或空 response 吞掉；不要求跨 RPC 保留 Error identity；
- 每种请求/响应值都经过 Protobuf-ES generated shape，而不是 `unknown`/`any`。

Run:

```sh
bun run test:protobuf
```

Expected: all pass。

## Task 5: 实现 portable `newHandler()` 并验证 Connect / gRPC-Web

**Files:**

- Create: `packages/grpc-buf/src/handler.ts`
- Modify: `packages/grpc-buf/src/index.ts`
- Create: `packages/grpc-buf/test/handler.test.ts`
- Create: `packages/grpc-buf/test/web-host.test.ts`
- Modify: `packages/grpc-buf/test/public-api.test.ts`
- Modify: `packages/grpc-buf/test/public-types.ts`
- Create: `packages/grpc-buf/test/e2e/portable-runtime.ts`
- Modify: `packages/grpc-buf/package.json`
- Modify: `e2e/definitions.ts`

**Interface:**

```ts
export type Routes = (router: ConnectRouter) => void

export function newHandler(routes: Routes): (request: Request) => Promise<Response>
```

- [ ] **Step 1: 写 Fetch adapter RED tests**

使用 generated `registerOrderServiceHandler()` routes，至少覆盖：

- routes 只执行一次；
- 未匹配 pathname 返回 `404`；
- Connect unary；
- gRPC-Web unary；
- Connect server-streaming；
- gRPC-Web server-streaming；
- aborted `Request.signal` 到达业务 Context；
- request-streaming/bidi 不被测试或文档宣称为 Fetch 能力。

`web-host.test.ts` 另写一条真实组合 RED test：用 `@go-like/web/node.newNodeServer(newHandler(routes))` 构造现有 Core Server，以捕获型 Registrar 运行 `newApp(server(host))`，断言注册实例收到真实 bound `http://` endpoint、该 endpoint 可完成一次生成 client RPC，并在 `app.stop()` 后停止接纳。不得在 `@go-like/grpc-buf` 内新增 listener wrapper。

Run:

```sh
bun test --isolate --no-orphans packages/grpc-buf/test/handler.test.ts packages/grpc-buf/test/web-host.test.ts
```

Expected: fail，因为 `newHandler` 尚未实现。

- [ ] **Step 2: 用 Connect 公开 API 实现 pathname map**

`createConnectRouter` 从 `@connectrpc/connect` 导入；`createFetchHandler` 明确从 package exports 已公开的 `@connectrpc/connect/protocol` 导入。实现限定为：

```ts
export function newHandler(routes: Routes): (request: Request) => Promise<Response> {
  const router = createConnectRouter({ connect: true, grpcWeb: true, grpc: false })
  routes(router)
  const handlers = new Map(
    router.handlers.map((handler) => [handler.requestPath, createFetchHandler(handler)])
  )
  return async (request) => {
    const handler = handlers.get(new URL(request.url).pathname)
    return handler === undefined ? new Response(null, { status: 404 }) : await handler(request)
  }
}
```

不得增加 matcher abstraction、middleware layer、route trie、host listener 或 Node adapter。

- [ ] **Step 3: 跑 package GREEN 与 browser bundle gate**

Run:

```sh
bun test --isolate --no-orphans packages/grpc-buf/test
bunx tsc -p packages/grpc-buf/tsconfig.test.json --pretty false
bun build packages/grpc-buf/src/index.ts --target=browser --outfile=/tmp/go-like-grpc-buf-browser.js
! rg -n 'node:|connect-node|grpc-js' /tmp/go-like-grpc-buf-browser.js
```

Expected: all exit 0；现有 Web host/Core lifecycle 组合测试完成真实 bind、endpoint 注册、RPC 与 stop；browser bundle succeeds；forbidden import search 无输出。临时 bundle 不进入仓库。

- [ ] **Step 4: 增加 Bun / Node / Deno runtime lane**

`portable-runtime.ts` 只使用 package root、生成 routes、标准 `Request`/`Response` 与 Connect-Web transports；输出一行包含 runtime、Connect result 与 gRPC-Web result 的 JSON。

package script：

```json
{
  "test:e2e:runtimes": "bun run --cwd ../../.. proto:generate && bun test/e2e/portable-runtime.ts && tsx test/e2e/portable-runtime.ts && deno run --sloppy-imports --config ../../../deno.json test/e2e/portable-runtime.ts"
}
```

`e2e/definitions.ts` 增加：

```ts
runtime("runtime-grpc-buf", "packages/grpc-buf", ["bun", "node", "deno"])
```

Run:

```sh
bun run build
bun e2e/run.ts --suite runtime-grpc-buf
```

Expected: Bun、Node、Deno 各 exit 0；每个 runtime 都实际完成 Connect 与 gRPC-Web unary/server-streaming。

## Task 6: 验证发布包、binary 与 canonical 文档

**Files:**

- Modify: `e2e/fixtures/published-consumer/package.json`
- Modify: `e2e/fixtures/published-consumer/portable.ts`
- Modify: `e2e/fixtures/published-consumer/bun.ts`
- Modify: `e2e/fixtures/published-consumer/tsconfig.authoring.json`
- Modify: `e2e/fixtures/published-consumer/tsconfig.types.json`
- Modify: `e2e/published.ts`
- Create: `e2e/fixtures/published-consumer/buf.yaml`
- Create: `e2e/fixtures/published-consumer/buf.gen.yaml`
- Create: `e2e/fixtures/published-consumer/proto/published/v1/probe.proto`
- Modify: `README.md`
- Modify: `docs/developer-experience-alignment.md`
- Modify: `doc/index.md`
- Modify: `doc/reference/packages.md`
- Modify: `doc/reference/providers.md`
- Modify: `packages/protoc-gen-like/README.md`
- Modify: `packages/grpc-buf/README.md`

- [ ] **Step 1: 扩展 published consumer 而不接入 Buf 在线服务**

- `portable.ts` 导入并调用 `@go-like/grpc-buf` 的 portable root；
- `bun.ts` 导入 `@go-like/protoc-gen-like`，只验证 build-time package root 可加载；
- published consumer 把 `@bufbuild/buf`、`@bufbuild/protoc-gen-es` 与 `@go-like/protoc-gen-like` 安装为 project-local devDependencies，并定义 `"proto:generate": "buf generate"`；
- `e2e/published.ts` 的 `FixtureFiles` 与 stage directories 显式覆盖 `buf.yaml`、`buf.gen.yaml`、`proto/published/v1/probe.proto` 和生成目录的父级，不能因当前 flat-file copy 漏掉嵌套 fixture；
- `e2e/published.ts` 在 staged npm install 后先执行 `node_modules/.bin/protoc-gen-like --version`，再通过 `npm run proto:generate` 运行 fixture；`buf.gen.yaml` 使用裸 `local: protoc-gen-es` 与 `local: protoc-gen-like`，不硬编码 `node_modules/.bin`；
- staged Buf config 只使用 local installed binary，不配置 remote plugin/module；binary 必须通过 Node shebang 执行；
- 对 staged `@go-like/protoc-gen-like/package.json` 断言 `engines.node === ">=22"`、`bin["protoc-gen-like"] === "bin/protoc-gen-like.cjs"`；对 bin 文件断言它是 executable regular file、首行为 `#!/usr/bin/env node`，并断言当前 Node major version 至少为 22；
- 断言同一输出目录同时存在 `probe_pb.ts` 与 `probe_like.ts`，并继续由 package integration test 负责完整双-plugin typecheck；published lane 不复制第二套 generator oracle。

Run:

```sh
bun run build
bun run test:e2e:published
```

Expected: all packages pack/install/type-resolve；Bun/Node/Deno runtime consumers pass；staged `protoc-gen-like` 的 manifest、执行权限、shebang 与版本通过检查，并由 Node 22+ 经 package script 和 Buf 实际执行；生成命令和配置均不引用 Bun。

- [ ] **Step 2: 更新 canonical inventory 与边界**

只修改仍在发布的 canonical claims：

- `README.md`：移除“gRPC/Protobuf/IDL 全部排除”的绝对表述，改为本地 Buf + upstream runtime + thin glue；
- `docs/developer-experience-alignment.md`：加入 ctx-first Handler/Client 形态及 raw Connect advanced escape hatch；
- `doc/index.md`、`doc/reference/packages.md`、`doc/reference/providers.md`：43 改为 45，23 public subpaths 不变，列出两个新 package；
- 明确生成器属于 build-time，`@go-like/grpc-buf` 的当前第一阶段 contract 是 portable Fetch；
- 明确 `protoc-gen-like` 是 Node 22+ project-local dev tool，不要求 Bun；npm/pnpm/Yarn 通过 package script 暴露 executable。没有 Node 的 Deno-only 环境在 CI 生成并提交产物，首版不提供第二套 launcher；
- 明确 native gRPC host、connection owner、Discovery、health/reflection 与 Buf online services 未由本计划实施，也没有预留精确 API；Buf/Connect 真 gRPC 与同根入口的 connection owner 保持为独立实施目标，Google runtime 不属于该 package；
- 明确 connection owner 负责连接复用、mTLS 与关闭，生成 client 只借用其 transport；现有实验报告没有证明 mTLS。

不得批量改写历史 specs、旧 rollout evidence 或已经冻结的 campaign artifacts。

- [ ] **Step 3: 构建文档与精确 inventory check**

Run:

```sh
bun run doc:build
rg -n '43 public|43 package|no gRPC|不拥有 gRPC|IDL.*排除|generated RPC.*排除' README.md docs/developer-experience-alignment.md doc
```

Expected: docs build exit 0；search 只允许明确标注为历史/未实施 native 能力的语句，不能残留与 45-package 现状矛盾的 canonical claim。

## Task 7: 全量验证与独立审查

**Files:** all files changed by Tasks 1-6

- [ ] **Step 1: 跑定向门禁**

Run:

```sh
bun run proto:check
bun run test:protobuf
bun test --isolate --no-orphans packages/protoc-gen-like/test
bun test --isolate --no-orphans packages/grpc-buf/test
bun run --cwd packages/protoc-gen-like typecheck
bun run --cwd packages/grpc-buf typecheck
bun run --cwd packages/protoc-gen-like build
bun run --cwd packages/grpc-buf build
```

Expected: all exit 0。

- [ ] **Step 2: 跑仓库门禁与 runtime/published E2E**

Run:

```sh
bun run verify
bun run test:e2e:runtimes
bun run test:e2e:published
bun run doc:build
git diff --check
```

Expected: all exit 0。若仓库既有门禁失败，记录精确 command、exit code 与与本次 diff 的关系；不得把局部通过写成全量通过。

- [ ] **Step 3: 审查 scope、public API 与依赖图**

审查必须确认：

- public runtime exports 精确为本阶段计划定义；
- 两个 package 都没有 public subpath；
- runtime root 无 Node-only import；
- plugin 无 Connect server/client dependency；
- runtime package 无 Buf CLI/protoc-gen dependency；
- runtime package 无 `@connectrpc/connect-node`、`@grpc/grpc-js`，且不实现现有 Like `Transport`；
- generated Handler 的 unary/client-streaming/server-streaming/bidi 返回类型与 Connect-ES 2.1.2 精确一致，只使用原生 Promise，不暴露广义结构 thenable 声明；
- published `protoc-gen-like` 的 dist `bin` 路径、执行权限、shebang、engine、构建 target、format 与真实 Buf 子进程都是 Node/CJS，不包含 Bun runtime 要求；
- 所有 Buf config local-only；
- generator source 不含 AST/template-engine dependency；
- 没有 `newServer`、`newTransport`、Discovery、health/reflection/error-details 占位；
- generated output 的四种 cardinality 与开发者示例来自同一 descriptor；
- generated client 不创建或关闭 connection，多个 service client 可共享同一个 transport；
- type-negative test 真正拒绝 proto `string` 接收 `number`；
- Bun/Node/Deno runtime 与 Node published binary 结论都有刚运行的证据。

- [ ] **Step 4: 检查最终 diff 并等待授权**

Run:

```sh
git status --short --branch
git diff --stat
git diff -- package.json tsconfig.base.json packages/protoc-gen-like packages/grpc-buf test/fixtures/protobuf-rpc e2e README.md docs/developer-experience-alignment.md doc
```

Expected: 只有本计划范围内改动与主人原有 planning artifacts；不 stage、不 commit、不 push。向主人报告已验证的 portable 第一阶段范围、尚未实施的 connection owner/mTLS、独立 Buf 真 gRPC 目标、明确隔离的 Google runtime scope 和任何真实失败，等待下一次授权。

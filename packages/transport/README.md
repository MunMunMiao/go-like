# `@likego/transport`

`@likego/transport` 定义 LikeGo 内部微服务同步通信的公共契约和 `Likego-` 请求头。
它不依赖具体协议、Web 框架、Registry 或供应商 SDK；HTTP 实现在独立的 `@likego/transport-http` 包中。

## 公开入口

- 根入口：`Transport`、`Client`、`Listener`、`Socket`、`Message`、`TransportInfo`、通用
  `Handler` / `Middleware`、公共 options、调用侧结构化服务错误与 Context accessors。
- `@likego/transport/headers`：18 个固定 header 常量。项目自有 header 统一使用 `Likego-` 前缀，标准
  `Content-Type` 保持原名。
- `@likego/transport/json`：仅使用 `TextEncoder`、`TextDecoder` 与 Standard Schema 的可移植 JSON codec。
- `@likego/transport/provider`：provider 实现需要的 Message 防御快照、metadata / ServiceError wire codec
  与稳定 transport 错误工厂；普通调用方不需要导入。

所有 I/O 方法都把 `Context` 作为独立首参。`init()`、`options()` 和 `string()` 是纯配置或纯读取调用，
不接收 Context；Context 不会藏入 option bag。

```ts
import { background } from "@likego/context"
import type { Transport } from "@likego/transport"

declare const transport: Transport

const listener = await transport.listen(background(), "127.0.0.1:0")
const client = await transport.dial(background(), listener.addr())
```

## 类型化 unary contract

`endpoint(service, name, requestCodec, responseCodec)` 在现有 `Message` 边界上描述一个类型化 operation，
不引入 IDL、生成代码或新的传输协议。Client 负责编码请求和解码响应，Server 在调用业务 handler 前后完成相反转换。

```ts
import { endpoint } from "@likego/transport"
import { jsonCodec } from "@likego/transport/json"

export const quote = endpoint(
  "payments",
  "Quote",
  jsonCodec(quoteRequestSchema),
  jsonCodec(quoteResponseSchema)
)
```

JSON codec 在 decode 时通过 Standard Schema 校验并允许 schema 转换；encode 直接序列化已经由 TypeScript
约束的值。无法序列化、非法 UTF-8、非法 JSON 或校验失败都会在 transport 边界明确拒绝。

`service` 与 `name` 是 canonical `service/endpoint` 的 route token：必须只包含 U+0021–U+007E
可见 ASCII，且不得包含 `/`、`*`。该限制让 Client、Server 和 operation middleware 对同一
operation 始终得到唯一名称，不受 HTTP header 归一化影响。

## 通用 Middleware

`chain(handler, ...middleware)` 是 transport 层唯一的 Context-first middleware 组合器。第一个声明的
middleware 位于最外层，适用于 unary handler 或任意兼容的结构式调用；它不隐式捕获异常、
重试或修改 Context。

```ts
import { chain } from "@likego/transport"
import type { Handler, Message, Middleware } from "@likego/transport"

declare const handler: Handler<Message, Promise<Message>>
declare const tracing: Middleware<Message, Promise<Message>>

const composed = chain(handler, tracing)
```

## Options 与边界

三组 functional option 都是 immutable reducer，按声明顺序应用，后者覆盖前者。公共默认值为：

- common `timeoutMs` 为 `0`，表示公共层不额外创建 send/recv timer；
- dial timeout 为 `5_000ms`；
- connection close 默认关闭。

TLS 字节、codec 输入输出和 Message header/body 都执行防御性复制。Message body 与 TLS bytes 每次读取
都会返回新的 `Uint8Array`，调用方修改不会污染内部快照。结构式 logger 的抛错被隔离，不会改写协议结果。

## 稳定错误

provider 子路径提供四个无 class、可结构识别、冻结且保留 `cause` 的错误：

| 错误                                  | code                                      |
| ------------------------------------- | ----------------------------------------- |
| `TransportClosedError`                | `LIKEGO_TRANSPORT_CLOSED`                 |
| `TransportStateError`                 | `LIKEGO_TRANSPORT_STATE`                  |
| `UnsupportedTransportCapabilityError` | `LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY` |
| `TransportProtocolError`              | `LIKEGO_TRANSPORT_PROTOCOL`               |

Context 取消继续使用 `@likego/context` 的 `canceled` 或 `deadlineExceeded`，不包装为 transport 错误。

## TransportInfo Context

`newClientContext` / `fromClientContext` 与 `newServerContext` / `fromServerContext` 使用两个
独立 Context 域。`TransportInfo` 是结构式接口，提供 `kind()`、`endpoint()`、`operation()`、
`requestHeaders()` 和 `replyHeaders()`；provider 不需要继承 class 或注册全局容器。

kind 与 operation 在写入 Context 时校验并固定；endpoint 保持动态，以便 Client 在完成选择后公开实际 target。
request/reply headers 在每次读取时通过 `@likego/metadata` 生成新的不可变快照。因此 provider 可以更新请求与
响应阶段的内部状态，但调用方拿不到其可变对象。

`@likego/transport/provider` 的 `encodeMetadataHeader` / `decodeMetadataHeader` 定义唯一
`Likego-Metadata` wire：保留 metadata 的键顺序与多值顺序，支持 Unicode，拒绝非规范编码、重复键和超过
16 KiB 的值。Client 与 Server 使用该 codec 传播 metadata；底层 provider 不得自行发明另一套投影，也不得允许
业务 header 覆盖该保留头。

## 边界

该包只定义内部同步通信 SPI，不提供外部 Web handler、router、middleware、健康页、Registry 自动发现或默认
HTTP implementation。应用在 composition root 显式选择 `@likego/transport-http` 或自行实现结构式 Transport。

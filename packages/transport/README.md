# `@go-like/transport`

`@go-like/transport` 定义 go-like 内部微服务同步通信的公共契约。wire 是标准 Fetch `Request` / `Response`。
它不依赖具体协议、Web 框架、Registry 或供应商 SDK；HTTP 实现在独立的 `@go-like/transport-http` 包中。

## 公开入口

- 根入口：`Transport`、`Client`（`fetch` / `close`）、`Listener`（`addr` / `serve` / `close`）、`TransportHandler`、`TransportInfo`、通用 `Handler` / `Middleware`、`defineService`、`endpoint`、`serviceError`、`chain` 与 Context accessors。
- `@go-like/transport/headers`：只导出 `metadata`（`Go-Like-Metadata`）和 `timeout`（`Go-Like-Timeout-Ms`）。路由不使用 `Go-Like-Service` 或 `Go-Like-Endpoint` 头；operation 写在请求 path `/<service>/<endpoint>`。
- `@go-like/transport/json`：`encodeJsonBody`、`decodeJsonBody`、`jsonContentType`（`application/json`）。`decodeJsonBody(schema, bytes)` 接收 `Uint8Array`。
- `@go-like/transport/sse`：`encodeSSEComment`、`encodeSSEEvent`、`encodeSSEJsonEvent`、`eventStreamContentType`、`defaultSSEMaxMessageBytes`（4 MiB）。
- `@go-like/transport/provider`：ServiceError 与 metadata wire codec、稳定 transport 错误工厂，以及供可观测性集成使用的 `observeCall(ctx, startedAt, invoke, record)`：执行一次调用，并让 `record(end, failure)` 至多执行一次。`end` 是首个 response body 终态事件（没有则为 `null`），`failure` 是 `invoke` 抛出的值（正常返回为 `null`）；返回未读取的 Response body 或 ServerStream 时，等 body 到达终态才记录，body 既未读取也未取消则不记录。普通调用方不需要导入。

所有 I/O 方法都把 `Context` 作为独立首参。`init()`、`options()` 和 `string()` 是纯配置或纯读取调用，不接收 Context。

```ts
import { background } from "@go-like/context"
import type { Transport } from "@go-like/transport"

declare const transport: Transport

const listener = await transport.listen(background(), "memory://orders")
const serving = listener.serve(background(), () => new Response(null, { status: 204 }))
const client = await transport.dial(background(), listener.addr())
const response = await client.fetch(
  background(),
  new Request("memory://orders/orders/get", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  })
)
await response.body?.cancel()
await client.close(background())
void serving
```

## Handler Context 契约

`Listener.serve(ctx, handler)` 为每个请求派生一个独立、可取消的 handler Context（`done()` 不为 `null`）。所有 Transport 必须满足：

- 交付给对端的 Response body 进入终态（结束、出错或取消；`null` body 在交付时即终态）后，Listener **必须**取消该 Context；
- 在此之前 Listener **不得**取消它。只有请求中止、Listener 关闭或失败、`serve` 的 `ctx` 被取消可以让它更早结束；
- 取消按 Context 的标准父子传播到 handler 派生的子 Context，例如 `Go-Like-Timeout-Ms` 产生的 deadline，其 timer 随之释放。handler 因此不需要包装 Response body 来释放子 Context。

`transportConformanceCases` 中的 handler Context 用例逐项验证这条契约，自行实现 Transport 应让它们通过。传入不可取消 Context（`done()` 为 `null`）的 Transport 无法满足它；`@go-like/server` 对这类 Context 会退回到自行观察 body 并释放 deadline。

## 类型化契约

`defineService(name, definitions)` 冻结一份 Client 与 Server 共用的契约。endpoint 名是对象的 key。`request` 可省略，此时请求是空 object，handler 只有 `ctx`。`stream: true` 表示服务端流：handler 返回 `AsyncIterable`，客户端方法返回 `Promise<ServerStream<T>>`。`ServerStream` 同时是 `AsyncIterable` 与 `AsyncDisposable`，并提供 `close()`。

`endpoint(service, name, request, response, stream?)` 仍可声明单个 endpoint。`stream` 只能省略或为 `true`。

```ts
import { struct } from "@go-like/struct"
import { defineService, endpoint } from "@go-like/transport"

export const quote = endpoint(
  "payments",
  "quote",
  struct.object({ amountMinor: struct.number(), currency: struct.string() }),
  struct.object({ feeMinor: struct.number() })
)

export const payments = defineService("payments", {
  quote: {
    request: struct.object({ amountMinor: struct.number(), currency: struct.string() }),
    response: struct.object({ feeMinor: struct.number() })
  },
  watch: {
    request: struct.object({ after: struct.string() }),
    response: struct.object({ id: struct.string() }),
    stream: true
  }
})
```

`service` 与 endpoint 名是 route token，必须匹配 `^[A-Za-z0-9._~-]+$`，且不能恰好是 `.` 或 `..`。该限制让 Client、Server 和 operation middleware 对同一 operation 始终得到唯一的 `service/endpoint`，不受 HTTP header 归一化影响。

统一 JSON 边界在出站时先验证 Struct output，在入站时执行 fatal UTF-8、JSON 解析、alias/Date/BigInt 转换与 Struct 校验。无法序列化、非法 UTF-8、非法 JSON 或 Struct 校验失败都会在 transport 边界明确拒绝。

## 通用 Middleware

`chain(handler, ...middleware)` 是 transport 层唯一的 Context-first middleware 组合器。第一个声明的 middleware 位于最外层。内部 handler 是 `(ctx, request: Request) => Response | Promise<Response>`。

```ts
import { chain, type Handler, type Middleware } from "@go-like/transport"

declare const handler: Handler<Request, Promise<Response>>
declare const tracing: Middleware<Request, Promise<Response>>

const composed = chain(handler, tracing)
void composed
```

## Options 与边界

三组 functional option 都是 immutable reducer，按声明顺序应用，后者覆盖前者。公共默认值为：

- common `timeoutMs` 为 `0`，表示公共层不额外创建 fetch timer；
- dial timeout 为 `5_000ms`；
- connection close 默认关闭。

TLS 字节执行防御性复制。结构式 logger 的抛错被隔离，不会改写协议结果。

## 稳定错误

provider 子路径提供四个无 class、可结构识别、冻结且保留 `cause` 的错误：

| 错误                                  | code                                       |
| ------------------------------------- | ------------------------------------------ |
| `TransportClosedError`                | `GO_LIKE_TRANSPORT_CLOSED`                 |
| `TransportStateError`                 | `GO_LIKE_TRANSPORT_STATE`                  |
| `UnsupportedTransportCapabilityError` | `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY` |
| `TransportProtocolError`              | `GO_LIKE_TRANSPORT_PROTOCOL`               |

Context 取消保留调用方的 `cause(ctx)`；未指定自定义 cause 时为 `canceled` 或 `deadlineExceeded`，不包装为 transport 错误。

`ServiceError` 是非 2xx 的 JSON body `{ code, message, metadata }`，HTTP status 就是 `ServiceError.status`。body 里没有 `status` 字段，也不使用 `Go-Like-Service-Error` 头。

## TransportInfo Context

`newClientContext` / `fromClientContext` 与 `newServerContext` / `fromServerContext` 使用两个独立 Context 域。`TransportInfo` 提供 `kind()`、`endpoint()`、`operation()`、`requestHeaders()`、`replyHeaders()` 和 `peerIdentity()`。mTLS 对端身份在 `peerIdentity()`，不是请求头。

kind 与 operation 在写入 Context 时校验并固定；endpoint 保持动态，以便 Client 在完成选择后公开实际 target。request/reply headers 在每次读取时通过 `@go-like/metadata` 生成新的不可变快照。

`encodeMetadataHeader` / `decodeMetadataHeader` 定义唯一 `Go-Like-Metadata` wire：保留 metadata 的键顺序与多值顺序，支持 Unicode，拒绝非规范编码、重复键和超过 16 KiB 的值。空 metadata 不产生该头。业务 header 不能覆盖它。

## 边界

该包定义内部 Fetch 通信 SPI、unary/server-stream 契约和通用 `chain`。它不提供外部 Web handler、router、业务 middleware、健康页、Registry 自动发现或默认 HTTP implementation。客户端流和双向流不属于这条 SPI，它们留在 `@go-like/transport-grpc-buf/native`。应用在 composition root 显式选择 `@go-like/transport-http` 或 `@go-like/transport-memory`。

# @go-like/connectrpc

Connect 与 gRPC-Web 的 Web `Handler`，以及 Node 上的生命周期 `Server`、`Endpointer` 和 gRPC 客户端。它不实现 core 的 `Transport` 插座。core 的中间件、`ServiceError` 和限流不作用于 Connect 处理器。

## 入口

| 入口                       | 填充的插座                                    | 通道   | 关键导出                                                                                                            |
| -------------------------- | --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `@go-like/connectrpc`      | Web `Handler`；客户端调用选项；生成代码胶水   | 可移植 | `newHandler`、`fromHandlerContext`、`callOptions`、`telemetryInterceptor`、`Routes`、`ServiceRegistrar`             |
| `@go-like/connectrpc/node` | 生命周期 `Server` 与 `Endpointer`；发现客户端 | Node   | `newServer`、`newClient`、`ClientOptions`、`ServerOptions`、`address`、`advertise`、`withEndpoint`、`withDiscovery` |

## 依赖

| 种类 | 包                         | 范围      |
| ---- | -------------------------- | --------- |
| peer | `@go-like/core`            | `0.0.1`   |
| peer | `@connectrpc/connect`      | `^2.3.0`  |
| peer | `@bufbuild/protobuf`       | `^2.17.0` |
| 常规 | `@connectrpc/connect-node` | `2.3.0`   |
| 开发 | `@types/node`              | `26.6.6`  |

没有可选 peer。`@go-like/core` 的 dev 依赖是 `workspace:*`。公开 `.d.ts` 不引用 Node 类型，所以 `@types/node` 是开发依赖。生成器是 `@go-like/protoc-gen-like`，生成的导入是 `@go-like/core/context` 与 `@go-like/connectrpc`。

## 示例

```ts
import { newHandler, type Routes } from "@go-like/connectrpc"
import { newApp, server } from "@go-like/core"
import { newNodeServer, port } from "@go-like/core/web/node"
import { address, newServer } from "@go-like/connectrpc/node"

declare const routes: Routes

const fetchHandler = newHandler(routes)
const web = newNodeServer(fetchHandler, port(8080))
const grpc = newServer(address("127.0.0.1:50051"))
const app = newApp(server(web, grpc))
void app
```

`Routes` 收到的 `ServiceRegistrar` 就是 Connect 的 `service`。`./node` 的 `newClient(withEndpoint(...))` 或 `withDiscovery(...)` 是托管 gRPC 客户端，由调用方 `close`。`ClientOptions` 与 `ServerOptions` 是选项函数归约出的不可变配置，类型从 `./node` 导出。

`newHandler` 与 `./node` 的 `newServer` 为每次调用建立 `rpc.server` 单元。span 名是 `{rpc.method}`，父级取自请求头：空载体或损坏的 `traceparent` 不会沿用宿主 Context 上已有的 span。`newHandler`（Connect 与 gRPC-Web）的 `rpc.system.name` 是 `connectrpc`；托管 gRPC 服务端是 `grpc`。处理函数跑在该单元的 Context 里，下游调用成为子 span。

`./node` 的 `newClient` 为每次调用建立 `rpc.client` 单元（`rpc.system.name` 为 `grpc`），选择与委托都在这个单元内，并把 `traceparent` 注入请求头。没有安装 tracer 时，调用方 Context 上的远程父级仍会注入。应用若再把 `telemetryInterceptor("grpc")` 加到同一次 `newClient` 调用的传输上，已经带有 `rpc.client` 单元的调用不会再开第二个 span。

应用自建的 Connect 传输（`createConnectTransport` / `createGrpcWebTransport`）仍要把 `telemetryInterceptor()` 放进 `interceptors`。省略 `system` 时标签是 `"connectrpc"`；传 `"grpc"` 时标签是 `"grpc"`。

```ts
import { callOptions, telemetryInterceptor } from "@go-like/connectrpc"
import { createConnectTransport } from "@connectrpc/connect-web"

const transport = createConnectTransport({
  baseUrl: "https://rpc.example.test",
  interceptors: [telemetryInterceptor()]
})
void [callOptions, transport]
```

## 错误码

本包不定义 `GO_LIKE_` 错误码。协议失败保持 Connect 或 Node 的错误。发现失败使用 `@go-like/core/registry` 的错误，例如 `GO_LIKE_NO_AVAILABLE_ENDPOINT`。

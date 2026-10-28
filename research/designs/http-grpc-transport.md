# HTTP 与 Buf gRPC：共享工作流与协议所有权

研究时间：2026-08-28 至 2026-09-23。保留 Buf/Connect 集成过程中的协议选型、连接所有权与失败边界；早期 `withAddress` / `withService` 已由 `withEndpoint` 取代。当前用法与运行时限制见 [grpc-buf README](../../packages/transport/grpc-buf/README.md)和[验证声明](../../doc/reference/claims.md)。

## 为什么共享工作流，而不统一 wire 接口

Kratos 的公共 transport 是生命周期、Endpointer 和 Context 观测边界，gRPC client/server 仍直接使用 grpc-go。LikeGo 早期 Message/Socket SPI 则承载一次 send/recv，无法无损表达双向流、half-close、initial metadata 和 trailers。

因此保留共同的构造与注册顺序：

```text
newClient(options...) → newXClient(client)
newServer(options...) → registerXHandler(server, implementation) → App
```

HTTP Struct 与 Protobuf/gRPC 保留独立的 registrar、wire、连接和 listener。生成器只做 ctx-first 胶水，不创建连接、不选择地址、不实现 framing，也不关闭借用资源。

## 协议与 runtime 的区别

Buf/Connect 是实现供应商；Connect、gRPC-Web、标准 gRPC 是网络协议。Connect-ES 2.1.2 同时包含三类 protocol handler，不能由 runtime 名称推断 wire。

- portable Fetch handler 承接 Connect 与 gRPC-Web 的 unary/server-streaming。
- 标准 gRPC 使用官方 Connect Node HTTP/2 runtime，置于 `@go-like/transport-grpc-buf/native` 能力子路径。
- 生成的代码与 portable 根入口不静态或传递导入 `node:*`、`@connectrpc/connect-node`。
- gRPC-Web 把 status/trailers 写入响应 body 的最后一个 frame；标准 gRPC 使用 HTTP/2 trailers。Connect-ES 2.1.2 未实现 `grpc-web-text`，原研究不据此承诺 base64 text mode。
- Buf CLI 仅编排本地 lint/generation；Protobuf-ES 提供 message/schema/descriptor，Connect-ES 持有协议状态机。不把 Buf 在线服务或 Google runtime 混入同一集成。

## 寻址与服务发现

一个 client 拥有不可变的寻址来源。直连和 Discovery 的候选快照共用 Selector，调用级过滤与重试不能暗中替换目标来源。这样不会出现首次选择后又被另一个地址选项覆盖的路径。

Discovery resolver 由 `@go-like/client/discovery` 共享：一套 watcher cache、retry、快照替换与关闭逻辑。把它移入 Registry 会因 Core 的 Context wait 依赖形成环；另写 gRPC watcher 又会复制故障路径。

服务身份按协议分开，例如 `orders-http` 与 `orders-grpc`。Core 在发布前核对本 App Endpointer 的 `protocol()`，该值用于本地注册校验，不依靠端口或调用失败猜测协议，也不能约束其他发布者滥用同一服务名。

## 注册与资源所有权

注册在首次 `endpoint()` / `start()` 的异步 I/O 前封闭：空表、重复注册和无有效 handler 的 route 在 bind 前失败，之后不能追加注册。这避免监听中的 dispatcher 被部分修改。

客户端对每个规范化 origin 延迟创建一个官方 `Http2SessionManager`。`abort()` 本身不是 owner 的永久关闭状态，因为原生 manager 可以重连；关闭路径需要同时禁止新请求、观察已接纳 acquisition，并终止迟到的 stream/retry 结果。

调用 Context 覆盖 Discovery、选择与网络工作，剩余预算不在阶段间重置。调用方取消 `close(ctx)` 的等待不撤销 owner 已经开始的清理。

服务端共享一次 bind，在停止时拒绝新工作、关闭 listener、排空已接纳 HTTP/2 session；超时后的强制关闭仍由持有原生资源的 owner 执行。wildcard bind 不能被当成可发布地址，advertise 由应用明确配置。

## 流完成与取消

- Unary 反馈在调用 Promise 结算时完成；流的 SelectionDone 在迭代结束、异常、取消或 owner close 时只完成一次，不能在返回初始 StreamResponse 时记为完成。
- 仅使用 async generator 包装不够：第一次 `next()` 前调用 `return()` 会跳过 generator body 和 `finally`。原设计使用显式迭代器在委托 `return()` / `throw()` 前取消。
- 原调查中的 Connect promise client 不向下传递服务端流和双向流的 `return()` / `throw()`；提前停止消费时由调用方取消 Context，不 fork 上游 client runtime。
- client-streaming 返回 `Promise<Response>`；server/bidi streaming 使用语言原生的 `AsyncIterable<Response>`，不增加自定义流抽象。

## TLS 与固定版本适配

证书与私钥成对配置，客户端身份验证需要 CA；h2c 不接受 TLS 配置。对端身份来自验证后的原生连接，不从请求头猜测。

原设计对 Connect Node 2.1.2 记录了两个适配原因：adapter 会原地写入 `acceptCompression`，因此提供独立可变的调用对象；带 options 的 service 注册可能重新启用其他协议，因此私下强制标准 gRPC 的协议开关。它们是固定版本的兼容理由，不是新增公共选项。

## 证据边界与演变

2026-08-28 的第一阶段偏重 portable handler 和生成胶水；随后独立定义了原生 HTTP/2 owner，并将包归入 Transport 能力域。早期“同一个根入口承载所有 runtime”及 `connection` / `conn` 命名没有作为当前契约继续保留。

2026-09-23 的原记录列出 Connect 2.1.2 deadline timer、Bun 1.4.2 Fetch cancellation、Deno 2.9.5/2.9.7 HTTP/2 drain 的限制。它们必须绑定当时版本与 workload，不能转述为当前所有版本的结论；本次整理没有重新执行实验。

## 一手源码与协议依据

- [Kratos transport 契约](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/transport.go#L16-L58)
- [Connect-ES 2.1.2 router](https://github.com/connectrpc/connect-es/blob/104238c58152e324ac16a99563f5eeea8ae7136d/packages/connect/src/router.ts#L77-L120)
- [gRPC-Web 协议](https://github.com/grpc/grpc/blob/58ea2e00fcc2502c06115f5d57c864c828826243/doc/PROTOCOL-WEB.md)
- [Connect gRPC-Web client 与 text mode 限制](https://github.com/connectrpc/connect-es/blob/104238c58152e324ac16a99563f5eeea8ae7136d/packages/connect-web/src/grpc-web-transport.ts#L117-L240)

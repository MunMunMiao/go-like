# `@go-like/web`

面向 go-like 请求处理器的可移植标准 Web API 桥接层。

该包在运行时导出 `contextHandler`；仅类型 API 包括 `Handler`、`ContextHandler` 和
`ContextHandlerOptions`。桥接层把 `Request.signal` 映射为私有的 `@go-like/context` Context，
同时原样保留处理器自己的 `Response` 或失败结果。

根入口不提供路由、中间件、Server-Sent Events 辅助函数或 WebSocket 升级控制；这些职责由运行时和框架包拥有。

公开入口按职责拆分：

- `@go-like/web`：只使用标准 `Request`、`Response`、`Headers` 与 `AbortSignal` 的可移植请求桥接层。
- `@go-like/web/health`：把 `@go-like/health` 的 probe registry 暴露为健康检查 Web handler。
- `@go-like/web/node`：基于 `@hono/node-server` 的 Node listener 生命周期。

Web 是对外 HTTP 服务入口；内部微服务通信属于 `@go-like/transport` 与具体传输实现，二者不混用。

## Node 生命周期宿主

`@go-like/web/node` 面向精确单参数 go-like `Handler` 提供受管 Node 生命周期宿主。HTTP Request/Response
转换、流式响应、Header 和未消费请求体清理由 `@hono/node-server` 2.0.12 提供；go-like 只拥有原生监听器
的启动、终态观察、调用方范围的停止等待与原生关闭超时。

该子路径显式关闭 `@hono/node-server` 的全局 Request/Response 覆盖，并保留未消费请求体自动清理。传给
应用的处理器始终只有一个 `Request` 参数；上游提供的 Node `HttpBindings` 不进入 go-like ABI。路由、
中间件、错误响应策略、WebSocket 和静态文件继续由应用及所选框架拥有。

`newNodeServer(handler, ...options)` 返回结构式 `Server`。`hostname`、`port` 与
`nodeShutdownTimeout` 都是返回新 `NodeServerOptions` 快照的 Go-style functional option，不修改调用方对象。
`nodeShutdownTimeout` 只接受 `0..2_147_483_647` 范围内的有限毫秒值，避免 Node 将超出平台定时器上限的延迟
降级为近乎立即执行。

`server.stop(ctx)` 只限制当前调用方的等待，并在共享关闭流程到达稳定终态后返回；终态失败由
`start(ctx)` 返回的完整运行期 Promise 报告。未经 owner shutdown 的原生 `close` 会以
`NodeServerUnexpectedCloseError` 拒绝，
硬超时会先记录 `NodeServerForceCloseError`，再请求 `closeAllConnections()` 和 socket `destroy()`；这些
force 调用只是停止请求，不是终态证据。只有原生 listener close 且所有已接纳 socket 都报告 close 后，
运行期 Promise 才会结算。若原生资源未收敛，该 Promise 保持 pending，应用级 `stopTimeout` 负责限制
整体停止等待，而适配器不会伪造终态。若关闭回调、`closeAllConnections()` 或 socket 销毁还产生独立错误，
运行期 Promise 会以主因作为 `cause`，
并按清理观察顺序通过 `AggregateError.errors` 报告；同一个 `Error` 实例只记录一次。

## 健康检查与框架组合

`createHealthHandler(registry, options)` 只响应配置的存活与就绪路径。它支持 GET/HEAD，使用 200/503 表达
probe 汇总状态，对未知路径返回 404，对其他方法返回 405 与 `Allow: GET, HEAD`，并始终设置 `no-store`。
probe 的私有错误不会进入响应；请求取消通过独立 Context 传递给 registry。

Hono、Elysia 与 H3 2.x 直接把原生 `app.fetch` 传给 `newNodeServer`，H3 1.x 使用官方
`toWebHandler(app)`。框架继续拥有路由、中间件、流和错误策略；go-like 不发布框架专用桥接包，只管理
listener 生命周期。

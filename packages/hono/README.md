# `@likego/hono`

`@likego/hono` 将原生 Hono 应用稳定绑定为 `@likego/web` Handler。它不重导出 Hono，也不代理 router、
middleware 或 server API；应用继续直接使用 Hono 配置路由。

`newHonoHandler(app)` 在构造时捕获并绑定原生 `app.fetch`。调用不会包装返回值或异常，因此同步/异步
Response、ReadableStream 与 Error identity 均由 Hono 原样保留。应用可把结果交给 `@likego/web/node`，
也可以交给任何自实现 Handler Server。

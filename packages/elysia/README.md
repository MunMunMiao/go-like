# `@likego/elysia`

`@likego/elysia` 将原生 Elysia 应用稳定绑定为 `@likego/web` Handler。它不重导出 Elysia，也不代理 router、
middleware 或 server API；应用继续直接使用 Elysia 配置路由。

`newElysiaHandler(app)` 在构造时捕获并绑定原生 `app.fetch`。调用不会包装返回值或异常，因此同步/异步
Response、ReadableStream 与 Error identity 均由 Elysia 原样保留。应用可把结果交给 `@likego/web/node`，
也可以交给任何自实现 Handler Server。

Elysia `1.4.29` 的声明在 TypeScript `7.0.2` 与 `exactOptionalPropertyTypes` 组合下存在上游泛型约束冲突。
本包只在自身 build/test project 设置 `skipLibCheck: true` 隔离第三方声明；LikeGo 源码和仓库根配置仍保持
完整严格检查。

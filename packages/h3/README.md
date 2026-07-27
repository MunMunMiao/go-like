# `@likego/h3`

`@likego/h3` 将原生 H3 应用稳定绑定为 `@likego/web` Handler。它不重导出 H3，也不代理 router、
middleware 或 server API；应用继续直接使用 H3 配置路由。

`newH3Handler(app)` 使用 H3 官方 `toWebHandler(app)` 转换标准 Fetch Handler。应用可把结果交给
`@likego/web/node`，也可以交给任何自实现 Handler Server。

H3 固定为 2026-07-25 最新正式版 `1.15.11`。本包只在自身 build/test project 设置
`skipLibCheck: true` 隔离第三方声明；LikeGo 源码和仓库根配置仍保持完整严格检查。

# Elysia 示例

Elysia 继续拥有路由并处理传入的标准 `Request`。应用把原生 `app.fetch` 直接交给 LikeGo 受管 Node
生命周期宿主；LikeGo 不提供框架专用桥接包，也不复制 Elysia router 或 middleware。

Elysia 1.4.29 的声明文件尚未通过 TypeScript 7 的精确可选属性检查。本示例使用 `skipLibCheck` 隔离该
上游声明问题；应用源码和 LikeGo 源码仍保持严格检查。Node HTTP 翻译由 `@hono/node-server` 提供，
不是 LikeGo 自研协议层。

源码按职责拆分：

- `src/routes.ts`：Elysia 的实际业务路由。
- `src/app.ts`：组合 Elysia router 并直接导出原生 `app.fetch` Handler。
- `src/main.ts`：唯一可执行入口，组合 Node Server、LikeGo App、监听地址和进程信号生命周期。
- `test/`：只导入 `app.ts` 提供的 Handler，不会执行 `main.ts`。

```sh
bun test examples/elysia/test
```

## 直接运行

在仓库根目录启动常驻 HTTP 服务：

```sh
bun run --cwd examples/elysia start
```

`start` 会先构建本地 LikeGo 包，再把 `src/main.ts` 构建为 `.artifacts/main.mjs`
并直接启动。看到 `LIKEGO_EXAMPLE_READY=...` 后，在另一个终端请求真实路由：

```sh
curl -sS http://127.0.0.1:3000/users/42
```

按 `Ctrl+C` 发送 `SIGINT`，或对进程执行 `kill -TERM <pid>`；LikeGo 会停止 HTTP Server 后退出。

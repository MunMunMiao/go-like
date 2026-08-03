# Hono 示例

Hono 继续拥有路由并暴露原生 `app.fetch`。应用把这个单参数 Handler 直接交给 `newNodeServer`；LikeGo
不提供框架专用桥接包，Node 宿主只拥有 listener 生命周期。Node HTTP 翻译复用 `@hono/node-server`，
但 LikeGo ABI 不暴露其 Node
`HttpBindings`、WebSocket 或静态文件扩展。

源码按职责拆分：

- `src/routes.ts`：Hono 的实际用户路由。
- `src/app.ts`：组合 Hono router 并直接导出原生 `app.fetch` Handler。
- `src/main.ts`：唯一可执行入口，组合 Node Server、LikeGo App、监听地址和进程信号生命周期。
- `test/`：只导入 `app.ts` 提供的 Handler，不会执行 `main.ts`。

```sh
bun test examples/hono/test
```

## 直接运行

在仓库根目录启动常驻 HTTP 服务：

```sh
bun run --cwd examples/hono start
```

`start` 会先构建本地 LikeGo 包，再把 `src/main.ts` 构建为 `.artifacts/main.mjs`
并直接启动。看到 `LIKEGO_EXAMPLE_READY=...` 后，在另一个终端请求真实路由：

```sh
curl -sS http://127.0.0.1:3000/users/42
```

按 `Ctrl+C` 发送 `SIGINT`，或对进程执行 `kill -TERM <pid>`；LikeGo 会停止 HTTP Server 后退出。

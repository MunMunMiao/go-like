# 原生 Fetch 示例

本示例的应用处理器只使用 `Request`、`Response` 和 `URL`。同一个单参数处理器直接传给
`newNodeServer`；LikeGo 不会添加路由器或 HTTP 协议实现。Node HTTP 翻译由 `@hono/node-server`
提供，LikeGo 只管理监听器生命周期。

源码按职责拆分：

- `src/routes.ts`：只使用标准 Web API 的实际请求处理函数。
- `src/app.ts`：创建可复用的标准 Fetch Handler，并保留包根公共入口。
- `src/main.ts`：唯一可执行入口，组合 Node Server、LikeGo App、监听地址和进程信号生命周期。
- `test/`：只导入 `app.ts` 提供的 Handler，不会执行 `main.ts`。

```sh
bun test examples/vanilla-web/test
```

## 直接运行

在仓库根目录启动常驻 HTTP 服务：

```sh
bun run --cwd examples/vanilla-web start
```

`start` 会先构建本地 LikeGo 包，再把 `src/main.ts` 构建为 `.artifacts/main.mjs`
并直接启动。看到 `LIKEGO_EXAMPLE_READY=...` 后，在另一个终端请求标准 Fetch Handler：

```sh
curl -sS http://127.0.0.1:3000/hello
```

按 `Ctrl+C` 发送 `SIGINT`，或对进程执行 `kill -TERM <pid>`；LikeGo 会停止 HTTP Server 后退出。

# H3 最新版 Fetch 示例

本示例与 `h3-node` E2E 固定使用 2026-08-03 npm `latest` dist-tag 对应的 H3
`2.0.1-rc.26`。它是用于跟踪上游最新兼容面的私有实验依赖，不进入 `packages/**` 的生产依赖基线。

示例使用 H3 2.x 的 `new H3()` 注册路由，并把原生 `app.fetch` 直接交给 go-like 的受管 Node 生命周期宿主。
H3 保持路由和请求处理所有权；go-like 不提供框架专用桥接包。

源码按职责拆分：

- `src/routes.ts`：H3 的实际状态路由。
- `src/app.ts`：组合 H3 router 并直接导出原生 Fetch Handler。
- `src/main.ts`：唯一可执行入口，组合 Node Server、go-like App、监听地址和进程信号生命周期。
- `test/`：只导入 `app.ts` 提供的 Handler，不会执行 `main.ts`。

```sh
bun test examples/h3/test
```

## 直接运行

在仓库根目录启动常驻 HTTP 服务：

```sh
bun run --cwd examples/h3 start
```

`start` 会先构建本地 go-like 包，再把 `src/main.ts` 构建为 `.artifacts/main.mjs`
并直接启动。看到 `GO_LIKE_EXAMPLE_READY=...` 后，在另一个终端请求真实路由：

```sh
curl -sS http://127.0.0.1:3000/status
```

按 `Ctrl+C` 发送 `SIGINT`，或对进程执行 `kill -TERM <pid>`；go-like 会停止 HTTP Server 后退出。

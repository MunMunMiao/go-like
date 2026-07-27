# H3 最新正式版 Fetch 示例

本示例固定使用 2026-07-25 最新正式版 H3 `1.15.11`。npm 默认 `latest` dist-tag 当前指向
`2.0.1-rc.26`，因为它仍是预发布版，所以不进入正式版依赖基线。

示例使用 H3 的 `createApp()`、`createRouter()` 和 `toWebHandler()` 标准能力注册路由，通过
`@likego/h3` 的 `newH3Handler(app)` 转换为单参数 Handler，再交给 LikeGo 的受管 Node 生命周期宿主。
H3 保持路由和请求处理所有权；框架适配包不提供业务门面。

源码按职责拆分：

- `src/routes.ts`：H3 的实际状态路由。
- `src/app.ts`：组合 H3 router 与 `@likego/h3` Fetch bridge，创建可复用 Handler。
- `src/main.ts`：唯一可执行入口，组合 Node Server、LikeGo App、监听地址和进程信号生命周期。
- `test/`：只导入 `app.ts` 提供的 Handler，不会执行 `main.ts`。

```sh
bun test examples/h3/test
```

## 直接运行

在仓库根目录启动常驻 HTTP 服务：

```sh
bun run --cwd examples/h3 start
```

`start` 会先构建本地 LikeGo 包，再把 `src/main.ts` 构建为 `.artifacts/main.mjs`
并直接启动。看到 `LIKEGO_EXAMPLE_READY=...` 后，在另一个终端请求真实路由：

```sh
curl -sS http://127.0.0.1:3000/status
```

按 `Ctrl+C` 发送 `SIGINT`，或对进程执行 `kill -TERM <pid>`；LikeGo 会停止 HTTP Server 后退出。

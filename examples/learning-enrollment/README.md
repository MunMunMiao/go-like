# 在线学习选课

## 主要演示

演示一个拆成两个服务边界的选课系统：外部 Enrollment API 接受标准 Fetch 请求，应用层通过 `@go-like/transport-memory` 调用内部 Capacity 服务预占课程席位，再保存选课结果。

## 独有业务不变量

- 课程剩余席位永远不能小于零。
- 同一 `requestId` 重试只占用一个席位，不同选课内容复用该 ID 必须冲突。
- 同一学习者不能用不同请求重复选中同一课程。
- Enrollment 只有在 Capacity 服务成功预占后才会保存结果。

## 调用链

```text
Fetch Request
  -> http.ts（公开 Enrollment API）
  -> service.ts（选课编排）
  -> transport.ts（Enrollment Repository）
  -> go-like Memory Transport
  -> internal Capacity Server
```

- `src/service.ts`：选课命令、幂等身份和 Context-first 选课用例。
- `src/transport.ts`：选课仓储、Capacity Server 和真实 Memory Transport Client。
- `src/http.ts`：标准 Fetch Handler。
- `src/runtime.ts`：组合公开 Handler，并暴露真实 Capacity Runtime 资源。
- `src/main.ts`：唯一创建 Core App 的可执行入口，按顺序挂载 Capacity 与 HTTP Server。
- `test/main.test.ts`：容量下界、幂等冲突、重复选课和传输边界测试。

## go-like 能力

本例实际使用 `@go-like/transport-memory` 的 `listen`、`dial`、`send`、`recv` 和关闭流程，并由 `@go-like/core` 承接内部 Server。测试通过真实内存传输执行席位预占，不是直接函数调用伪装 RPC。

## 验证

```bash
bun run --filter @go-like/example-learning-enrollment typecheck
bun run --filter @go-like/example-learning-enrollment test:unit
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @go-like/example-learning-enrollment start
```

看到 `GO_LIKE_EXAMPLE_READY` 后选修预置的 `course-1`：

```bash
curl -sS http://127.0.0.1:3000/v1/enrollments \
  -H 'content-type: application/json' \
  -d '{"requestId":"enroll-1","learnerId":"learner-1","courseId":"course-1"}'
```

请求会经过 Capacity Client、Memory Transport 与内部 Capacity Server。前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM` 可触发 Core 排空。

本例无需 Docker：Memory Transport 是 go-like 的真实进程内 provider，且没有外部中间件。它验证服务契约和生命周期，不宣称具备跨进程持久化能力。

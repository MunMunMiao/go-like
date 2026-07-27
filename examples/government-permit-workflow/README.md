# 政务许可审批工作流

## 主要演示

演示一个政务许可微服务：公开 Fetch API 负责受理和查询申请，独立审批 Worker 按许可证类型检查材料，并由 `@likego/core` 统一控制启动和停止。

## 独有业务不变量

- 同一 `applicationId` 和相同内容可安全重试，不同内容复用必须冲突。
- 审批 Worker 未启动或已经停止时不能处理申请。
- 餐饮许可必须包含身份证明、场地方案和消防材料。
- 装修许可材料完整时才能进入 `approved`，否则只能进入 `needs_information`。

## 源码结构

- `src/permits.ts`：许可政策、审批决定、申请仓储以及提交与查询操作。
- `src/worker.ts`：实现 LikeGo `Server` 的审批 Worker。
- `src/service.ts`：组合 Handler，并向入口暴露实现 LikeGo `Server` 的审批 Worker。
- `src/http.ts`：许可受理与查询的标准 Fetch 路由。
- `src/main.ts`：唯一 App 组装根，由 Core 按依赖顺序管理 Worker 和 HTTP Server。

## LikeGo 能力

本例实际由 `@likego/core` 启动和排空自定义结构式 Server。测试证明 Worker 在生命周期外拒绝处理、运行时完成审批，并在 `stop(ctx)` 后结束 `start(ctx)` 的运行期 Promise。

## 验证

```bash
bun run --filter @likego/example-government-permit-workflow typecheck
bun run --filter @likego/example-government-permit-workflow test
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @likego/example-government-permit-workflow start
```

`start` 会先构建本地 LikeGo 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。看到 `LIKEGO_EXAMPLE_READY` 后提交申请：

```bash
curl -sS http://127.0.0.1:3000/v1/permits \
  -H 'content-type: application/json' \
  -d '{"applicationId":"permit-1","applicantId":"citizen-1","permitType":"renovation","documents":["identity","site-plan"]}'
```

前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM`，Core 会同时排空 HTTP Server 与审批 Worker。

本例无需 Docker：仓储和 Worker 都是明确的进程内实现，没有声明外部政务平台、数据库或消息队列。

# 第三方原生生命周期适配实施计划

> **执行说明：** 按任务逐项实施并更新复选框；每项完成都必须有对应测试或运行证据。

**Goal:** 将 Croner、Node Fetch host、Pino、Winston、BullMQ 与 NATS 收敛为第三方原生对象的 `Server`
生命周期适配器。

**Architecture:** 第三方库拥有调度、HTTP 协议、路由、消息循环、ack、任务 processor、日志配置和业务 API；
go-like 接收应用创建的原生资源或 start factory，只把原生启动、停止、异常终态映射到稳定的 `ServerHandle`。
应用仍使用官方类型和 API，任何无法由上游可靠观测的终态都在 capability manifest 中如实降级。

**技术栈：** TypeScript 7.0.2、Bun 1.3.14、Node 24.18/26.5、Deno 2.9.3、Croner 10.0.1、`@hono/node-server` 2.0.12、Pino 10.3.1、Winston 3.19.0、Docker。

---

## 文件职责

- `adapters/cron-croner/src/server.ts`：Croner factory 的 one-shot start/stop/done 状态机。
- `adapters/cron-croner/src/types.ts`：只保留原生 factory 与 Server/Handle 类型，不复制 Croner 能力。
- `adapters/fetch-node/src/server.ts`：`@hono/node-server` 原生 listener 的监听、终态与排空。
- `adapters/fetch-node/src/testing.ts`：仅为故障测试注入原生 server factory。
- `adapters/log-pino-node/src/runtime.ts`：用户创建 Logger/destination 并在 start 接纳后的 flush、end、close、force 生命周期。
- `adapters/log-winston-node/src/server.ts`：用户创建 Logger 并显式移交后的 end/finish 生命周期。
- 四个 adapter 的 `test/`、`README.md`、`capability.json`、`owner.json`：锁定 API、所有权和真实能力声明。
- `examples/`：Vanilla、Hono、Elysia、H3 通过同一 Fetch adapter 的真实 listener 金丝雀。
- `test/published/`、`e2e/`：发布包与真实 runtime/网络验证，不重复测试供应商内部协议实现。
- `README.md`、`docs/adr/0003-resident-adapter-ownership.md`、`docs/capability-comparison.md`：中文说明统一的 native-first 边界。

### Task 1：Croner 只适配生命周期

**Files:**
- Modify: `adapters/cron-croner/src/types.ts`
- Modify: `adapters/cron-croner/src/server.ts`
- Modify: `adapters/cron-croner/src/index.ts`
- Modify: `adapters/cron-croner/src/errors.ts`
- Modify/Delete obsolete: `adapters/cron-croner/test/*.test.ts`
- Modify: `adapters/cron-croner/test/e2e/native-e2e.ts`
- Modify: `adapters/cron-croner/README.md`
- Modify: `adapters/cron-croner/capability.json`

- [x] **Step 1: 先写失败的公开契约测试**

锁定以下公共形状，且断言旧的 dialect、overlap、trigger、diagnostics 类型不再导出：

```ts
export type CronerFactory = (ctx: Context) => Cron | readonly Cron[]
export interface CronerServer extends Server {}
export function newCronerServer(factory: CronerFactory): CronerServer
```

- [x] **Step 2: 运行失败测试**

Run: `bun test --isolate --no-orphans adapters/cron-croner/test/*.test.ts`

Expected: 旧 facade 仍存在，新的 factory 生命周期用例失败。

- [x] **Step 3: 实现最小 one-shot 状态机**

factory 只能在 `start(ctx)` 内同步调用；结果必须非空、为官方 `Cron`、初始 paused、未 stopped、未 busy。成功时逐个 `resume()`；部分失败时反序 `stop()` 回滚。`stop(ctx)` 第一次调用执行共享 owner stop 并取消 runtime Context；每个 caller Context 只限制自身等待；`done()` 始终返回同一 Promise。

- [x] **Step 4: 用原生能力证明没有被 go-like 重写**

测试 `Date` 单次任务、`timezone`、`maxRuns`、`protect`、`context`、原生 `trigger()` 与 callback 参数。Croner 无 passive terminal 和可靠 callback drain，因此 `capability.json` 将其作为 v1 `releaseBlocking:true` 能力，同时保持 `terminalObservability:"unobservable"`；README 明确 stop 只阻止未来调度。

- [x] **Step 5: 验证 package**

Run: `bun run --cwd adapters/cron-croner typecheck && bun run --cwd adapters/cron-croner test && bun run --cwd adapters/cron-croner build && bun run --cwd adapters/cron-croner smoke:node`

Expected: 全部退出 0。

### Task 2：Node Fetch host 交给 @hono/node-server

**Files:**
- Modify: `adapters/fetch-node/package.json`
- Rewrite: `adapters/fetch-node/src/server.ts`
- Modify: `adapters/fetch-node/src/index.ts`
- Modify: `adapters/fetch-node/src/testing.ts`
- Delete: `adapters/fetch-node/src/request.ts`
- Delete: `adapters/fetch-node/src/response.ts`
- Rewrite: `adapters/fetch-node/test/http.test.ts`
- Modify: `adapters/fetch-node/test/lifecycle.test.ts`
- Modify: `adapters/fetch-node/test/e2e/native-e2e.ts`
- Modify: `adapters/fetch-node/README.md`
- Modify: `examples/*/src/app.ts`

- [x] **Step 1: 写失败测试证明协议转换已退出 go-like**

测试公开入口只接收 `FetchHandler` 与生命周期 functional options；`request.ts`/`response.ts` 不再进入 source inventory。真实网络用例分别传 Vanilla、Hono `app.fetch`、Elysia handler、H3 `app.fetch`。

- [x] **Step 2: 运行失败测试**

Run: `bun test --isolate --no-orphans adapters/fetch-node/test`

Expected: 旧 `node:http` bridge 暴露了不再允许的职责。

- [x] **Step 3: 实现原生 host 生命周期**

默认使用 `createAdaptorServer({ fetch, hostname, overrideGlobalObjects:false, autoCleanupIncoming:true })` 创建原生 Server；在 `listen` 前安装 `error`、`close`、`connection` observer。保留 `hostname`、`port`、`hardDrainTimeout` 和地址快照，因为它们属于 host 生命周期；删除 handler error policy、Request 构造、Response 写回和 body pipeline。

- [x] **Step 4: 验证 graceful/force/终态**

测试 accepted 前取消、listen error、稳定 `done()`、并发 caller-scoped stop、原生意外 close、hard timeout socket force、首因保留和 listener/socket 清理。

- [x] **Step 5: 验证 package 与四个框架**

Run: `bun run --cwd adapters/fetch-node typecheck && bun run --cwd adapters/fetch-node test && bun run --cwd adapters/fetch-node build && bun run --cwd adapters/fetch-node e2e:node`

Expected: 全部退出 0，真实 listener 响应来自四种标准 Fetch handler。

### Task 3：Pino 由应用创建原生资源

**Files:**
- Rewrite: `adapters/log-pino-node/src/types.ts`
- Rewrite: `adapters/log-pino-node/src/runtime.ts`
- Modify: `adapters/log-pino-node/src/index.ts`
- Delete obsolete: `adapters/log-pino-node/src/testing.ts`
- Delete obsolete: `adapters/log-pino-node/src/thread-stream-compat.ts`（若最新类型不再需要）
- Rewrite: `adapters/log-pino-node/test/*.test.ts`
- Modify: `adapters/log-pino-node/README.md`
- Modify: `adapters/log-pino-node/owner.json`

- [x] **Step 1: 写失败的 native factory 契约测试**

公共入口固定为：

```ts
import pino from "pino"

export function newPinoServer(
  logger: pino.Logger,
  destination: ReturnType<typeof pino.destination> | ReturnType<typeof pino.transport>,
  ...options: readonly PinoServerOption[]
): PinoServer
```

断言不再导出 Pino logger options、路径/stdout/stderr destination 选择或 borrowed constructor。

- [x] **Step 2: 运行失败测试**

Run: `bun test --isolate --no-orphans adapters/log-pino-node/test/*.test.ts`

Expected: 旧 `newPinoRuntime`/`newPinoWithBorrowedDestination` 契约失败。

- [x] **Step 3: 实现 destination 生命周期映射**

应用先用官方 API 创建并持有 Logger，再将 destination 生命周期显式移交给 `newPinoServer`；Server 不返回
或包装 logger。stop 顺序为 `logger.flush(callback)`、`destination.end()`、等待原生 `close`；destination
`error` 使稳定 `done()` reject。adapter hard timeout 只结算 stop waiter，并在公开 `destroy()` 存在时尽力
调用一次；真实 `close` 之前 `done()` 继续 pending。adapter 不打开路径、不创建 Pino logger、不选择
transport。

- [x] **Step 4: 用官方 destination/transport 验证**

覆盖 `pino.destination({ dest, sync:false })`、`pino.transport(...)`、factory/listener/flush/end error、caller Context 取消、并发 stop、hard force 和 logger custom levels 类型保持。

- [x] **Step 5: 验证 package**

Run: `bun run --cwd adapters/log-pino-node typecheck && bun run --cwd adapters/log-pino-node test && bun run --cwd adapters/log-pino-node build && bun run --cwd adapters/log-pino-node smoke:node`

Expected: 全部退出 0。

### Task 4：Winston 只接管原生 Logger 排空

**Files:**
- Create: `adapters/log-winston-node/src/*.ts`
- Create: `adapters/log-winston-node/test/*.test.ts`
- Create: `adapters/log-winston-node/test/smoke/runtime-smoke.ts`
- Create: `adapters/log-winston-node/README.md`
- Create: `adapters/log-winston-node/capability.json`
- Create: `adapters/log-winston-node/owner.json`

- [x] **Step 1: 锁定最小公共 API**

根入口只导出 `newWinstonServer(logger)` 与生命周期错误/Server 类型；不复制 logger options、format、level、
transport 或 child logger API。

- [x] **Step 2: 映射真实 end/finish 语义**

owner stop 只调用一次 `logger.end()` 并等待真实 `finish`；原生 error 保留标识，stop 前 finish 与排空前
close 都属于意外终态。adapter 不调用 `logger.close()`、不枚举 transport、不伪造 force。

- [x] **Step 3: 验证 package 与真实 File transport**

Bun 单元测试和覆盖率、严格类型检查、构建均通过；Bun 1.3.14、Node 24.18.0、Node 26.5.0 均通过真实
Winston File transport 构建产物烟测。

### Task 5：同步发布测试、E2E 与中文文档

**Files:**
- Modify: `test/published/cases/node-services.ts`
- Modify: `test/published/cases/integrations.ts`
- Modify: `e2e/suites.ts`
- Modify: `e2e/cases/*.case.ts`
- Modify: `README.md`
- Modify: `docs/adr/0003-resident-adapter-ownership.md`
- Modify: `docs/capability-comparison.md`
- Modify: `docs/file-inventory.md`（通过生成器）

- [x] **Step 1: 删除锁定旧 facade 的发布用例**

发布包只验证类型导出、factory start/stop/done 与供应商原生对象兼容，不再把 Cron 调度策略、Node HTTP 协议转换、Pino 文件打开当作 go-like 行为。

- [x] **Step 2: 重写真实 E2E 场景和证据描述**

保留真实 listener/runtime 测试；外部协议才使用 Docker。Croner/Pino/Hono host 都是进程内或真实 socket，不为“看起来更真实”而套没有外部依赖的容器。

- [x] **Step 3: 更新中文主交付文档**

README 与 ADR 明确统一公式：`第三方原生能力 + go-like structural Server lifecycle`；给出用户自实现 Server、Croner factory、Hono/Elysia/H3 Fetch handler、Pino transport factory 示例及所有权限制。

- [ ] **Step 4: 全量验证并清理生成物**

Run: `bun install --frozen-lockfile && bun run clean:generated && bun run verify`

Expected: frozen install 成功；manifest、boundary、typecheck、unit、coverage、build、published、native runtime、E2E 和 Docker gates 全部退出 0；生成文件清单与工作区真实文件一致。

- [ ] **Step 5: 团队独立合理性审查**

审查者分别检查：（1）是否仍复制第三方业务 API；（2）Server/Context/所有权是否自洽；（3）真实测试是否只声称已证明的能力。所有阻断意见修复并重新执行对应 gate 后才交付。

### Task 6：NATS 与 BullMQ 退出业务数据面

**Files:**
- Rewrite: `adapters/nats-core-node/src/*`
- Rewrite: `adapters/nats-jetstream-node/src/*`
- Rewrite: `adapters/job-bullmq-node/src/*`
- Rewrite: 三个 adapter 的 `test/`、`README.md`、`capability.json`、`owner.json` 与 Docker E2E
- Modify: `test/published/cases/node-services.ts`
- Modify: `README.md`、设计规范与 ADR 0003

- [ ] **Step 1: 收窄公共 API**

NATS Core 只接收原生 `Subscription` 或 start factory；JetStream 只接收原生 `ConsumerMessages` 或 start
factory；BullMQ 只接收应用创建的官方 `autorun:false` Worker 或 start factory。根入口不再暴露 handler、
processor wrapper、queue、ack、DLQ 或 WorkerOptions facade。

- [ ] **Step 2: 只保留生命周期状态机**

Core 只映射 drain/unsubscribe/closed；JetStream 只映射 close/stop/closed；BullMQ 只映射
run/readiness/pause/close/terminal。start 接纳、回滚、caller-scoped wait、owner boundary 与稳定 `done()` 继续
遵循 Core 契约。

- [ ] **Step 3: 重写真实服务门禁**

NATS 2.14.3 与 Redis 8.8.0 场景由应用使用官方 API 建立业务对象和消费逻辑，再证明 adapter 只管理其生命
周期且不会关闭借用的 connection/client/durable。NATS SDK 版本必须从实际安装的 package metadata 读取，
不能硬编码成预期值。

- [ ] **Step 4: 发布消费与独立复审**

外部 consumer 只能从真实 tarball 按包名导入新的原生类型边界；生命周期审查者必须确认三个根入口没有
重新引入消息循环、ack/DLQ、Queue/Job 或 Context processor。

## 执行约束

本计划按主人要求直接在真实路径 `main` 工作，不创建 worktree 或 feature 分支。未经主人明确要求，不执行 `git add`、`git commit`、push、PR 或发布。

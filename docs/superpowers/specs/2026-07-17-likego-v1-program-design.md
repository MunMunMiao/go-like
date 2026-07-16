# LikeGo v1 Program Design

日期：2026-07-17

状态：APPROVED FOR IMPLEMENTATION

## 1. 目标

LikeGo 是一套以 Go 风格使用 TypeScript 的后端微服务工具包。它提供显式 Context、可组合的
App/Server 生命周期、标准一参 Fetch transport，以及 Cron、Durable Job、Broker、Config、Logging、
Observability、Health 等热门组件。它不是 Web 框架，也不提供前端能力、gRPC 或 Protobuf。

v1 的完成条件不是“存在对应目录”，而是每个 release-blocking package 已通过自己的类型、行为、
故障、恢复、清理和独立审查门禁；所有单元测试统计维度达到 100%；真实外部协议由 Docker E2E
验证；最终联网收集并实现不少于 40 个去重后的实际使用用例。

## 2. 设计原则

1. 开发、依赖安装、脚本编排和单元测试统一使用 Bun；`bun.lock` 必须提交并支持 frozen install。
2. portable packages 的 production source 只使用标准 Web API 和 ECMAScript，不 import `node:`、Bun、
   Deno、Web 框架或供应商 SDK。
3. runtime/vendor 能力放在独立 adapter，使用 conditional exports 和 capability manifest fail closed。
4. API 保持 Go 风格：Context 独立首参、PascalCase 方法、小接口、显式错误、显式 lifecycle owner、
   structural typing；不使用 decorator、reflection、DI 容器或 ambient request context。
5. 第三方业务 API native-first。LikeGo 不逐方法镜像 Pino、NATS、BullMQ 或 OpenTelemetry。
6. lifecycle object 只有一个 owner。managed raw server/worker/consumer/provider 不对业务暴露；需要完整
   raw 控制时，用户自行实现 structural Server 并成为唯一 owner。
7. 所有 production behavior 必须先出现预期失败的测试，再写最小实现；bug 也必须先写复现测试。
8. fake 只证明内存逻辑。listener、broker、Redis、config center、telemetry exporter 等外部事实必须
   使用真实 runtime 或 Docker 服务。

## 3. Monorepo 边界

```text
packages/
  context/                 Go-observable Context
  core/                    App, Server, ServerHandle, lifecycle errors
  fetch/                   FetchHandler and explicit Context bridge
  health/                  Probe registry and Fetch endpoints
  config/                  snapshots, merge, watch and validation contracts
  testing/                 reusable conformance suites and fixtures

adapters/
  fetch-srvx-node/         first managed Node Fetch host
  cron-croner-node/        in-process cron
  job-bullmq-node/         Redis durable jobs
  nats-core-node/          NATS Core subscriptions
  nats-jetstream-node/     JetStream consumers
  config-env/              environment source
  config-file/             file source
  config-consul/           Consul KV/watch
  log-pino-node/           Pino lifecycle policy
  otel-node/               OpenTelemetry provider/exporter lifecycle
  metrics-prom-client-node/ Prometheus registry and Fetch scrape

examples/
  vanilla-fetch/
  hono/
  elysia/
  h3-canary/

e2e/
  cases/                   one manifest and runner per sourced use case
  compose/                 isolated real-service fixtures
  scripts/                 Bun-driven orchestration and cleanup
  evidence/                source URLs and normalized provenance
```

Dependencies point inward: adapters depend on packages; portable packages never depend on adapters. `context` is
independent. `core` depends only on `context`. `fetch` depends only on `context`. `health` depends on `context` and
`fetch`. `testing` may depend on public contracts but production packages never depend on `testing`.

## 4. Context contract

```ts
export interface Context {
  Deadline(): readonly [Date, boolean]
  Done(): AbortSignal | null
  Err(): ContextError | null
  Value(key: unknown): unknown
}

export interface ContextError extends Error {}

export interface TimeoutContextError extends ContextError {
  Timeout(): boolean
  Temporary(): boolean
}

export const Canceled: ContextError
export const DeadlineExceeded: TimeoutContextError

export type CancelFunc = () => void
export type CancelCauseFunc = (cause: Error | null) => void

export function Background(): Context
export function TODO(): Context
export function WithCancel(parent: Context): readonly [Context, CancelFunc]
export function WithCancelCause(parent: Context): readonly [Context, CancelCauseFunc]
export function WithDeadline(parent: Context, deadline: Date): readonly [Context, CancelFunc]
export function WithDeadlineCause(
  parent: Context,
  deadline: Date,
  cause: Error | null,
): readonly [Context, CancelFunc]
export function WithTimeout(parent: Context, timeoutMs: number): readonly [Context, CancelFunc]
export function WithTimeoutCause(
  parent: Context,
  timeoutMs: number,
  cause: Error | null,
): readonly [Context, CancelFunc]
export function WithValue(parent: Context, key: unknown, value: unknown): Context
export function WithoutCancel(parent: Context): Context
export function Cause(ctx: Context): Error | null
export function AfterFunc(ctx: Context, fn: () => void): () => boolean
```

公开能力和可观察语义与 Go `context` 对齐：父取消传播、子取消不反向传播、第一次取消/原因获胜、
父子较早 deadline、稳定 `Done()`、`Err()` 仅返回哨兵、`Cause()` 返回自定义原因、`WithoutCancel()`
保留值但切断 deadline/cancel、`AfterFunc()` 与 stop 竞争只有一个赢家、timer/listener 必须清理。

无法伪装相同的宿主差异必须写入文档：`AbortSignal` 不是 closed channel，late listener 要先检查
`aborted`；Date 只有毫秒精度；AfterFunc 使用 microtask 而不是 goroutine；value key 使用 JS identity。

## 5. Server 与 App contract

```ts
export interface Server<H extends ServerHandle = ServerHandle> {
  Start(ctx: Context): Promise<H>
}

export interface ServerHandle {
  Done(): Promise<void>
  Stop(ctx: Context): Promise<void>
}
```

任何用户对象只要结构化实现该 shape，就能注册到 App，无需继承或 decorator。

硬语义：

1. Server 实例 one-shot；Start 成功或失败后都不能再次 Start。
2. `Start(ctx)` resolve 是 accepted 线性化点。accepted 前 Context 可取消启动；accepted 后 startup
   Context 不再拥有运行期。
3. `Done()` 每次返回同一个 Promise；clean Stop resolve；unexpected exit、forced close 或 cleanup
   failure reject。
4. 第一次 `Stop` 创建唯一 owner drain task，并发 caller 只 join。
5. 每个 `Stop(ctx)` 的 Context 只限制当前 caller 的等待，绝不能 force 共享服务。
6. 只有 adapter 自己的 `HardDrainTimeoutMs` 到期才 force；无法终止的 Promise 计入 orphan diagnostics。
7. App 按注册顺序 Start，startup failure 反序 rollback；运行期首个 child failure 触发全局 drain；cleanup
   errors 聚合但不覆盖原始 failure。
8. Workers 使用平台事件模型，不伪装进程型 ServerHandle。

## 6. Fetch transport

HTTP 主 ABI 只有：

```ts
export type FetchHandler = (
  request: Request,
) => Response | Promise<Response>
```

LikeGo 不提供 router。Vanilla 传函数，Hono 传 `app.fetch`，Elysia 传 `app.handle`，H3 传 `app.fetch`。
需要 Go-style domain Context 时显式使用：

```ts
export type ContextHandler = (
  ctx: Context,
  request: Request,
) => Response | Promise<Response>

export interface ContextHandlerOptions {
  readonly TimeoutMs?: number
}

export function ToFetchHandler(
  handler: ContextHandler,
  options?: ContextHandlerOptions,
): FetchHandler
```

bridge 将 `Request.signal` 映射为 Context cancel；只有显式 TimeoutMs 才产生可查询 deadline。禁止
AsyncLocalStorage、WeakMap ambient map、Request mutation、body buffering 和 Response 重建。

首个 Node host 可使用 srvx；若无法满足 caller-scoped Stop 与独立 owner hard budget，则保留 Fetch ABI
改用 Node native host。Bun 常驻 host 在被动 unexpected-terminal primitive 未闭合前不发布。

## 7. Health

Health 是 portable package，提供注册表和 `/livez`、`/readyz` Fetch handler。probe 并发执行但输出按
注册顺序；每个 probe 有独立 timeout；reject、parent cancel 和 request abort 被隔离；公共响应不泄漏
地址、凭据、stack 或原始错误。支持 GET/HEAD，其他方法 405，未知路径 404，响应 `no-store`。

## 8. v1 release-blocking adapters

- Croner：显式 timezone/dialect；默认 overlap skip；job failure 不终止 scheduler；Stop drain active job。
- BullMQ：业务 owns raw Queue，processor receives raw Job，managed Worker private；真实 Redis 证明 retry、
  stalled recovery、outage/recovery、non-cooperative force 和 connection cleanup。
- NATS Core：managed subscription private，handler receives raw Msg；明确 at-most-once。
- NATS JetStream：managed consumer/iterator private，handler receives raw JsMsg；PubAck、MaxDeliver、DLQ
  publish-ack-before-term、ack pending zero 和 reconnect 必须真实验证。
- Config：object/env/file/Consul；initial load、watch accepted 后 reconcile、serialized reload、validate before
  atomic swap、last-good、terminal WatchHandle。
- Pino：业务使用 raw Logger；destination ownership 显式 borrowed/owned；外部 flush 与 Stop 排序有 gate；
  owned destination close mutator 不暴露。
- OpenTelemetry：业务只使用官方 API Tracer/Meter；provider/exporter private；Collector down 不阻塞业务，
  exporter failure bounded，恢复后可继续 export，Stop flush/shutdown。
- Prometheus：独立 Registry；Fetch scrape；重复注册、低基数 label、并发 scrape 和 cleanup 有 gate。

BullMQ 虽位于 contrib 通道，仍是 v1 release-blocking beta。以上任何正式 package 未至少达到自己的
provisional gate，v1.0 都不发布空壳或虚假支持声明。

## 9. 测试与覆盖率

1. 单元测试使用 `bun test`，所有 production source 的 line、function、branch/statements 覆盖率达到
   100%；generated files、类型声明和纯 re-export 只能以明确、审查过的规则排除。
2. portable behavior 必须在 Bun、Node current/LTS、Deno 最新固定版本上运行；使用 Bun 编排，不能把
   “Bun 单测通过”外推为跨 runtime 通过。
3. external protocol 使用 Docker：NATS、Redis、Consul、OTel Collector，以及最终能力差距补充所需服务。
4. runner 使用唯一 project name、随机端口、统一 label 和 `try/finally` cleanup；完成后 container、network、
   volume、listener、timer、subscription、connection 都回到基线。
5. E2E 用例在代码完成后由团队联网收集，至少 40 个；每个保留 source URL、retrieved-at、license/quote
   boundary、能力域、normalized scenario、runtime/services、assertions 和 cleanup evidence。
6. 40 个用例必须去重并覆盖 Web、Context/cancel、Cron、Durable Job、NATS、Config、Logging、Telemetry、
   Health、custom Server、failure/recovery 和 graceful shutdown，不得用参数变化凑数。
7. E2E 使用 Bun 脚本和 Docker Compose，输出 machine-readable result；失败不可被 aggregate 脚本硬编码覆盖。

## 10. 完整交付顺序

1. Bun monorepo、版本/owner/capability manifests、coverage 和 import-boundary gates。
2. Context。
3. App/ServerHandle/testing lifecycle conformance。
4. Fetch bridge、Health、Node Fetch host。
5. Croner、Config env/file/Consul、Pino。
6. NATS Core/JetStream、BullMQ。
7. OpenTelemetry/Prometheus。
8. 跨 runtime 与真实 Docker package gates。
9. 团队联网收集并实现至少 40 个真实 E2E 用例。
10. 100% 单元覆盖审计、全量 fault/recovery、独立最终 review。
11. 重新对比最新 Go Micro、Go Kratos 能力矩阵，识别缺失工具包；每个新增能力重复 design -> TDD ->
    real-service gate -> review，直至差距补齐或被明确记录为不适用于 LikeGo 的非目标。

## 11. 明确非目标

- gRPC、Protobuf、私有 RPC/codegen。
- 自建 Web router、统一 middleware DSL、OpenAPI generator。
- 一个覆盖所有 broker/job system 的 Message/Ack 接口。
- ORM/store、前端 DOM、agent/AI/MCP/flow。
- exactly-once、Context 能强杀任意 Promise、所有 runtime 自动支持所有 adapter 等虚假保证。

## 12. 决策状态

本设计继承并收敛 2026-07-16 的三项目源码调研、跨 runtime Fetch 实践、Context/ServerHandle TDD、
NATS/Redis/Consul/Collector Docker 实践及独立架构审查。用户已在 2026-07-17 明确要求开始实现，
因此该设计的用户审批门已满足；后续变化必须通过 ADR 和新的失败测试进入，不能在 adapter 内静默例外。

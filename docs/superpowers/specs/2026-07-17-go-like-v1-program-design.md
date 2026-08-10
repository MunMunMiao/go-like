# go-like v1 方案设计

日期：2026-07-17

状态：已批准实施

## 1. 目标

go-like 是一套以 Go 风格使用 TypeScript 的后端微服务工具包。它提供显式 Context、可组合的
App/Server 生命周期、标准一参 Fetch transport，以及 Cron、Durable Job、Broker、Config、Logging、
Observability、Health、Retry/Backoff、Circuit Breaker、Rate Limiter 等热门组件。它不是 Web 框架，也不
提供前端能力、gRPC 或 Protobuf。

v1 的完成条件不是“存在对应目录”，而是每个 release-blocking package 已通过自己的类型、行为、
故障、恢复、清理和独立审查门禁；所有单元测试统计维度达到 100%；真实外部协议由 Docker E2E
验证；最终联网收集并实现不少于 40 个去重后的实际使用用例。

## 2. 设计原则

1. 开发、依赖安装、脚本编排和单元测试统一使用 Bun；`bun.lock` 必须提交并支持 frozen install。
2. portable packages 的 production source 只使用标准 Web API 和 ECMAScript，不 import `node:`、Bun、
   Deno、Web 框架或供应商 SDK。
3. runtime/vendor 能力放在独立 adapter，使用 conditional exports 和 capability manifest fail closed。
4. API 保持 Go 风格：Context 独立首参、lowerCamelCase 函数/方法/导出值、PascalCase 类型/接口/错误类型、
   小接口、显式错误、显式 lifecycle owner、structural typing；不使用 decorator、reflection、DI 容器或
   ambient request context。
5. 第三方业务 API native-first。go-like 不逐方法镜像 Croner、Pino、Winston、Web 框架、NATS、BullMQ 或
   OpenTelemetry，也不复制它们的配置、调度、路由、日志和诊断语义。
6. adapter 只把第三方对象的原生启动、停止和终态映射为 `Server`/`ServerHandle`。应用继续通过第三方
   原生对象使用全部业务能力；需要完整自定义时，用户只需实现 structural Server，无需继承 go-like 类型。
7. lifecycle object 只有一个 owner。由 adapter factory 在 `start(ctx)` 内创建，或在 adapter 构造时显式
   移交的资源归 adapter 管理；application-owned 对象不得被 adapter 擅自关闭。同一个原生资源不能同时
   被应用和 go-like 管理。
8. 所有 production behavior 必须先出现预期失败的测试，再写最小实现；bug 也必须先写复现测试。
9. fake 只证明内存逻辑。listener、broker、Redis、config center、telemetry exporter 等外部事实必须
   使用真实 runtime 或 Docker 服务。
10. 所有开发源码、测试和工具均使用 TypeScript；内部相对 module specifier 不带扩展名。`dist` 仅是
    Git-ignored 的构建/发布瞬态产物，不得作为开发类型检查或业务测试输入。

## 3. Monorepo 依赖边界

```text
packages/
  context/                 Go-observable Context
  core/                    App, Server, ServerHandle, lifecycle errors
  fetch/                   FetchHandler and explicit Context bridge
  health/                  Probe registry and Fetch endpoints
  config/                  snapshots, merge, watch and validation contracts
  registry/                service instances, registration/discovery and selection
  resilience/              explicit retry/backoff, circuit breaker and token-bucket limiter
  testing/                 reusable conformance suites and fixtures

adapters/
  fetch-node/              Node Fetch host lifecycle adapter
  cron-croner/             native Croner lifecycle adapter
  job-bullmq-node/         Redis durable jobs
  nats-core-node/          NATS Core subscriptions
  nats-jetstream-node/     JetStream consumers
  config-env/              environment source
  config-file/             file source
  config-consul/           Consul KV/watch
  log-pino-node/           native Pino destination lifecycle adapter
  log-winston-node/        native Winston logger lifecycle adapter
  otel-node/               OpenTelemetry provider/exporter lifecycle
  metrics-prom-client-node/ Prometheus registry and Fetch scrape
  registry-consul/         Consul Agent registration, TTL and health discovery

examples/
  vanilla-fetch/
  hono/
  elysia/
  h3-canary/

e2e/
  cases/                   one manifest and runner per sourced use case
  scripts/                 Bun-driven orchestration and native scenarios
  evidence/                source URLs and normalized provenance
```

依赖只向内收敛：adapter 依赖 package；portable package 永不依赖 adapter。`context` 保持独立；`core` 只依赖
`context`；`fetch` 只依赖 `context`；`health` 在运行时依赖 `context` 与 `fetch`，并以 type-only 方式依赖
`core`；`resilience` 只依赖 `context`。`testing` 可以依赖公共契约，但 production package 永不依赖
`testing`。

## 4. Context 契约

```ts
export interface Context {
  deadline(): readonly [Date, boolean];
  done(): AbortSignal | null;
  err(): ContextError | null;
  value(key: unknown): unknown;
}

export interface ContextError extends Error {}

export interface TimeoutContextError extends ContextError {
  timeout(): boolean;
  temporary(): boolean;
}

export const canceled: ContextError;
export const deadlineExceeded: TimeoutContextError;

export type CancelFunc = () => void;
export type CancelCauseFunc = (cause: Error | null) => void;

export function background(): Context;
export function todo(): Context;
export function withCancel(parent: Context): readonly [Context, CancelFunc];
export function withCancelCause(
  parent: Context,
): readonly [Context, CancelCauseFunc];
export function withDeadline(
  parent: Context,
  deadline: Date,
): readonly [Context, CancelFunc];
export function withDeadlineCause(
  parent: Context,
  deadline: Date,
  cause: Error | null,
): readonly [Context, CancelFunc];
export function withTimeout(
  parent: Context,
  timeoutMs: number,
): readonly [Context, CancelFunc];
export function withTimeoutCause(
  parent: Context,
  timeoutMs: number,
  cause: Error | null,
): readonly [Context, CancelFunc];
export function withValue(
  parent: Context,
  key: unknown,
  value: unknown,
): Context;
export function withoutCancel(parent: Context): Context;
export function cause(ctx: Context): Error | null;
export function afterFunc(ctx: Context, fn: () => void): () => boolean;
```

公开能力和可观察语义与 Go `context` 对齐：父取消传播、子取消不反向传播、第一次取消/原因获胜、
父子较早 deadline、稳定 `done()`、`err()` 仅返回哨兵、`cause()` 返回自定义原因、`withoutCancel()`
保留值但切断 deadline/cancel、`afterFunc()` 与 stop 竞争只有一个赢家、timer/listener 必须清理。

无法伪装相同的宿主差异必须写入文档：`AbortSignal` 不是 closed channel，late listener 要先检查
`aborted`；Date 只有毫秒精度；`afterFunc` 使用 microtask 而不是 goroutine；value key 使用 JS identity。
此外，标准 Web API 无法让被冻结或挂起的宿主在暂停期间执行 timer；go-like 只对发布门禁覆盖的持续运行
后端进程验证 deadline 行为，不把源码可移植性夸大为所有宿主调度完全相同。

## 5. Server 与 App 契约

```ts
export interface Server<H extends ServerHandle = ServerHandle> {
  start(ctx: Context): Promise<H>;
}

export interface ServerHandle {
  done(): Promise<void>;
  stop(ctx: Context): Promise<void>;
}
```

任何用户对象只要结构化实现该 shape，就能注册到 App，无需继承或 decorator。

硬语义：

1. Server 实例 one-shot；`start` 成功或失败后都不能再次调用。
2. `start(ctx)` resolve 是 accepted 线性化点。accepted 前 Context 可取消启动；accepted 后 startup
   Context 不再拥有运行期。
3. `done()` 每次返回同一个 Promise；clean `stop` resolve；unexpected exit、已确认的 forced terminal 或
   cleanup failure reject。timeout 只有在原生终态已经收敛时才能结算 `done()`。
4. 第一次 `stop` 创建唯一 owner drain task，并发 caller 只 join。
5. 每个 `stop(ctx)` 的 Context 只限制当前 caller 的等待，绝不能 force 共享服务。
6. 只有 adapter 自己的 `hardDrainTimeoutMs` 到期才允许调用其声明的公开 force 原语；timeout 不等于底层
   terminal。没有 force、force 抛错或 force 后未终止的 Promise 必须保持可观察，并计入 orphan diagnostics。
7. App 按注册顺序 `start`，startup failure 反序 rollback；运行期首个 child failure 触发全局 drain；cleanup
   errors 聚合但不覆盖原始 failure。
8. Workers 使用平台事件模型，不伪装进程型 ServerHandle。

默认 timeout policy 固定为：整个 App 的反向 drain 共享 `30_000ms` 单调总预算，每个 Server 另有
`30_000ms` 局部预算，实际使用较早 deadline；具备安全公开 force 的 go-like-owned resident adapter 在
`25_000ms` 尝试 force。五秒余量用于实际 terminal 传播与 supervisor 清理，禁止依赖相同 deadline timer
的调度顺序。`stop()` 超时是 lifecycle failure，但只有 deadline 时仍未 terminal 的 `done()` 才进入 orphan
diagnostics。无可信 force 的 adapter 不设置伪终态；存在 adapter bound 时，应用自定义的 App 总预算必须
严格更大。

## 6. Fetch 传输层

HTTP 主 ABI 只有：

```ts
export type FetchHandler = (request: Request) => Response | Promise<Response>;
```

go-like 不提供 router。Vanilla 传函数，Hono、Elysia、H3 都传各自的 `app.fetch`。
需要 Go-style domain Context 时显式使用：

```ts
export type ContextHandler = (
  ctx: Context,
  request: Request,
) => Response | Promise<Response>;

export interface ContextHandlerOptions {
  readonly timeoutMs?: number;
}

export function toFetchHandler(
  handler: ContextHandler,
  options?: ContextHandlerOptions,
): FetchHandler;
```

bridge 将 `Request.signal` 映射为 Context cancel；只有显式 `timeoutMs` 才产生可查询 deadline。禁止
AsyncLocalStorage、WeakMap ambient map、Request mutation、body buffering 和 Response 重建。

首个 managed Node host 使用包内 Node Fetch bridge 承接标准 Fetch ABI。go-like 拥有
`IncomingMessage`/`ServerResponse` 与 Web API 的协议转换，但不复制框架 router/middleware；adapter 只负责
创建原生 host、等待 listen accepted、映射 `close`/`error` 为稳定 `done()`，并在 `stop(ctx)` 中执行原生
graceful close 与有界 force。Vanilla、Hono、Elysia、H3 只要暴露单参数 Fetch handler 就复用同一 adapter，
不为框架名称制造空壳 package。其他 Fetch host 可通过 factory 或用户自实现 structural Server 接入。
Bun 常驻 host 在被动 unexpected-terminal primitive 未闭合前不发布。

## 7. 健康检查

Health 是 portable package，提供注册表和 `/livez`、`/readyz` Fetch handler。probe 并发执行但输出按
注册顺序；每个 probe 有独立 timeout；reject、parent cancel 和 request abort 被隔离；公共响应不泄漏
地址、凭据、stack 或原始错误。支持 GET/HEAD，其他方法 405，未知路径 404，响应 `no-store`。
公开 callable 使用 lowerCamelCase：`ProbeRegistry.check(ctx, kind)`、`createHealthFetch(...)` 与
`registerAppProbes(registry, statusSource)`。

## 8. 可移植韧性能力

最新上游审计确认以下能力独立于 gRPC/protobuf 且适用于标准 Web API：Kratos 的
[client circuit breaker](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/middleware/circuitbreaker/circuitbreaker.go#L34-L67)
与 [server rate limiter](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/middleware/ratelimit/ratelimit.go#L39-L67)，
以及 go-micro 的 [retry decision](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/client/retry.go#L8-L35)
与 [backoff](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/client/backoff.go#L8-L14)。
`@go-like/resilience` 因此是 v1 release-blocking portable package，而不是未来 provider adapter。
公开入口固定为 `retry`、`exponentialBackoff`、`newCircuitBreaker`、`circuitOpen` 与
`newTokenBucketLimiter`，全部保持 lowerCamel。

硬语义：

1. `retry`/`exponentialBackoff` 只负责 Context-aware attempt scheduling。调用方必须显式声明操作可安全
   重试，并提供结果或错误分类；未声明幂等时拒绝启动 retry，而不是猜测 HTTP method、status 或业务错误。
2. 最大 attempts 必须有限且大于零；backoff 必须有限且非负。Context 取消或 deadline 到期立即终止当前
   wait，并且不得再启动新 attempt；最终保留调用方操作的原始结果或错误 identity。
3. Retry operation 由应用创建每次尝试所需的输入。package 不 import Fetch、不选择 endpoint、不 clone
   `Request`、不读取或缓存 body，也不隐式重放同一个操作。
4. `newCircuitBreaker` 返回调用方显式持有的内存对象，维护 closed/open/half-open 状态。只有调用方分类后的
   成功、失败和 probe 结果改变状态；open 状态使用稳定 `circuitOpen` 错误拒绝，half-open probe 数量必须
   有界，不存在 ambient global breaker registry。
5. `newTokenBucketLimiter` 显式配置正 capacity、refill 数量和周期。它只拥有惰性刷新的内存 token 状态，
   不创建后台 timer；非阻塞 `allow(ctx)` 先尊重 Context，再返回 allowed 与明确的 retry delay。
6. Backoff 与 outcome policy 必须可在不破坏类型推断的情况下显式注入。默认行为不能吞掉 cause、把取消
   改写成 availability error，或将非幂等失败升级成 retry。

单元门禁覆盖成功、失败、取消、deadline、attempt exhaustion、backoff 边界、breaker 全状态转换、并发
half-open probe、token refill/denial 和 timer/listener 回到基线；同一 portable cases 必须在 Bun、
Node LTS/current 与 Deno lanes 运行。业务 E2E 必须证明 transient failure recovery、非幂等操作零重放、
open/half-open recovery、token exhaustion/refill，以及无 Fetch body replay。

## 9. v1 发布阻断适配器

- Croner：应用在 `start(ctx)` factory 中创建初始 paused 的原生 `Cron` 实例，并直接使用 Croner 的 pattern、
  timezone、overlap、trigger、context 和诊断 API；adapter 只执行 resume/stop 与 Context 生命周期映射。
  Croner 没有可靠的 active-callback drain 和被动终态 primitive，因此 v1 必须把该限制写入 capability manifest，
  不得伪造 graceful drain 或 unexpected-exit 可观察性。
- BullMQ：应用用官方 API 创建 `autorun:false` Worker、三参数 processor 与完整 WorkerOptions；adapter 只承接
  run/readiness/pause/close/terminal，不包装 Job、Queue、processor、retry 或 stalled 语义。真实 Redis 证明
  生命周期映射、故障/恢复和连接清理，业务处理行为仍以 BullMQ 原生测试为证据。
- NATS Core：应用创建原生 `Subscription` 并负责消息迭代与处理；adapter 只承接
  drain/unsubscribe/closed，不声明 at-most-once 之外的数据面策略。
- NATS JetStream：应用创建原生 `ConsumerMessages`，并负责迭代、ack、MaxDeliver、重投与 DLQ；adapter 只
  承接 close/stop/closed。PubAck、ack pending 和 reconnect 可作为官方原生集成证据，但不冒充 go-like
  实现的数据面能力。
- Config：object/env/file/Consul；initial load、watch accepted 后 reconcile、serialized reload、validate before
  atomic swap、last-good、terminal WatchHandle。
- Registry：portable Registrar/Discovery/Watcher、完整 immutable snapshot（含空集合）与 round-robin selector；
  Consul Agent registration、TTL heartbeat、passing health、blocking query、outage/recovery 和 deregistration 必须
  使用真实 Consul 验证。
- Pino：应用使用官方 API 创建并持有 raw Logger 与 destination，并保留完整 Pino 配置/transport 能力；
  `start(ctx)` 接纳后把 destination 生命周期显式移交给 go-like。adapter 只映射 logger flush 与 destination
  error/end/close/destroy；未接纳的 destination 不由该 adapter 关闭，destroy 只允许发生在 hard timeout，
  且只有真实 `close` 才能结算稳定 `done()`。
- Winston：应用使用官方 API 创建并直接使用 raw Logger；adapter 只接管明确移交 logger 的 end/finish
  生命周期。它不调用 `close()` 冒充排空、不枚举 transports，也不发明跨 transport force 语义。
- OpenTelemetry：业务通过官方 API 创建并配置 provider、processor、reader 与 exporter，并继续使用原生
  Tracer/Meter；go-like 只承接 provider shutdown。Collector down 不阻塞业务，恢复与 flush 语义由官方
  配置负责；owner timeout 不伪造 provider terminal。
- Prometheus：独立 Registry；Fetch scrape；重复注册、低基数 label、并发 scrape 和 cleanup 有 gate。

BullMQ 虽位于 contrib 通道，仍是 v1 release-blocking beta。以上任何正式 package 未至少达到自己的
provisional gate，v1.0 都不发布空壳或虚假支持声明。

## 10. 测试与覆盖率

1. 单元测试使用 `bun test`。Bun `1.3.14` 原生可证明的 line/function coverage 必须逐 package 达到
   100%，source inventory 必须证明所有 production file 都进入分母。Bun 当前不产生 branch counters；
   published JavaScript 的 numeric branch authority 按 ADR 0002 使用 capability-aware 的原生 runtime
   coverage：portable package 覆盖固定的 Node LTS/current 与 Deno lane，runtime-specific adapter 覆盖其
   manifest 声明的全部可用原生数值覆盖 lane。不能把显式分支用例、空 LCOV 字段或没有数值 authority 的
   runtime 冒充 branch 100%。generated files、类型声明和纯 re-export 只能以明确、审查过的规则排除。
2. portable behavior 必须在 Bun、Node current/LTS、Deno 最新固定版本上运行；使用 Bun 编排，不能把
   “Bun 单测通过”外推为跨 runtime 通过。
3. external protocol 使用 Docker：NATS、Redis、Consul、OTel Collector，以及最终能力差距补充所需服务。
4. runner 为每个 Docker suite 分配唯一资源名/项目 label 和随机宿主端口，以 suite 前后的 Docker
   container、network、volume 快照及 `try/finally` cleanup 兜底；完成后 listener、timer、subscription、
   connection 也必须回到基线。
5. E2E 用例在代码完成后由团队联网收集，至少 40 个；每个保留 source URL、retrieved-at、license/quote
   boundary、能力域、normalized scenario、runtime/services、assertions 和 cleanup evidence。
6. 40 个用例必须去重并覆盖 Web、Context/cancel、Cron、Durable Job、NATS、Config、Logging、Telemetry、
   Health、Resilience、custom Server、failure/recovery 和 graceful shutdown，不得用参数变化凑数。
7. E2E 使用 Bun 脚本和固定 digest 的直接 Docker CLI 容器，输出 machine-readable result；失败不可被
   aggregate 脚本硬编码覆盖。

## 11. 完整交付顺序

1. Bun monorepo、版本/owner/capability manifests、coverage 和 import-boundary gates。
2. Context。
3. App/ServerHandle/testing lifecycle conformance。
4. Fetch bridge、Health、Node Fetch host。
5. Croner、Config env/file/Consul、Pino、Winston。
6. NATS Core/JetStream、BullMQ。
7. OpenTelemetry/Prometheus。
8. 重新对比最新 Go Micro、Go Kratos 能力矩阵，补齐适用于标准 Fetch 边界的 registry/discovery/selector。
9. 补齐 portable retry/backoff、circuit breaker、token-bucket limiter，并证明显式幂等与零隐式 body replay。
10. 跨 runtime 与真实 Docker package gates。
11. 团队联网收集并实现至少 40 个真实 E2E 用例。
12. 100% 单元覆盖审计、全量 fault/recovery、独立最终 review。
13. 重新对比最新 Go Micro、Go Kratos 能力矩阵，识别其余缺失工具包；每个新增能力重复 design -> TDD ->
    real-service gate -> review，直至差距补齐或被明确记录为不适用于 go-like 的非目标。

## 12. 明确非目标

- gRPC、Protobuf、私有 RPC/codegen。
- 自建 Web router、统一 middleware DSL、OpenAPI generator。
- 自动推断操作幂等性、隐式 Fetch retry、`Request` clone/body buffering 或透明请求重放。
- 一个覆盖所有 broker/job system 的 Message/Ack 接口。
- ORM/store、前端 DOM、agent/AI/MCP/flow。
- exactly-once、Context 能强杀任意 Promise、所有 runtime 自动支持所有 adapter 等虚假保证。

## 13. 决策状态

本设计继承并收敛 2026-07-16 的三项目源码调研、跨 runtime Fetch 实践、Context/ServerHandle TDD、
NATS/Redis/Consul/Collector Docker 实践及独立架构审查。用户已在 2026-07-17 明确要求开始实现，
因此该设计的用户审批门已满足。2026-07-18 的最新能力复审将 transport-independent resilience 从 deferred
提升为 v1 portable package；同日用户进一步批准“第三方库拥有能力、go-like 只适配 Server 生命周期”的
native-first 边界，并明确 Cron、HTTP 框架和日志库全部遵循该规则。后续变化必须通过 ADR 和新的失败测试
进入，不能在 adapter 内静默例外。

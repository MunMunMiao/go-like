# go-like Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 go-like 既定产品边界的前提下，为生命周期、后台终态、连接池、RabbitMQ、Redis、可观测性和发布链补齐可验证的生产安全边界。

**Architecture:** 公共 API 保持 go-micro/go-kratos 风格，非合作 Promise 通过 caller wait deadline 与真实 owner drain 分离；协议复杂度继续由官方 SDK 持有。所有行为先由失败测试证明，再以最小实现修复，真实服务能力必须通过固定版本 Docker 验证。

**Tech Stack:** TypeScript 7、Bun 1.3.14、标准 Web API、node-redis 6.1.0、amqplib 2.0.1、RabbitMQ 4.3.4、Redis 8.8.1、OpenTelemetry 2.10.0、GitHub Actions、Changesets、npm OIDC、Grafana k6 2.1.0。

---

## 执行约束

- 工作目录固定为 `/Users/munmunmiao/Documents/web/go-like`，直接使用 `main`，不创建 worktree 或分支。
- 不提交、不推送、不发布；每个 worker 必须保留并适配其他人的现有改动。
- 每个 task 使用一个新的 implementer，先通过 spec review，再通过 code-quality review，未修复 Important/Critical 不进入下一项。
- production source 修改前必须先添加失败测试并实际看到预期失败。
- 只运行 Bun workspace 命令，不使用 npm/pnpm/yarn 管理 workspace。
- Docker 测试使用 owner label、固定镜像摘要和 finally cleanup；结束后回读 container、network、volume。
- 当前全部公共包仍处于未发布的 `0.0.1` 首发阶段，变更记录写入 `docs/releases/0.0.1/changesets/`；不得留下 active Changeset。
- 正式文档保持专业中性，公共导出使用 lower-camel，业务重要函数保留简洁 JSDoc。

## Task 1：Core 总启动/停止预算与信号升级

**Files:**

- Modify: `packages/core/src/app.ts`
- Modify: `packages/core/src/node.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/app.test.ts`
- Modify: `packages/core/test/node.test.ts`
- Modify: `packages/core/test/public-api.test.ts`
- Modify: `packages/core/test/public-types.ts`
- Modify: `packages/core/test/smoke/package-smoke.ts`
- Modify: `packages/core/README.md`
- Modify: `docs/releases/0.0.1.md`
- Create: `docs/releases/0.0.1/changesets/core-lifecycle-deadlines.md`

- [x] **Step 1: 为新增公开 API 写失败测试**

锁定以下签名及 lower-camel 导出：

```ts
export function startTimeout(milliseconds: number): AppOption
```

在 public API/type tests 中断言 `startTimeout` 存在，负数、非整数和大于 `2_147_483_647` 的值拒绝，`0` 表示无 startup deadline。

- [x] **Step 2: 写非合作 startup 与 shutdown 失败测试**

在 `app.test.ts` 使用 `Promise.withResolvers()`，分别覆盖：

```text
beforeStart 永不 settle + startTimeout(5)
endpoint 永不 settle + startTimeout(5)
Registrar.register 忽略 Context + registrarTimeout(5)
beforeStop 消耗预算后 Server.stop 永不 settle + stopTimeout(20)
Server.stop resolve 但 Server.start 永不 terminal + stopTimeout(20)
afterStop 永不 settle + stopTimeout(20)
```

每个测试断言 `run()`/`stop()` 在 250ms 内以现有 `deadlineExceeded` 或包含它的有序 AggregateError 结算，并监听 `unhandledRejection` 断言为零。

- [x] **Step 3: 写迟到 register 补偿测试**

Registrar 在 timeout 后 resolve；断言公开 startup 已失败、同一 ServiceInstance 仅执行一次迟到 `deregister()`，迟到 rejection 被观察且不能改变已结算的 App 结果。

- [x] **Step 4: 运行 Core 红灯**

```sh
bun test --isolate --no-orphans packages/core/test/app.test.ts packages/core/test/node.test.ts packages/core/test/public-api.test.ts
```

预期：新增测试因 `startTimeout` 缺失以及现有无限等待失败；旧测试保持通过。

- [x] **Step 5: 实现最小 lifecycle deadline**

复用 `@go-like/context` 与现有 `waitForContext`：

- startup admission 使用一份 optional Context；不等待 `Server.start()` readiness；
- stop 第一次认领时创建一份 absolute deadline Context；
- 所有 hook、registrar、stop 与 server terminal join 都通过同一剩余预算等待；
- deadline 后调用尚未调用的 cleanup 一次，给迟到 Promise 安装 observer；
- `App.stop()` 保持同一稳定 Promise；
- late register success 触发一次 best-effort deregister；
- 不新增 AppHandle、状态对象、per-hook timeout 或 `process.exit()`。

- [x] **Step 6: 实现 Node 第二次信号升级**

第一次信号回调在调用 `stop()` 前移除 go-like 安装的所有 listeners，并设置 Unix exit code。进程测试断言第一次信号走 graceful stop，故意卡住时第二次信号不再被 go-like 吞掉。

- [x] **Step 7: 运行 Core 绿灯与 coverage**

```sh
bun run --filter @go-like/core test:coverage
bun run --filter @go-like/core typecheck
bun run --filter @go-like/core build
```

预期：全部退出 0，Core production line/function coverage 继续满足仓库契约。

- [x] **Step 8: 更新文档和 changeset**

说明 timeout 是 caller wait boundary，不是任意资源 terminal 证明；说明 production 预算应满足 native force 小于 App stop 小于 supervisor/Kubernetes grace。

## Task 2：Config 后台终态通知

**Files:**

- Modify: `packages/config/src/config.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/test/lifecycle.test.ts`
- Modify: `packages/config/test/reload.test.ts`
- Modify: `packages/config/test/public-api.test.ts`
- Modify: `packages/config/test/public-types.ts`
- Modify: `packages/config/README.md`
- Modify: `packages/config/capability.json`
- Create: `docs/releases/0.0.1/changesets/config-terminal-error.md`

- [x] **Step 1: 写公开 API 红灯**

锁定：

```ts
export type ConfigTerminalErrorHandler = (
  error: Error
) => void | PromiseLike<void>

export function onTerminalError(
  handler: ConfigTerminalErrorHandler
): ConfigOption
```

断言 non-function 构造期拒绝，Config 必选结构仍只有 `load/scan/value/watch/close`。

- [x] **Step 2: 写 terminal ordering 红灯**

成功 load 后让 `watcher.next()` 以一个固定 Error reject；断言：

1. `onTerminalError` 精确调用一次；
2. callback 发生在 `watcher.stop()` 前；
3. callback 与以后 `close(background())` 的主 Error identity 相同；
4. last-good value 仍可读取；
5. `onReloadError` 不因 terminal next failure 调用。

补 callback throw、callback rejected thenable、多个 watcher 同时失败、短 Context close 后第二 caller join owner drain、stop 永不 settle 等用例。

- [x] **Step 3: 运行 Config 红灯**

```sh
bun test --isolate --no-orphans packages/config/test/lifecycle.test.ts packages/config/test/reload.test.ts packages/config/test/public-api.test.ts
```

预期：新增 API 与 callback ordering 断言失败；旧 reload/last-good 用例通过。

- [x] **Step 4: 实现一次性 terminal callback**

在第一次 post-load abnormal primary 被认领时，同步发布 callback，再进入现有 reverse drain。复用 stable `donePromise` 与 first-fatal；观察 callback thenable，callback failure 作为隔离的 secondary diagnostic，不替换 primary，不重复通知。

- [x] **Step 5: 保持真实 owner drain**

`close(ctx)` 继续只用 caller Context 等待 owner drain；不让第一个 caller 接管 `watcher.stop()` Context，不增加 `done()` 或 Server lifecycle。

- [x] **Step 6: 运行 Config 绿灯**

```sh
bun run --filter @go-like/config test:coverage
bun run --filter @go-like/config typecheck
bun run --filter @go-like/config build
```

- [x] **Step 7: 更新 capability、README 与 changeset**

README 给出使用现有 Health probe 撤销 readiness 并请求 `app.stop()` 的组合示例，不让 Config 依赖 Health。

## Task 3：Registry registration terminal 通道

**Files:**

- Modify: `packages/registry/src/types.ts`
- Modify: `packages/registry/src/options.ts`
- Modify: `packages/registry/src/provider.ts`
- Modify: `packages/registry/test/options.test.ts`
- Modify: `packages/registry/test/public-types.ts`
- Modify: `packages/registry/consul/src/registration.ts`
- Modify: `packages/registry/consul/test/registration.test.ts`
- Modify: `packages/registry/etcd/src/registration.ts`
- Modify: `packages/registry/etcd/test/registration-manager.test.ts`
- Modify: `packages/registry/etcd/test/registration-boundaries.test.ts`
- Modify: `packages/registry/zookeeper/src/registration.ts`
- Modify: `packages/registry/zookeeper/test/registry.test.ts`
- Modify: `packages/registry/kubernetes/src/types.ts`
- Modify: `packages/registry/kubernetes/test/boundaries.test.ts`
- Modify: `packages/registry/kubernetes/test/public-types.ts`
- Modify: `packages/registry/mdns/src/types.ts`
- Modify: `packages/registry/mdns/src/options.ts`
- Modify: `packages/registry/mdns/src/registry.ts`
- Modify: `packages/registry/mdns/src/index.ts`
- Modify: `packages/registry/mdns/test/options.test.ts`
- Modify: `packages/registry/mdns/test/registration.test.ts`
- Modify: `packages/registry/mdns/test/registry-boundaries.test.ts`
- Modify: provider READMEs and capability manifests touched by the API
- Modify: `package.json`
- Modify: `scripts/provider-docker-gate.cli.ts`
- Modify: `scripts/verify-workspace.ts`
- Modify: `scripts/verify-workspace.test.ts`
- Create: `docs/releases/0.0.1/changesets/registry-registration-terminal.md`

- [x] **Step 1: 写共享 option API 红灯**

锁定：

```ts
export type RegistrationErrorHandler = (
  error: Error,
  service: ServiceInstance
) => void | PromiseLike<void>

export interface ProviderOptionInput {
  readonly logger?: ProviderLogger | null
  readonly timeoutMs?: number
  readonly onRegistrationError?: RegistrationErrorHandler | null
}
```

断言 handler 构造期校验、snapshot 不保留可变输入，并保持 Registrar/Registry SPI 未增加方法。

- [x] **Step 2: 为四个 resident provider 写 generation 红灯**

使用各包现有 fake/native harness 触发不可重试 heartbeat/session/socket failure，断言：active generation 先失效、callback 只调用一次、传入防御性 ServiceInstance snapshot、旧 generation 迟到失败不能通知新 generation。

retryable failure 只记录 warn 并继续 backoff，不调用 terminal handler。handler throw/reject 被观察且不能破坏后续 deregister/close。

- [x] **Step 3: 运行 Registry 红灯**

```sh
bun test --isolate --no-orphans \
  packages/registry/test/*.test.ts \
  packages/registry/consul/test/*.test.ts \
  packages/registry/etcd/test/*.test.ts \
  packages/registry/zookeeper/test/*.test.ts \
  packages/registry/mdns/test/*.test.ts
```

- [x] **Step 4: 实现共享 callback 与 generation fencing**

扩展现有 provider option snapshot；每个 resident registration 在自身已经判定永久失败的唯一分支调用共享 helper。callback 不能替代现有 secret-safe logger；不改变 retry 分类、wire format、TTL 或 Registry SPI。

- [x] **Step 5: 运行 package 绿灯**

```sh
bun run --filter @go-like/registry --filter '@go-like/registry-*' --sequential test:coverage
bun run --filter @go-like/registry --filter '@go-like/registry-*' --sequential typecheck
```

- [x] **Step 6: 运行真实 provider Docker 回归**

```sh
bun run test:providers:docker
```

预期：所有固定版本 provider suite 退出 0，owner resources 回读为零。

## Task 4：Client idle pool 有界化

**Files:**

- Modify: `packages/client/src/index.ts`
- Modify: `packages/client/test/client.test.ts`
- Modify: `packages/client/test/package-contract.test.ts`
- Modify: `packages/client/test/public-types.ts`
- Modify: `packages/client/README.md`
- Modify: `README.md`
- Modify: `docs/adr/0004-service-registry-and-selection.md`
- Modify: `test/published/cases/portable.ts`
- Create: `docs/releases/0.0.1/changesets/client-pool-bounds.md`

- [x] **Step 1: 写 options 红灯**

锁定：

```ts
export function poolSize(maxIdle: number): ClientOption
export function poolTtl(milliseconds: number): ClientOption
```

默认值为 `100`、`60_000`；size 允许 `0..2_147_483_647`，TTL 允许同范围。负数、非整数、溢出值拒绝。

- [x] **Step 2: 写资源边界红灯**

覆盖：101 个历史 address 只保留 100 个 idle owner；降低 size 后最老 owner 先关闭；`poolSize(0)` 每次 release 关闭；TTL 在没有后续 acquire 的情况下主动关闭；acquire/close 清理 timer；active owner 不被 timer 提前关闭；close/TTL/release race 每个 owner 只 close 一次。

- [x] **Step 3: 运行 Client 红灯**

```sh
bun test --isolate --no-orphans packages/client/test/client.test.ts packages/client/test/package-contract.test.ts
```

- [x] **Step 4: 实现最小 Map + timer 方案**

复用当前 `idle: Map` 的插入顺序作为 LRU；每个最多 100 个 idle owner 对应一个标准 timer，不新增 scheduler class。acquire、evict、close 都清理 timer；异步 close failure 继续进入既有 cleanup error 账本或受观察的 background close。

- [x] **Step 5: 运行 Client 绿灯**

```sh
bun run --filter @go-like/client test:coverage
bun run --filter @go-like/client typecheck
bun run --filter @go-like/client build
```

- [x] **Step 6: 更新 README 与 changeset**

明确 poolSize 是全 Client idle 上限，不是 Transport 并发上限；不承诺 generic multiplexing。

## Task 5：RabbitMQ publisher confirms

**Files:**

- Modify: `packages/broker/rabbitmq/src/index.ts`
- Modify: `packages/broker/rabbitmq/test/broker.test.ts`
- Modify: `packages/broker/rabbitmq/test/helpers.ts`
- Modify: `packages/broker/rabbitmq/test/public-api.test.ts`
- Modify: `packages/broker/rabbitmq/test/public-types.ts`
- Modify: `packages/broker/rabbitmq/test/runtime/published-runtime.fixture`
- Modify: `packages/broker/rabbitmq/test/e2e/rabbitmq-docker-e2e.ts`
- Modify: `packages/broker/rabbitmq/README.md`
- Create: `docs/releases/0.0.1/changesets/rabbitmq-publisher-confirms.md`

- [x] **Step 1: 写 borrowed ConfirmChannel API 红灯**

锁定：

```ts
export function newConfirmRabbitMqBroker(
  channel: ConfirmChannel
): RabbitMqBroker
```

plain `newRabbitMqBroker(Channel)` 继续立即返回 flow-control boolean；confirm factory 在 callback ack 后返回同一 boolean，nack/channel close reject。

- [x] **Step 2: 写 Context 和 recovery 红灯**

测试 caller Context 在 confirm 前取消时及时 reject，但迟到 callback 仍被观察；100 个并发 confirm 不串错结果；`newRecoveringRabbitMqBroker` 的每个 generation 调用 `createConfirmChannel()`，不得退回 plain channel。

- [x] **Step 3: 运行 Rabbit 单元红灯**

```sh
bun test --isolate --no-orphans packages/broker/rabbitmq/test/*.test.ts
```

- [x] **Step 4: 实现共享 broker 核心**

只抽取 plain/confirm 两种 publish boundary 真正共享的最小内部函数；不改变 subscribe、ack/nack/reject、Broker SPI 或 boolean result。ConfirmChannel 使用官方 callback/wait semantics，channel terminal 必须结算所有 pending confirms。

- [x] **Step 5: 扩展真实 RabbitMQ Docker gate**

在现有 `rabbitmq:4.3.4` 固定摘要用例增加：真实 ack confirm、connection restart 后新 generation confirm、pending publish 遇 channel close reject、并发 confirm、无 unhandled rejection。输出 JSON 增加 `publisherConfirm` 证据字段，finally 验证零残留。

- [x] **Step 6: 运行 Rabbit 绿灯与 Docker**

```sh
bun run --filter @go-like/broker-rabbitmq test:coverage
bun run --filter @go-like/broker-rabbitmq typecheck
GO_LIKE_E2E_OWNER=rabbitmq-confirm-gate bun run --filter @go-like/broker-rabbitmq test:docker
```

## Task 6：Redis native Client、TLS、Sentinel 与 Cluster

**Files:**

- Modify: `packages/cache/redis/src/types.ts`
- Modify: `packages/cache/redis/src/options.ts`
- Modify: `packages/cache/redis/src/connection.ts`
- Modify: `packages/cache/redis/src/cache.ts`
- Modify: `packages/cache/redis/src/index.ts`
- Modify: `packages/cache/redis/test/options-errors.test.ts`
- Modify: `packages/cache/redis/test/connection.test.ts`
- Modify: `packages/cache/redis/test/public-api.test.ts`
- Modify: `packages/cache/redis/test/public-types.ts`
- Modify: `packages/cache/redis/test/integration/redis-docker.ts`
- Modify: `packages/cache/redis/README.md`
- Modify: `packages/cache/redis/capability.json`
- Create: `docs/releases/0.0.1/changesets/redis-native-topologies.md`

- [x] **Step 1: 写 mutually-exclusive options 红灯**

保留 URL 模式并增加 dormant factory 模式；锁定一个 `RedisCacheClientFactory` public type。`url` 与 `client` 同时存在或同时缺失必须构造期拒绝；factory non-function 拒绝；go-like 不接受已 open client。

- [x] **Step 2: 写 native lifecycle 红灯**

使用官方 client-compatible fake 覆盖：factory 只调用一次；start 执行 connect；get/set/del 使用带 `abortSignal` 和 `commandTimeoutMs` 的 command facade；stop 等 active command 释放后 close；connect/close 失败 destroy；error listener 精确安装/移除一次。

- [x] **Step 3: 运行 Redis 单元红灯**

```sh
bun test --isolate --no-orphans packages/cache/redis/test/*.test.ts
```

- [x] **Step 4: 实现官方 client adapter**

以最小 structural capability 同时承接 `createClient()`、`createCluster()` 和 `createSentinel()` 返回值；不复制 vendor options，不使用三个 go-like factory。URL 模式继续内部调用 `createClient`，两种模式最终进入同一 `RedisConnection` owner。

- [x] **Step 5: 扩展真实 Redis Docker gate**

全部使用官方 `redis:8.8.1-alpine` 固定摘要和独立 Docker network：

1. TLS/auth 单节点执行 Cache conformance；
2. primary、replica 和三个 Sentinel，kill primary 后通过 `createSentinel()` 完成写入/读取；
3. 三主三从 Cluster，验证跨 slot key，并 kill 一个 primary 后等待 failover 再读写；
4. 每个 topology 输出精确 server/client version、failover evidence 与 cleanup evidence。

- [x] **Step 6: 运行 Redis 绿灯与真实故障测试**

```sh
bun run --filter @go-like/cache-redis test:coverage
bun run --filter @go-like/cache-redis typecheck
GO_LIKE_E2E_OWNER=redis-topology-gate bun run --filter @go-like/cache-redis test:docker
```

预期：单节点、TLS、Sentinel、Cluster 全部通过，container/network/volume 残留为零。

## Task 7：Pino、Winston 与 OTel 错误脱敏

**Files:**

- Modify: `packages/pino/src/logging.ts`
- Modify: `packages/pino/test/runtime.test.ts`
- Modify: `packages/winston/src/logging.ts`
- Modify: `packages/winston/test/runtime.test.ts`
- Modify: `packages/otel/src/instrumentation.ts`
- Modify: `packages/otel/test/instrumentation.test.ts`
- Modify: corresponding READMEs
- Create: `docs/releases/0.0.1/changesets/observability-error-redaction.md`

- [x] **Step 1: 写 secret-bearing Error 红灯**

构造 message、stack、cause 和 throwing getters 均含 `GO_LIKE_SECRET_SENTINEL` 的 Error。Pino/Winston captured record 和 OTel exported span 的递归 JSON 必须完全不包含 sentinel、message、stack、cause 或原始 Error object。

安全输出只允许 bounded `errorType` 和匹配 `^[A-Z0-9_.-]{1,64}$` 的 `errorCode`；非法、过长、getter throw 时省略。业务失败 outcome/status 保持不变。

- [x] **Step 2: 运行 observability 红灯**

```sh
bun test --isolate --no-orphans \
  packages/pino/test/runtime.test.ts \
  packages/winston/test/runtime.test.ts \
  packages/otel/test/instrumentation.test.ts
```

- [x] **Step 3: 实现各包最小安全提取**

不创建新共享 package 或 logger facade。Pino/Winston 写扁平安全字段；OTel 设置 `error.type` 与可选 `go-like.error.code`，删除业务 Error 的 `recordException(value)`。hostile value 不能替换原业务结果。

- [x] **Step 4: 运行绿灯和 OTel Docker**

```sh
bun run --filter @go-like/pino --filter @go-like/winston --filter @go-like/otel --sequential test:coverage
bun run --filter @go-like/pino --filter @go-like/winston --filter @go-like/otel --sequential typecheck
GO_LIKE_E2E_OWNER=otel-redaction-gate bun test packages/otel/test/e2e/instrumentation-docker.ts
```

## Task 8：Release、供应链与长时间运行门禁

**Files:**

- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/codeql.yml`
- Create: `.github/workflows/soak.yml`
- Create: `.github/dependabot.yml`
- Create: `SECURITY.md`
- Create: `e2e/load/k6-http.js`
- Create: `e2e/load/web-host.ts`
- Create: `scripts/soak.cli.ts`
- Create: `scripts/soak.test.ts`
- Modify: `package.json`
- Modify: `scripts/verify-workspace.ts`
- Modify: `scripts/verify-workspace.test.ts`
- Modify: `doc/reference/verification.md`
- Modify: `doc/zh-Hans/reference/verification.md`
- Modify: `docs/releases/0.0.1.md`
- Create: `docs/releases/0.0.1/changesets/release-production-gates.md`

- [x] **Step 1: 写 workspace contract 红灯**

测试要求 `soak:check`、`soak:http` scripts 精确存在；release workflow 必须包含 `workflow_dispatch`、GitHub environment、`id-token: write`、`contents: read`、固定 SHA actions、Bun `1.3.14`、Node `26.5.0`、npm `12.0.1`、frozen install、完整 verify、`changeset publish` 和 provenance。禁止 `NODE_AUTH_TOKEN`、`NPM_TOKEN`、floating action tag。

- [x] **Step 2: 写 soak evaluator 红灯**

`scripts/soak.cli.ts --check <result.json>` 对以下事实 fail-closed：非零 unexpected errors、unhandled rejection、cleanup false、端口不可重绑、Bun runner 或 Node Web host 的 FD/handle/RSS/heap 基线持续增长、发布级采样间隔超过 15 秒、Linux/macOS 缺失 FD、版本/命令/环境缺失。合法固定 fixture 退出 0；短时 fixture 不能标记 release-candidate。

- [x] **Step 3: 运行 release/soak 红灯**

```sh
bun test scripts/soak.test.ts scripts/verify-workspace.test.ts
```

- [x] **Step 4: 实现 release workflow 与治理文件**

release 只允许手动触发，并使用受保护 `npm` environment；执行 preflight、frozen install、`bun run verify`、build、Changesets publish。配置 npm trusted publishing 后由 OIDC 发布并生成 provenance；仓库内不保存长期 token。CodeQL 和 Dependabot 使用最小 GitHub 官方配置。

- [x] **Step 5: 实现 k6 与内部资源 probe**

k6 以固定 arrival rate、足量预分配 VU 和生产 HTTP keep-alive 语义请求 go-like 标准 Fetch Web endpoint，保存 p50/p95/p99、错误、请求数与阈值判断前的原始日志。短连接关闭、排空和拒绝由独立 shutdown 场景验证，不把 Docker Desktop VM/backend 的短连接 churn 混入 60 分钟稳态门禁。Bun owner 只承载 portable Client 与编排，Node host 承载 Web 和两个 Node-only internal servers；两边分别采集 RSS、heap、active handles、FD，同时记录 dial count、port rebind 与 cleanup。runtime 样本在 k6 阈值和 provider gates 前单独保存。结果写入 `.artifacts/soak/`。默认 `soak:http` 为 60 分钟，`soak:check` 只消费已有结果。

- [x] **Step 6: 运行短时 harness 自检**

```sh
bun test scripts/soak.test.ts scripts/verify-workspace.test.ts
bun scripts/soak.cli.ts --duration 10s --output .artifacts/soak/self-check.json
bun scripts/soak.cli.ts --check .artifacts/soak/self-check.json
```

短时结果只证明 runner 正确，不标记 release candidate。

- [x] **Step 7: 运行 60 分钟 production soak**

```sh
bun run soak:http
bun run soak:check
```

必须等待命令真实结束并检查 JSON；不得以进程启动或短时样本冒充完成。

- [x] **Step 8: 更新安全、发布和验证文档**

记录漏洞报告渠道、支持范围、OIDC 前置配置、partial publish recovery、soak 结果字段，以及 Git baseline/branch protection/npm organization 属于外部授权步骤。

## Task 9：全项目复核与完成判定

**Files:**

- Review: all files changed by Tasks 1-8
- Modify only when a failing verification identifies an in-scope regression

- [x] **Step 1: 独立 final spec review**

逐项对照 `docs/superpowers/specs/2026-07-26-go-like-production-readiness-design.md`，确认没有遗漏，也没有引入排除项。

- [x] **Step 2: 运行格式、类型、包级与仓库级检查**

```sh
bun run fmt
bun run fmt:check
bun run verify:workspace
bun run verify:manifests
bun run verify:file-inventory
bun run typecheck
git diff --check
```

- [x] **Step 3: 运行完整验证**

```sh
bun run verify
```

等待实际 exit code；记录 runtime/type subject 数、E2E suite/scenario 数、Docker suite 数与文档构建结果。

- [x] **Step 4: fresh cleanup readback**

```sh
docker ps -a --filter label=io.go-like.e2e.owner --format '{{.ID}} {{.Names}}'
docker network ls --filter label=io.go-like.e2e.owner --format '{{.ID}} {{.Name}}'
docker volume ls --filter label=io.go-like.e2e.owner --format '{{.Name}}'
ps -Ao pid,ppid,command | rg '/Users/munmunmiao/Documents/web/go-like|go-like-' || true
```

只在本轮 owner resources 与子进程均为零时通过。

- [x] **Step 5: 明确外部阻塞**

若真实文件仍未进入 Git、`main` 未配置 upstream、hosted CI 未运行、npm trusted publisher 未配置或没有真实 pilot，最终结论必须写为“代码与本地门禁完成，但尚未 production-proven”，不能伪造发布或线上状态。

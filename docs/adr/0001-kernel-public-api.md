# ADR 0001: Kernel public API

日期：2026-07-17

状态：Accepted

## Context

第一阶段必须在写实现前消除临时 spike 与研究报告之间的导出差异。用户要求 Go-style Context、任意
structural Server、一参 Fetch 和可组合 App；旧 spike 中的 `readonly Done`、`Shutdown`、Context class、
Health 二参顺序都不能成为兼容包袱。

## Decision

### `@likego/context`

- `Context`、`ContextError`、`TimeoutContextError`、`CancelFunc`、`CancelCauseFunc`、`StopFunc` 是 type export。
- `ContextError` 与 `TimeoutContextError` 不导出 runtime constructor；调用方只依赖稳定 sentinel identity。
- runtime exports：`Canceled`、`DeadlineExceeded`、`Background`、`TODO`、`WithCancel`、
  `WithCancelCause`、`WithDeadline`、`WithDeadlineCause`、`WithTimeout`、`WithTimeoutCause`、
  `WithValue`、`WithoutCancel`、`Cause`、`AfterFunc`。

#### Context timing 与 `AfterFunc` 最终契约

机器可审计 contract marker：`LIKEGO_CONTEXT_TIMING_AFTERFUNC_V1`。

1. 任何时间读取或资源分配前，先拒绝 nullish parent，并验证 parent 的 structural shape：`Deadline`、
   `Done`、`Err`、`Value` 都必须可调用。
2. 参数验证后最多调用一次 `parent.Deadline()`。若 parent 报告 deadline，必须验证 tuple 与 `Date`，并且只调用
   一次 `Date.prototype.getTime.call(parentDeadline)`；effective epoch 是 requested snapshot 与 parent snapshot 的
   最小值，之后禁止再次读取 parent deadline。
3. `WithDeadline*` 只调用一次 `Date.prototype.getTime.call(deadline)`，应用 parent snapshot 后只调用一次
   `Date.now()` 并保存为 `wallNow`。非 `Date` 抛 `TypeError`；deadline 或 wall sample 非有限/无效时抛
   `RangeError`；Context 内只保存 numeric deadline snapshot。
4. `WithTimeout*` 先验证 `timeoutMs` 有限，再取得 parent deadline snapshot，然后只调用一次 `Date.now()`，
   同一个 `wallNow` 供之后全部构造逻辑使用。原始 `wallNow + timeoutMs` 必须有限且位于 inclusive TimeClip
   范围；requested epoch 是 `Math.trunc(wallNow + timeoutMs)`，stored effective epoch 是它与 parent snapshot 的
   最小值；`Deadline()` 每次为该 epoch 返回新的 `Date`。
5. shared timer constructor 接收 `effectiveEpoch` 和捕获的 `wallNow`，内部禁止读取 `Date.now()`。若
   `effectiveEpoch <= wallNow`，同步返回已经是 `DeadlineExceeded` 的 Context，不读取 `performance.now()`，
   也不创建 timer。
6. future effective deadline 只在 wall sample 之后读取一次 `performance.now()`，计算
   `monotonicTarget = monotonicNow + (effectiveEpoch - wallNow)`。每次 arm 不超过 `2_147_483_647ms`；wake
   只用 fresh `performance.now()` 与 target 比较，过早则 re-arm。构造后的 wall-clock jump 不改变 expiry；
   cancel 清除当前 arm，stale callback 为 no-op。contract tests 必须 instrument 两种 clock getter，断言调用
   次数与顺序，并在构造后跳变 wall time。
7. optional custom `AfterFunc` property/method 只读取一次，并以 `this === ctx` 调用。delegate 同步尝试的
   callback 先缓冲；只有 delegate 返回 callable `StopFunc` 后，缓冲 admission 才能进入 shared once-state。
   delegate 抛错或返回非函数时丢弃缓冲，user callback 永不运行。
8. public stop 与 callback admission 只有一个 winner：successful stop 只成功一次、抑制 callback 并返回
   `true`；callback 已 admitted 后 stop 返回 `false`。user callback 以 microtask 排队且最多运行一次；该 private
   capability 不增加 public export。

### `@likego/core`

```ts
export interface Server<H extends ServerHandle = ServerHandle> {
  Start(ctx: Context): Promise<H>
}

export interface ServerHandle {
  Done(): Promise<void>
  Stop(ctx: Context): Promise<void>
}
```

Root exports 还包括 `App`、`AppHandle`、`AppDiagnostics`、`AppStatusSource` types，`NewApp`、`Name`、
`Server`、`HardDrainTimeout` option functions，以及 `ServerAlreadyStartedError`、`UnexpectedExitError`、
`DrainTimeoutError`。Type/value namespace 中的 `Server` interface 和 `Server(...)` option function 允许同名，
并以 type tests 锁定。

`WaitForContext(ctx, operation)` 只从 `@likego/core/lifecycle` subpath 导出；Context 必须是首参。它只约束
caller waiter，不 abort 或 mutate operation。

`AppHandle` 可扩展基础 handle 并提供 `Diagnostics()` 与只读 `Status()`；endpoint/readiness/health 不进入
基础 `ServerHandle`。

### `@likego/fetch`

Root 只导出四个 public symbols：`FetchHandler`、`ContextHandler`、`ContextHandlerOptions`、
`ToFetchHandler`。`FetchHandler` 始终是一参；Context 只能通过显式 bridge 进入。

### `@likego/health`

- `ProbeRegistry.Check(ctx, kind)`，Context 是首参。
- `CreateHealthFetch(...)` 返回 `@likego/fetch` 的 `FetchHandler`；不导出第二个 handler alias。
- `RegisterAppProbes(registry, statusSource)` 使用显式 `AppStatusSource`，不 duck-type 基础 handle。

### `@likego/testing`

Root 只导出 runner-neutral case/harness types；Server conformance 从 `@likego/testing/server` subpath 导出。
任何 production package 都不能依赖 testing。

## Consequences

- 临时 spike 只能复用测试意图，不能直接复制 public shape。
- public API allowlist、positive/negative type fixtures 和 tarball exports smoke 是 release gate。
- 任何新增 root export 必须先更新本 ADR、type fixture 与 package export test。

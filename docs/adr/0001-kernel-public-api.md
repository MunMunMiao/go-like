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

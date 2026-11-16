# Public API 参考

本文列出设计稿的全部 public 导出，不代表当前公共接口。内容由设计声明树经 TypeScript 编译器 API 生成；该声明树（20 个包、75 个入口）在 TypeScript 5.9.3 与 7.1.0-beta 下均通过类型检查。每个入口给出职责说明；每个导出给出种类、是否插座、与现有 API 的关系、替代的旧符号、插头实现的插座，以及完整声明。设计正文见[README](README.md)，决定编号见[决策记录](decisions.md)。

标记：**[插座]** 是由插头或应用实现的接口。状态“新增 / 迁移 / 改名 / 语义变化 / 原位保留”相对于今天仓库的 public API。“替代”列出 `旧说明符#旧名`，“实现”列出插头填充的 `core 说明符#插座`。

## `@go-like/core`

### `@go-like/core`

角色：应用入口；lane：P；26 个导出。

应用 API：用 `newApp` 加一组选项构建一个一次性运行的 App，由它按 telemetry、resources、server 三个有序层级管理启动与停止。本入口只含 App 机制（身份、层级、注册与就绪、预算、钩子），不导出任何 socket；`Server`/`Endpointer` 在 `@go-like/core/lifecycle`。由 core 自己实现，应用的 `main` 消费；插件通过公共 socket 接入生命周期，不需要自己构造 `AppOption`。

#### `newApp`

函数 · 语义变化 · 替代 `@go-like/core#newApp`

按顺序应用选项并构建一个 App；校验层级列表（同一参与者在 `resources` 与 `server` 中至多出现一次，否则 `TypeError`）、注册就绪探针、派生各层级的 Context。

```ts
export declare function newApp(...options: readonly AppOption[]): App
```

#### `context`

函数 · 原位保留

设置父 Context：它被取消时 App 以 `context_canceled` 原因停止。

```ts
export declare function context(ctx: Context): AppOption
```

#### `id`

函数 · 原位保留

设置实例 id。

```ts
export declare function id(value: string): AppOption
```

#### `name`

函数 · 原位保留

设置服务名，注册与 telemetry 资源属性都使用它。

```ts
export declare function name(value: string): AppOption
```

#### `version`

函数 · 原位保留

设置服务版本。

```ts
export declare function version(value: string): AppOption
```

#### `metadata`

函数 · 原位保留

设置随注册一起发布的元数据。

```ts
export declare function metadata(value: Readonly<Record<string, string>>): AppOption
```

#### `endpoint`

函数 · 原位保留

设置对外 endpoint 列表；未设置时由 server 层级的 `Endpointer` 提供。

```ts
export declare function endpoint(...values: readonly string[]): AppOption
```

#### `telemetry`

函数 · 新增

安装一个 `Telemetry` 包并把它作为最外层级运行：它在一切之前启动、在一切之后排空。重复调用以最后一个为准。与 `server(...)`/`resources(...)` 不同，传入的是 `newTelemetry(...)` 的结果。

```ts
export declare function telemetry(value: Telemetry): AppOption
```

#### `resources`

函数 · 新增

设置 resource 层级：必须在服务器之前可用、在服务器之后才关闭的依赖（连接、队列、缓存）。每个值必须是结构上的 `Server`；传入 `Telemetry` 是编译错误（运行时抛 `TypeError`），重复调用以最后一次为准。等待准入（awaited admission）：内核按声明顺序逐个启动，并在 start 阶段 Context 下 `await` 每个 resource 的 `start(ctx)`；resource 的 `start` 必须在“已准入、可使用”时 resolve，准入失败时 reject，不能为整个运行期保持 pending——长期运行的参与者属于 `server(...)`。失败的准入以 `start_failed` 终止启动阶段，并按相反顺序停止已启动的 resource；仍在 pending 的 resource 也会收到 `stop`。`startTimeout` 的范围包含 resource 层级；停止顺序是所有 server 的 start 结算之后、`afterStop` 钩子之前，按声明相反顺序，共享 `stopTimeout`。应用自有的原生资源用 `newResourceServer` 适配。

```ts
export declare function resources(...values: readonly (Server & NotTelemetry)[]): AppOption
```

#### `server`

函数 · 语义变化 · 替代 `@go-like/core#server`

设置 server 层级：长期运行的参与者（HTTP/RPC 主机、broker 订阅、job worker）。沿用启动即发射、并发启停的规则：`start` 可在准入后 resolve，也可保持 pending 直到原生终止；传入 `Telemetry` 是编译错误。

```ts
export declare function server(...servers: readonly (Server & NotTelemetry)[]): AppOption
```

#### `registrar`

函数 · 原位保留

设置 `Registrar`：App 在 server 层级的 endpoint 就绪后注册自身，并在停止时先注销。

```ts
export declare function registrar(value: Registrar): AppOption
```

#### `readyProbe`

函数 · 新增

在 `registry` 中以 `name`（默认 `"app"`）注册一个 ready 探针：它只在 start 阶段结束到停止请求之间通过，其余阶段以 `AppNotReadyError` 失败。`run()` 结束后探针自动注销。

```ts
export declare function readyProbe(registry: ProbeRegistry, name?: string): AppOption
```

#### `registrarTimeout`

函数 · 原位保留

注册与注销（`Registrar`）单次调用的超时毫秒数，默认 10000。

```ts
export declare function registrarTimeout(timeoutMs: number): AppOption
```

#### `startTimeout`

函数 · 语义变化 · 替代 `@go-like/core#startTimeout`

启动阶段的整体预算（毫秒，0 表示不限）：覆盖钩子、resource 层级的准入等待、endpoint 准备、注册与 `afterStart`。

```ts
export declare function startTimeout(milliseconds: number): AppOption
```

#### `stopTimeout`

函数 · 原位保留

停止阶段的共享等待预算（毫秒，0 表示不限）：钩子、注销、server 层级与 resource 层级共用；telemetry 层级有自己同样长度的预算。

```ts
export declare function stopTimeout(timeoutMs: number): AppOption
```

#### `beforeStart`

函数 · 原位保留

在 resource 层级启动之前按注册顺序执行的钩子。

```ts
export declare function beforeStart(hook: AppHook): AppOption
```

#### `afterStart`

函数 · 原位保留

在 server 层级与注册完成之后执行的钩子。

```ts
export declare function afterStart(hook: AppHook): AppOption
```

#### `beforeStop`

函数 · 原位保留

在收到停止请求之后、server 层级停止之前执行的钩子。

```ts
export declare function beforeStop(hook: AppHook): AppOption
```

#### `afterStop`

函数 · 原位保留

在 resource 层级停止之后、telemetry 层级排空之前执行的钩子。

```ts
export declare function afterStop(hook: AppHook): AppOption
```

#### `newContext`

函数 · 原位保留

把 `AppInfo` 放进 Context，供下游通过 `fromContext` 读取。

```ts
export declare function newContext(ctx: Context, info: AppInfo): Context
```

#### `fromContext`

函数 · 原位保留

读取 `newContext` 放入的 `AppInfo`，没有则返回 `null`。

```ts
export declare function fromContext(ctx: Context): AppInfo | null
```

#### `AppInfo`

接口 · 原位保留

一个 App 的不可变身份：`id`、`name`、`version`、`metadata` 与对外 `endpoint` 列表。

```ts
export interface AppInfo {
  id(): string
  name(): string
  version(): string
  metadata(): Readonly<Record<string, string>>
  endpoint(): readonly string[]
}
```

#### `App`

接口 · 原位保留

一次性运行的应用生命周期：`run()` 完成启动后一直等待停止请求或第一个参与者失败，`stop()` 幂等且共享同一个 promise。

```ts
export interface App extends AppInfo {
  run(): Promise<void>
  stop(): Promise<void>
}
```

#### `AppHook`

类型 · 原位保留

生命周期钩子：在启动或停止阶段按注册顺序依次执行，启动阶段 fail-fast，停止阶段尽力执行完。

```ts
export type AppHook = (ctx: Context) => void | Promise<void>
```

#### `AppOption`

接口 · 语义变化 · 替代 `@go-like/core#AppOption`

构建 App 的不透明选项：只有 `@go-like/core` 自己的选项函数能产生它，`newApp` 拒绝其他值（`TypeError`）。

```ts
export interface AppOption {
  readonly [appOptionBrand]: "AppOption"
}
```

#### `AppNotReadyError`

接口 · 新增

`readyProbe` 在 App 就绪窗口之外报告的失败；`phase` 说明 App 当时所处阶段，稳定 code 为 `GO_LIKE_APP_NOT_READY`。

```ts
export interface AppNotReadyError extends Error {
  readonly name: "AppNotReadyError"
  readonly code: "GO_LIKE_APP_NOT_READY"
  readonly phase: "created" | "starting" | "stopping" | "stopped"
}
```

### `@go-like/core/node`

角色：运行时绑定；lane：N,B；2 个导出。

App 的 Node 兼容运行时绑定：用进程信号停止 App，在 Bun 下经 `node:process` 同样可用。本入口是核心里唯一导入 `node:process`/`node:os` 的地方，因此不属于可移植入口；由 core 自己实现，应用的 `main` 消费。

#### `signal`

函数 · 语义变化 · 替代 `@go-like/core/node#signal`

收到所列信号中的第一个时以 `requested` 原因停止所属 App（默认 SIGTERM、SIGQUIT、SIGINT），并设置 `process.exitCode = 128 + signo`。

```ts
export declare function signal(...signals: readonly ProcessSignal[]): AppOption
```

#### `ProcessSignal`

类型 · 新增

core 自有的信号名联合（37 个名字，与 `@types/node` 的信号集合一致，由漂移测试守护），避免公共声明引用 `@types/node`。

```ts
export type ProcessSignal =
  | "SIGABRT"
  | "SIGALRM"
  | "SIGBUS"
  | "SIGCHLD"
  | "SIGCONT"
  | "SIGFPE"
  | "SIGHUP"
  | "SIGILL"
  | "SIGINT"
  | "SIGIO"
  | "SIGIOT"
  | "SIGKILL"
  | "SIGPIPE"
  | "SIGPOLL"
  | "SIGPROF"
  | "SIGPWR"
  | "SIGQUIT"
  | "SIGSEGV"
  | "SIGSTKFLT"
  | "SIGSTOP"
  | "SIGSYS"
  | "SIGTERM"
  | "SIGTRAP"
  | "SIGTSTP"
  | "SIGTTIN"
  | "SIGTTOU"
  | "SIGUNUSED"
  | "SIGURG"
  | "SIGUSR1"
  | "SIGUSR2"
  | "SIGVTALRM"
  | "SIGWINCH"
  | "SIGXCPU"
  | "SIGXFSZ"
  | "SIGBREAK"
  | "SIGLOST"
  | "SIGINFO"
```

### `@go-like/core/lifecycle`

角色：插座+机制；lane：P；5 个导出。

生命周期参与者 socket：`Server`（App 在准入后拥有的常驻参与者）与可选的 `Endpointer`（可发布地址的能力），外加一个适配器 `newResourceServer`。它是唯一定义这两个 socket 的入口，因此没有任何 socket 入口需要反向导入根入口。由 broker、job、cache、web/RPC 主机等插件与 core 实现，由 `newApp` 的 `resources(...)`/`server(...)` 消费。

#### `newResourceServer`

函数 · 新增

把一个应用自有的原生资源（连接、队列、连接池）适配成一次性的 `Server`，用于 `resources(...)`；它是此类资源的唯一适配器。等待准入（awaited admission）：`start(ctx)` 在 `open(ctx)` 完成后 resolve（没有 `open` 则立即 resolve），不会为运行期保持 pending；`open` 失败时 `start` reject 且从不调用 `close`——所有权尚未移交，应用仍拥有原生对象。`terminal` 通过 core 私有通道被内核在准入后观察：它在 `stop` 之前结算，就以 `server.failed{tier: "resource"}` 使 App 失败。`stop(ctx)` 在 `start` 之前调用则标记已停止；准入后只调用一次 `close(withoutCancel(ctx))`，重复 `stop` 加入同一次排空；core 从不强杀。手写的、未经 `newResourceServer` 的 resource 没有“过早终止”上报。

```ts
export declare function newResourceServer(options: ResourceServerOptions): Server
```

#### `Server`　[插座]

接口 · 迁移 · 替代 `@go-like/core#Server`

App 在准入后拥有的一个常驻参与者（ADR 0003）：`start(ctx)` 准入，`stop(ctx)` 至多启动一次 owner 排空，调用者的 ctx 只限制它自己的等待。在 `server(...)` 中，`start` 可在准入后 resolve，也可保持 pending 直到原生终止；准入之后的 reject 是意外终止并使 App 失败。在 `resources(...)` 中，`start` 必须在资源已准入、可使用时 resolve，准入失败时 reject，不能为整个运行期保持 pending。

```ts
export interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}
```

#### `Endpointer`　[插座]

接口 · 迁移 · 替代 `@go-like/core#Endpointer`

server 层级参与者可选的能力：拥有一个可对外发布的地址，供 App 注册使用。

```ts
export interface Endpointer {
  /** 同步的协议标识；同一个 App 的所有 Endpointer 必须一致。 */
  protocol(): string
  /** 异步绑定完成后的实际 endpoint。 */
  endpoint(ctx: Context): string | Promise<string>
}
```

#### `ResourceServerOptions`

接口 · 新增

描述一个应用自行构造的原生资源如何被准入、排空与观察。

```ts
export interface ResourceServerOptions {
  /** 可选的准入步骤，由 `start(ctx)` 等待，例如 `queue.waitUntilReady()`。 */
  readonly open?: (ctx: Context) => Promise<void>
  /**
   * 可选的原生终止信号，例如 `connection.closed()`。以 `Error` resolve 或 reject 都算失败；
   * 在 `stop()` 之前就结算会以 `tier: "resource"` 的参与者失败上报（干净 resolve 时 code 为 `GO_LIKE_RESOURCE_CLOSED`）。
   */
  readonly terminal?: Promise<Error | void | undefined>
  /** 唯一的 owner 排空，至多调用一次，参数是 `withoutCancel(首次 stop 的 ctx)`，例如 `connection.drain()`。 */
  readonly close: (ctx: Context) => Promise<void>
}
```

#### `ResourceServerError`

接口 · 新增

`newResourceServer` 的错误：重复 `start`（`GO_LIKE_RESOURCE_ALREADY_STARTED`）或终止信号过早干净结算（`GO_LIKE_RESOURCE_CLOSED`）。

```ts
export interface ResourceServerError extends Error {
  readonly name: "ResourceServerError"
  readonly code: "GO_LIKE_RESOURCE_ALREADY_STARTED" | "GO_LIKE_RESOURCE_CLOSED"
}
```

### `@go-like/core/context`

角色：插座+机制；lane：P；21 个导出。

跨 API 边界传递截止时间、取消、错误与请求范围值的 `Context` socket，以及它的派生函数、根 Context 与 `waitForContext`。任何具备四个方法的对象都可以作为父 Context；由 core 实现参考版本，所有其他入口与插件消费。稳定的取消错误，由 Context 的 `err()` 暴露。@status moved @from @go-like/context#ContextError

#### `background`

函数 · 迁移 · 替代 `@go-like/context#background`

返回冻结的根 Context：永不取消、无截止时间、无值。

```ts
export declare function background(): Context
```

#### `todo`

函数 · 迁移 · 替代 `@go-like/context#todo`

返回占位的根 Context，用于尚未确定该传哪个 Context 的位置。

```ts
export declare function todo(): Context
```

#### `withCancel`

函数 · 迁移 · 替代 `@go-like/context#withCancel`

派生一个可取消的子 Context，同时返回取消函数。

```ts
export declare function withCancel(parent: Context): readonly [Context, CancelFunc]
```

#### `withCancelCause`

函数 · 迁移 · 替代 `@go-like/context#withCancelCause`

派生一个可带原因取消的子 Context。

```ts
export declare function withCancelCause(parent: Context): readonly [Context, CancelCauseFunc]
```

#### `cause`

函数 · 迁移 · 替代 `@go-like/context#cause`

返回 Context 被取消的原因（Go 的 `Cause`），没有则返回 `null`。

```ts
export declare function cause(context: Context): Error | null
```

#### `withDeadline`

函数 · 迁移 · 替代 `@go-like/context#withDeadline`

派生一个在绝对时间点到期的子 Context。

```ts
export declare function withDeadline(
  parent: Context,
  deadline: Date
): readonly [Context, CancelFunc]
```

#### `withDeadlineCause`

函数 · 迁移 · 替代 `@go-like/context#withDeadlineCause`

派生一个在绝对时间点到期、并以指定原因取消的子 Context。

```ts
export declare function withDeadlineCause(
  parent: Context,
  deadline: Date,
  cause: Error | null
): readonly [Context, CancelFunc]
```

#### `withTimeout`

函数 · 迁移 · 替代 `@go-like/context#withTimeout`

派生一个在相对毫秒数后到期的子 Context。

```ts
export declare function withTimeout(
  parent: Context,
  timeoutMs: number
): readonly [Context, CancelFunc]
```

#### `withTimeoutCause`

函数 · 迁移 · 替代 `@go-like/context#withTimeoutCause`

派生一个在相对毫秒数后到期、并以指定原因取消的子 Context。

```ts
export declare function withTimeoutCause(
  parent: Context,
  timeoutMs: number,
  cause: Error | null
): readonly [Context, CancelFunc]
```

#### `withValue`

函数 · 迁移 · 替代 `@go-like/context#withValue`

派生一个携带键值对的子 Context，键按 `===` 比较。

```ts
export declare function withValue(parent: Context, key: unknown, value: unknown): Context
```

#### `withoutCancel`

函数 · 迁移 · 替代 `@go-like/context#withoutCancel`

派生一个隐藏取消与截止时间、但保留值的子 Context，用于不应被调用方取消打断的清理工作。

```ts
export declare function withoutCancel(parent: Context): Context
```

#### `afterFunc`

函数 · 迁移 · 替代 `@go-like/context#afterFunc`

在 Context 被取消后运行一次 `fn`，返回可阻止其执行的 `StopFunc`。

```ts
export declare function afterFunc(context: Context, fn: () => void): StopFunc
```

#### `waitForContext`

函数 · 迁移 · 替代 `@go-like/core/lifecycle#waitForContext`

等待一个 promise，但只让调用者的等待受 `ctx` 约束：`ctx` 先结束时以 `cause(ctx) ?? ctx.err()` reject，且从不取消该操作本身。所有需要“等待但不终止”语义的插件（排空、启动、绑定）都应使用它。

```ts
export declare function waitForContext<T>(ctx: Context, operation: Promise<T>): Promise<T>
```

#### `ContextError`

接口 · 迁移 · 替代 `@go-like/context#ContextError`

稳定的取消错误，由 Context 的 `err()` 暴露。

```ts
export interface ContextError extends Error {}
```

#### `TimeoutContextError`

接口 · 迁移 · 替代 `@go-like/context#TimeoutContextError`

带 Go 兼容 `timeout()`/`temporary()` 谓词的截止时间错误。

```ts
export interface TimeoutContextError extends ContextError {
  timeout(): boolean
  temporary(): boolean
}
```

#### `Context`　[插座]

接口 · 迁移 · 替代 `@go-like/context#Context`

跨 API 边界携带截止时间、取消、错误与请求范围值的上下文；与 Go 的 `context.Context` 同形。

```ts
export interface Context {
  deadline(): readonly [Date, boolean]
  done(): AbortSignal | null
  err(): ContextError | null
  value(key: unknown): unknown
}
```

#### `CancelFunc`

类型 · 迁移 · 替代 `@go-like/context#CancelFunc`

取消一个派生 Context 的函数，幂等。

```ts
export type CancelFunc = () => void
```

#### `CancelCauseFunc`

类型 · 迁移 · 替代 `@go-like/context#CancelCauseFunc`

带原因地取消一个派生 Context 的函数，幂等。

```ts
export type CancelCauseFunc = (cause: Error | null) => void
```

#### `StopFunc`

类型 · 迁移 · 替代 `@go-like/context#StopFunc`

取消 `afterFunc` 注册的回调；返回回调是否被成功阻止执行。

```ts
export type StopFunc = () => boolean
```

#### `canceled`

常量 · 迁移 · 替代 `@go-like/context#canceled`

表示被取消的冻结哨兵错误，按身份比较。

```ts
export declare const canceled: ContextError
```

#### `deadlineExceeded`

常量 · 迁移 · 替代 `@go-like/context#deadlineExceeded`

表示截止时间已到的冻结哨兵错误，按身份比较。

```ts
export declare const deadlineExceeded: TimeoutContextError
```

### `@go-like/core/metadata`

角色：机制；lane：P；20 个导出。

请求元数据模型与 Context 辅助函数：大小写折叠的多值映射、不可变操作，以及客户端（出站）与服务端（入站）两个 Context 载体。trace 上下文不再走 metadata，而是真实的 `traceparent` 头。由 core 自己实现，transport、server、client 与应用消费。

#### `newMetadata`

函数 · 迁移 · 替代 `@go-like/metadata#newMetadata`

从输入记录构建冻结的元数据快照。

```ts
export declare function newMetadata(input?: MetadataInput): Metadata
```

#### `clone`

函数 · 迁移 · 替代 `@go-like/metadata#clone`

复制一份元数据快照。

```ts
export declare function clone(metadata: Metadata): Metadata
```

#### `get`

函数 · 迁移 · 替代 `@go-like/metadata#get`

读取某个键的第一个值，没有则返回 `null`。

```ts
export declare function get(metadata: Metadata, key: string): string | null
```

#### `values`

函数 · 迁移 · 替代 `@go-like/metadata#values`

读取某个键的全部值。

```ts
export declare function values(metadata: Metadata, key: string): readonly string[]
```

#### `keys`

函数 · 迁移 · 替代 `@go-like/metadata#keys`

列出全部键。

```ts
export declare function keys(metadata: Metadata): readonly string[]
```

#### `append`

函数 · 迁移 · 替代 `@go-like/metadata#append`

返回追加了一个值的新快照。

```ts
export declare function append(metadata: Metadata, key: string, value: MetadataValue): Metadata
```

#### `set`

函数 · 迁移 · 替代 `@go-like/metadata#set`

返回把某个键设为单一值的新快照。

```ts
export declare function set(metadata: Metadata, key: string, value: string): Metadata
```

#### `remove`

函数 · 迁移 · 替代 `@go-like/metadata#remove`

返回删除某个键的新快照。

```ts
export declare function remove(metadata: Metadata, key: string): Metadata
```

#### `merge`

函数 · 迁移 · 替代 `@go-like/metadata#merge`

返回合并了 `patch` 的新快照。

```ts
export declare function merge(metadata: Metadata, patch: Metadata): Metadata
```

#### `newClientContext`

函数 · 迁移 · 替代 `@go-like/metadata#newClientContext`

把出站元数据放进 Context，由 client 随调用发送。

```ts
export declare function newClientContext(ctx: Context, metadata: Metadata): Context
```

#### `fromClientContext`

函数 · 迁移 · 替代 `@go-like/metadata#fromClientContext`

读取出站元数据，没有则返回 `null`。

```ts
export declare function fromClientContext(ctx: Context): Metadata | null
```

#### `appendToClientContext`

函数 · 迁移 · 替代 `@go-like/metadata#appendToClientContext`

以键值对交替的形式向出站元数据追加条目。

```ts
export declare function appendToClientContext(
  ctx: Context,
  ...keyValues: readonly string[]
): Context
```

#### `mergeToClientContext`

函数 · 迁移 · 替代 `@go-like/metadata#mergeToClientContext`

把 `patch` 合并进出站元数据。

```ts
export declare function mergeToClientContext(ctx: Context, patch: Metadata): Context
```

#### `newServerContext`

函数 · 迁移 · 替代 `@go-like/metadata#newServerContext`

把入站元数据放进 Context，由 server 在处理请求时设置。

```ts
export declare function newServerContext(ctx: Context, metadata: Metadata): Context
```

#### `fromServerContext`

函数 · 迁移 · 替代 `@go-like/metadata#fromServerContext`

读取入站元数据，没有则返回 `null`。

```ts
export declare function fromServerContext(ctx: Context): Metadata | null
```

#### `propagateToClientContext`

函数 · 迁移 · 替代 `@go-like/metadata#propagateToClientContext`

按显式允许名单把入站元数据复制到出站元数据；没有规则就不传播。

```ts
export declare function propagateToClientContext(
  ctx: Context,
  options?: PropagationOptions
): Context
```

#### `MetadataValue`

类型 · 迁移 · 替代 `@go-like/metadata#MetadataValue`

元数据的单个取值：一个字符串或字符串数组。

```ts
export type MetadataValue = string | readonly string[]
```

#### `MetadataInput`

类型 · 迁移 · 替代 `@go-like/metadata#MetadataInput`

构建元数据用的输入记录。

```ts
export type MetadataInput = Readonly<Record<string, MetadataValue>>
```

#### `Metadata`

类型 · 迁移 · 替代 `@go-like/metadata#Metadata`

键折叠为小写的多值映射；本入口返回的快照是冻结且带品牌的。

```ts
export type Metadata = Readonly<Record<string, readonly string[]>>
```

#### `PropagationOptions`

接口 · 迁移 · 替代 `@go-like/metadata#PropagationOptions`

`propagateToClientContext` 的显式允许名单：精确键与前缀；没有规则就不传播。

```ts
export interface PropagationOptions {
  readonly exact?: readonly string[]
  readonly prefix?: readonly string[]
}
```

### `@go-like/core/struct`

角色：机制；lane：P；19 个导出。

core 自带的结构化 schema 语言：`struct` 构建器、按 wire 别名编解码的 `encodeJson`/`decodeJson`，以及参考 `Codec` 实现 `jsonCodec`。每个构建器结果都实现标准 Schema（`"~standard"`），因此可直接交给 config 等接受 Standard Schema 的消费者；RPC 契约只接受 `Struct`，因为 wire 编码需要标准 Schema 没有定义的别名感知。由 core 自己实现，应用与 transport/server/client 消费。

#### `isStructError`

函数 · 新增

跨 realm 安全的 `StructError` 判断（模块内 WeakSet 品牌），取代 `instanceof StructError`。

```ts
export declare function isStructError(value: unknown): value is StructError
```

#### `encodeJson`

函数 · 迁移 · 替代 `@go-like/struct/codec#encodeJson`

按精确 wire 别名键把 struct 值编码为 JSON 数据树（不做 `JSON.stringify`）。

```ts
export declare function encodeJson(
  struct: StructLike<unknown, unknown, boolean>,
  value: unknown
): unknown
```

#### `decodeJson`

函数 · 迁移 · 替代 `@go-like/struct/codec#decodeJson`

按精确 wire 键解码一个 JSON 数据树并返回 `Infer<S>`；校验失败抛出 `StructError`。

```ts
export declare function decodeJson<S extends StructLike<unknown, unknown, boolean>>(
  struct: S,
  value: unknown
): Infer<S>
```

#### `jsonCodec`

函数 · 新增

为一个 struct 构建参考 `Codec` 实现：把事件或任务载荷编码成 JSON 字节并按 wire 别名校验解码。RPC 只支持 JSON（Connect 插件覆盖 protobuf）。

```ts
export declare function jsonCodec<S extends StructLike<unknown, unknown, boolean>>(
  struct: S
): JsonCodec<Infer<S>>
```

#### `ErrorMap`

类型 · 迁移 · 替代 `@go-like/struct#ErrorMap`

改写单条校验问题消息的回调；返回 undefined 表示沿用默认消息。

```ts
export type ErrorMap = (issue: StructIssue) => string | undefined
```

#### `StructIssue`

接口 · 迁移 · 替代 `@go-like/struct#StructIssue`

一次校验失败产生的单条问题：机器可读的 `code`、期望描述、最终消息、从根到失败位置的路径和失败的值。

```ts
export interface StructIssue {
  /** 机器可读的失败类别。 */
  code:
    | "custom"
    | "invalid_enum"
    | "invalid_literal"
    | "invalid_type"
    | "invalid_union"
    | "missing_key"
  /** 期望类型或取值的可读描述。 */
  expected: string
  /** 经过可选 `ErrorMap` 改写后的最终消息。 */
  message: string
  /** 从校验根到失败位置的路径。 */
  path: Path
  /** 在 `path` 处校验失败的值。 */
  received: unknown
}
```

#### `FormattedStructError`

接口 · 迁移 · 替代 `@go-like/struct#FormattedStructError`

`StructError.format()` 返回的嵌套错误树：叶子消息在 `_errors`，嵌套键镜像失败路径。

```ts
export interface FormattedStructError {
  _errors: string[]
  [key: string]: FormattedStructError | string[]
}
```

#### `FlattenedStructError`

接口 · 迁移 · 替代 `@go-like/struct#FlattenedStructError`

`StructError.flatten()` 返回的扁平错误袋：`formErrors` 收集根级问题，`fieldErrors` 按路径首段分组。

```ts
export interface FlattenedStructError {
  /** 路径为空（根级）的问题消息。 */
  formErrors: string[]
  /** 按路径第一段分组的问题消息。 */
  fieldErrors: { [key: string]: string[] }
}
```

#### `StructError`

接口 · 语义变化 · 替代 `@go-like/struct#StructError`

结构校验失败的错误：由 core 内部构造，用 `isStructError` 判断；稳定 code 为 `GO_LIKE_STRUCT_INVALID`。由 class 改为 interface，符合 core 公共 API 只暴露函数与接口的约定。

```ts
export interface StructError extends Error {
  readonly name: "StructError"
  readonly code: "GO_LIKE_STRUCT_INVALID"
  readonly issues: readonly StructIssue[]
  /** 按路径构建嵌套错误树。 */
  format(): FormattedStructError
  /** 拆成根级 `formErrors` 与按首段分组的 `fieldErrors`。 */
  flatten(): FlattenedStructError
}
```

#### `StructLike`

接口 · 迁移 · 替代 `@go-like/struct#StructLike`

每个 struct 实例携带的最小结构品牌：`_struct` 保存供 `Infer`/`StructInput` 使用的 input/output 幻影类型。

```ts
export interface StructLike<I = unknown, O = unknown, OO extends boolean = boolean> {
  readonly _struct: StructTypes<I, O, OO>
}
```

#### `StructMethods`

接口 · 语义变化 · 替代 `@go-like/struct#StructMethods`

所有 `Struct` 实例上可链式调用的修饰方法，同时是标准 Schema 的载体：`"~standard".validate(value)` 按 wire 别名解码（`decodeJson` 语义），同步返回 `{ value }` 或 `{ issues }`。

```ts
export interface StructMethods<I, O, OO extends boolean> {
  /** 标准 Schema 实现：`vendor` 为 `"go-like"`，`validate` 同步，按 wire 别名解码。 */
  readonly "~standard": StandardSchemaV1.Props<I, O>
  /** 覆盖该字段的外部 wire 名，不改变 TypeScript 属性名。 */
  alias(name: string): Struct<I, O, OO>
  /** 额外接受 `null`。 */
  null(): Struct<I | null, O | null, OO>
  /** `null()` 的别名。 */
  nullable(): Struct<I | null, O | null, OO>
  /** 额外接受 `null` 与 `undefined`，并在对象输出中标记为可选。 */
  nullish(): Struct<I | null | undefined, O | null | undefined, true>
  /** 额外接受 `undefined`，并在对象形状中标记为可选。 */
  optional(): Struct<I | undefined, O | undefined, true>
}
```

#### `Struct`

类型 · 语义变化 · 替代 `@go-like/struct#Struct`

公共 struct 契约：修饰方法加 `_struct` 类型品牌；每个实例同时是 `StandardSchemaV1<Input, Output>`。通过 `struct` 门面构建（`struct.string()`、`struct.object()` 等）。

```ts
export type Struct<
  Input = unknown,
  Output = Input,
  OptionalOut extends boolean = false
> = StructMethods<Input, Output, OptionalOut> & StructLike<Input, Output, OptionalOut>
```

#### `AnyStruct`

类型 · 语义变化 · 替代 `@go-like/struct#AnyStruct`

不关心具体 input/output 的调用方使用的宽约束；需要精确推断时用具体的 `Struct<...>`。

```ts
export type AnyStruct = Struct<any, any, boolean>
```

#### `ObjectStruct`

接口 · 语义变化 · 替代 `@go-like/struct#ObjectStruct`

`struct.object(shape)` 产生的对象 struct：字段是否出现取决于各字段的 optional/nullish 修饰，wire 名可用 `.alias()` 改写。经由 `StructMethods` 携带 `"~standard"`。

```ts
export interface ObjectStruct<T extends ObjectShape>
  extends
    StructMethods<ObjectInput<T>, ObjectOutput<T>, false>,
    StructLike<ObjectInput<T>, ObjectOutput<T>, false> {
  readonly _struct: ObjectStructTypes<T>
}
```

#### `StructInput`

类型 · 迁移 · 替代 `@go-like/struct#StructInput`

推断 struct 接受的 input 类型。

```ts
export type StructInput<T> = T extends { readonly _struct: { readonly input: unknown } }
  ? T["_struct"]["input"]
  : never
```

#### `Infer`

类型 · 迁移 · 替代 `@go-like/struct#Infer`

推断 struct 解析后的 output 类型。

```ts
export type Infer<T> = StructOutput<T>
```

#### `ParseResult`

类型 · 迁移 · 替代 `@go-like/struct#ParseResult`

`struct.parse` 的错误优先元组：成功为 `[null, value]`，失败为 `[StructError, undefined]`。

```ts
export type ParseResult<O> = [error: null, value: O] | [error: StructError, value: undefined]
```

#### `struct`

常量 · 语义变化 · 替代 `@go-like/struct#struct`

struct 构建器门面：每个成员构建一种 schema，`parse` 返回错误优先元组；所有构建结果都携带 `"~standard"`。成员与今天的 `@go-like/struct` 一致。

```ts
export declare const struct: {
  readonly any: () => Struct<PresentValue, any>
  readonly array: <S extends StructLike<unknown, unknown, boolean>>(item: S) => ArrayStruct<S>
  readonly arrayBuffer: () => Struct<ArrayBuffer, ArrayBuffer>
  readonly bigint: () => Struct<bigint | string, bigint>
  readonly blob: () => Struct<Blob, Blob>
  readonly boolean: () => Struct<boolean, boolean>
  readonly date: () => Struct<Date | number | string, Date>
  readonly discriminatedUnion: <
    const D extends string,
    const O extends readonly [ObjectStruct<ObjectShape>, ...ObjectStruct<ObjectShape>[]]
  >(
    discriminator: D,
    options: O & RequiredDiscriminatorOptions<D, O>
  ) => DiscriminatedUnionStruct<O>
  readonly enum: {
    <const T extends readonly [string, ...string[]]>(value: T): Struct<T[number], T[number]>
    <const T extends { [key: string]: number | string }>(value: T): Struct<T[keyof T], T[keyof T]>
  }
  readonly file: () => Struct<File, File>
  readonly intersection: <
    const T extends readonly [
      StructLike<unknown, unknown, boolean>,
      ...StructLike<unknown, unknown, boolean>[]
    ]
  >(
    ...structs: T
  ) => Struct<IntersectionInput<T>, IntersectionOutput<T>>
  readonly literal: <const T extends boolean | null | number | string>(value: T) => Struct<T, T>
  readonly null: () => Struct<null, null>
  readonly number: () => Struct<number, number>
  readonly object: <T extends ObjectShape>(shape: T) => ObjectStruct<T>
  readonly or: <const T extends readonly [StructLike, ...StructLike[]]>(
    ...options: T
  ) => UnionStruct<T>
  readonly parse: <S extends StructLike<unknown, unknown, boolean>>(
    struct: S,
    value: unknown,
    options?: { aliases?: boolean; errorMap?: ErrorMap }
  ) => ParseResult<S["_struct"]["output"]>
  readonly record: <S extends StructLike<unknown, unknown, boolean>>(value: S) => RecordStruct<S>
  readonly string: () => Struct<string, string>
  readonly tuple: <
    const T extends readonly [
      StructLike<unknown, unknown, boolean>,
      ...StructLike<unknown, unknown, boolean>[]
    ]
  >(
    items: T
  ) => TupleStruct<T>
  readonly unknown: () => Struct<PresentValue, unknown>
}
```

#### `JsonCodec`

接口 · 新增

`jsonCodec` 的结果：UTF-8 JSON 字节与 `Infer<S>` 互转。结构上满足 `@go-like/core/broker` 的 `Codec<T>`，因此 `/struct` 不依赖 `/broker`。

```ts
export interface JsonCodec<T> {
  readonly mediaType: "application/json"
  /** `utf8(JSON.stringify(encodeJson(struct, value)))`。 */
  encode(value: T): Uint8Array
  /** `decodeJson(struct, JSON.parse(fatalUtf8(bytes)))`；字节不是合法 UTF-8/JSON 或校验失败时抛出（后者为 `StructError`）。 */
  decode(bytes: Uint8Array): T
}
```

### `@go-like/core/health`

角色：插座+机制；lane：P；7 个导出。

与协议无关的探针注册表：应用、插件和 App 自己（`readyProbe`）把存活/就绪检查注册进来，由消费者（如 web 的 `createHealthHandler`）汇总。空的 "live" 通过，空的 "ready" 失败闭合。由 core 提供内存参考实现 `newProbeRegistry`，也允许任何结构兼容的实现。

#### `newProbeRegistry`

函数 · 迁移 · 替代 `@go-like/health#newProbeRegistry`

构建内存参考注册表：默认 1000 毫秒探针超时，限制公开名称，拒绝重名，空的 ready 失败闭合。

```ts
export declare function newProbeRegistry(): ProbeRegistry
```

#### `ProbeKind`

类型 · 迁移 · 替代 `@go-like/health#ProbeKind`

探针种类：`"live"` 表示存活，`"ready"` 表示就绪。

```ts
export type ProbeKind = "live" | "ready"
```

#### `Probe`　[插座]

类型 · 迁移 · 替代 `@go-like/health#Probe`

一次存活或就绪检查；抛出或 reject 即失败，每次检查受其超时 Context 限制。

```ts
export type Probe = (ctx: Context) => void | Promise<void>
```

#### `ProbeOptions`

接口 · 迁移 · 替代 `@go-like/health#ProbeOptions`

注册探针时的选项。

```ts
export interface ProbeOptions {
  /** 单次检查的超时毫秒数，默认 1000。 */
  readonly timeoutMs?: number
}
```

#### `ProbeResult`

接口 · 迁移 · 替代 `@go-like/health#ProbeResult`

单个探针的检查结果。

```ts
export interface ProbeResult {
  readonly name: string
  readonly ok: boolean
  readonly error: Error | null
}
```

#### `ProbeReport`

接口 · 迁移 · 替代 `@go-like/health#ProbeReport`

一种探针的汇总报告：全部通过才为 `ok`。

```ts
export interface ProbeReport {
  readonly kind: ProbeKind
  readonly ok: boolean
  readonly checks: readonly ProbeResult[]
}
```

#### `ProbeRegistry`　[插座]

接口 · 迁移 · 替代 `@go-like/health#ProbeRegistry`

与协议无关的探针注册表：`register` 返回幂等的注销函数，`check` 按注册顺序并发运行同一种类的全部探针。

```ts
export interface ProbeRegistry {
  register(kind: ProbeKind, name: string, probe: Probe, options?: ProbeOptions): () => boolean
  check(ctx: Context, kind: ProbeKind): Promise<ProbeReport>
}
```

### `@go-like/core/resilience`

角色：插座+机制；lane：P；22 个导出。

韧性原语：显式授权的 `retry` 与退避、内存熔断器，以及可由本地或远端存储回答的异步 `RateLimiter` socket 及令牌桶参考实现。`CircuitBreaker` 是机制而不是 socket（没有 API 接受外部实现）。由 core 实现，client/server 中间件与应用消费；重试与熔断转移会记录 telemetry 事件。

#### `retry`

函数 · 迁移 · 替代 `@go-like/resilience#retry`

带显式授权、有限次数和 Context 感知延迟的重试；从第 2 次尝试起每次前记录 `retry.scheduled` 事件。

```ts
export declare function retry<T>(
  ctx: Context,
  operation: RetryOperation<T>,
  options: RetryOptions
): Promise<T>
```

#### `exponentialBackoff`

函数 · 迁移 · 替代 `@go-like/resilience#exponentialBackoff`

构建指数退避策略。

```ts
export declare function exponentialBackoff(options: BackoffOptions): Backoff
```

#### `newCircuitBreaker`

函数 · 语义变化 · 替代 `@go-like/resilience#newCircuitBreaker`

构建内存熔断器；每次状态转移（含从 open 惰性进入 half-open）都会记录 `circuit_breaker.transition` 事件。

```ts
export declare function newCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker
```

#### `newTokenBucketLimiter`

函数 · 语义变化 · 替代 `@go-like/resilience#newTokenBucketLimiter`

构建内存令牌桶限流器，返回 `TokenBucketLimiter`。

```ts
export declare function newTokenBucketLimiter(options: TokenBucketOptions): TokenBucketLimiter
```

#### `RetryAuthorization`

类型 · 迁移 · 替代 `@go-like/resilience#RetryAuthorization`

重试授权：`"idempotent"` 表示操作天然幂等，`"caller-approved"` 表示调用者明确接受重复执行的风险。

```ts
export type RetryAuthorization = "idempotent" | "caller-approved"
```

#### `RetryOperation`

类型 · 迁移 · 替代 `@go-like/resilience#RetryOperation`

被重试的操作，`attempt` 从 1 开始。

```ts
export type RetryOperation<T> = (ctx: Context, attempt: number) => T | Promise<T>
```

#### `RetryPredicate`

类型 · 迁移 · 替代 `@go-like/resilience#RetryPredicate`

决定某次失败是否值得重试的谓词，可异步。

```ts
export type RetryPredicate = (
  ctx: Context,
  failure: unknown,
  attempt: number
) => boolean | Promise<boolean>
```

#### `Backoff`

类型 · 迁移 · 替代 `@go-like/resilience#Backoff`

退避策略：由尝试序号计算下一次等待的毫秒数；纯计算，保持同步。

```ts
export type Backoff = (attempt: number) => number
```

#### `RetryOptions`

接口 · 迁移 · 替代 `@go-like/resilience#RetryOptions`

`retry` 的选项：必须显式声明授权、最大尝试次数与重试谓词，可选退避策略。

```ts
export interface RetryOptions {
  readonly authorization: RetryAuthorization
  readonly maxAttempts: number
  readonly shouldRetry: RetryPredicate
  readonly backoff?: Backoff
}
```

#### `BackoffOptions`

接口 · 迁移 · 替代 `@go-like/resilience#BackoffOptions`

`exponentialBackoff` 的选项。

```ts
export interface BackoffOptions {
  readonly initialDelayMs: number
  readonly multiplier?: number
  readonly maxDelayMs?: number
}
```

#### `CircuitState`

类型 · 迁移 · 替代 `@go-like/resilience#CircuitState`

熔断器状态。

```ts
export type CircuitState = "closed" | "open" | "half-open"
```

#### `CircuitOperation`

类型 · 迁移 · 替代 `@go-like/resilience#CircuitOperation`

在熔断器保护下执行的操作。

```ts
export type CircuitOperation<T> = (ctx: Context) => T | Promise<T>
```

#### `CircuitFailurePredicate`

类型 · 迁移 · 替代 `@go-like/resilience#CircuitFailurePredicate`

判断一次失败是否计入熔断的谓词，可异步。

```ts
export type CircuitFailurePredicate = (ctx: Context, failure: unknown) => boolean | Promise<boolean>
```

#### `CircuitBreakerOptions`

接口 · 语义变化 · 替代 `@go-like/resilience#CircuitBreakerOptions`

`newCircuitBreaker` 的选项；新增的 `name` 会作为 `go_like.circuit_breaker.name` 记录在状态转移上。

```ts
export interface CircuitBreakerOptions {
  readonly failureThreshold: number
  readonly resetTimeoutMs: number
  readonly isFailure?: CircuitFailurePredicate
  /** 有界、由代码定义的名称：非空、不超过 128 个 UTF-16 单元且无控制字符，否则 `TypeError`。 */
  readonly name?: string
}
```

#### `CircuitSnapshot`

接口 · 迁移 · 替代 `@go-like/resilience#CircuitSnapshot`

熔断器某一时刻的快照。

```ts
export interface CircuitSnapshot {
  readonly state: CircuitState
  readonly consecutiveFailures: number
  readonly probeActive: boolean
  readonly retryAfterMs: number
}
```

#### `CircuitBreaker`

接口 · 迁移 · 替代 `@go-like/resilience#CircuitBreaker`

熔断器机制接口（不是 socket：没有任何 API 接受外部实现），`snapshot()` 保持同步。

```ts
export interface CircuitBreaker {
  execute<T>(ctx: Context, operation: CircuitOperation<T>): Promise<T>
  snapshot(): CircuitSnapshot
}
```

#### `circuitOpen`

常量 · 迁移 · 替代 `@go-like/resilience#circuitOpen`

熔断打开时拒绝调用所用的冻结哨兵错误，按身份比较。

```ts
export declare const circuitOpen: Error
```

#### `RateLimitDecision`

接口 · 迁移 · 替代 `@go-like/resilience#RateLimitDecision`

一次限流决策：是否放行，以及被拒时建议的等待毫秒数。

```ts
export interface RateLimitDecision {
  readonly allowed: boolean
  readonly retryAfterMs: number
}
```

#### `RateLimiter`　[插座]

接口 · 语义变化 · 替代 `@go-like/resilience#RateLimiter`

对一个工作单元的准入决策；可由本地回答，也可由远端存储回答，因此 `allow` 可以返回 Promise。

```ts
export interface RateLimiter {
  allow(ctx: Context): RateLimitDecision | Promise<RateLimitDecision>
}
```

#### `RateLimiterSnapshot`

接口 · 迁移 · 替代 `@go-like/resilience#RateLimiterSnapshot`

令牌桶限流器的快照。

```ts
export interface RateLimiterSnapshot {
  readonly availableTokens: number
  readonly capacity: number
  readonly nextRefillInMs: number
}
```

#### `TokenBucketOptions`

接口 · 迁移 · 替代 `@go-like/resilience#TokenBucketOptions`

令牌桶限流器的选项。

```ts
export interface TokenBucketOptions {
  readonly capacity: number
  readonly refillTokens: number
  readonly refillIntervalMs: number
  readonly initialTokens?: number
}
```

#### `TokenBucketLimiter`

接口 · 新增

内存令牌桶限流器的类型：同步的 `allow` 决策加 `snapshot()`；需要同步读取 `.allowed` 的代码应声明为此类型。

```ts
export interface TokenBucketLimiter extends RateLimiter {
  allow(ctx: Context): RateLimitDecision
  snapshot(): RateLimiterSnapshot
}
```

### `@go-like/core/telemetry`

角色：插座+机制；lane：P；17 个导出。

遥测基座入口：共享值类型、TelemetryLifecycle socket、provider 打包器 `Telemetry` 以及语义约定常量。由 otel、pino、winston、prometheus 等 plug 通过 `lifecycle` 成员接入；应用用 `newTelemetry` 打包后经 `newApp(telemetry(tel))` 交给 App，core 的各处插桩消费这里的常量。本入口不导入根入口。

#### `newTelemetry`

函数 · 新增

结构性校验每个 provider（任何 I/O 之前抛 TypeError）并构建 Telemetry 打包器；默认使用 W3C 传播器与 `completionLogs: "failures"`。

```ts
export declare function newTelemetry(options?: TelemetryOptions): Telemetry
```

#### `withTelemetry`

函数 · 新增

在 ctx 中携带一个 Telemetry（类似 withValue 的派生），用于 `newApp` 之前或之外的代码（启动期读配置、脚本、测试）；保留 ctx 的活动 span，重置已绑定的日志属性。

```ts
export declare function withTelemetry(ctx: Context, telemetry: Telemetry): Context
```

#### `AttributeValue`

类型 · 新增

与 OpenTelemetry 兼容的属性值（无 null 成员，不嵌套）。

```ts
export type AttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[]
```

#### `Attributes`

类型 · 新增

属性映射，trace 与 metric 两个 socket 共用。

```ts
export type Attributes = Readonly<Record<string, AttributeValue>>
```

#### `Scope`

接口 · 新增

插桩作用域（对应 OTel InstrumentationScope 与 Go 的 `otel.Tracer(name)` 参数）；core 自身使用 `{ name: "go-like" }`，用户句柄默认 `{ name: "app" }`。

```ts
export interface Scope {
  readonly name: string
  readonly version?: string
}
```

#### `TelemetryLifecycle`　[插座]

接口 · 新增

provider 在被 Telemetry 接纳后的生命周期；与 App 的 `Server` 契约结构相同，在此独立声明以免 socket 入口导入根入口。ADR 0003 语义：start 接纳并可保持挂起直到原生终态，stop 启动一次属主排空，调用方 ctx 只约束该调用方自己的等待。每个实现必须接受在 start 之前调用 stop：此时排空或关闭交给它的原生对象（D10）。

```ts
export interface TelemetryLifecycle {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}
```

#### `CompletionLogMode`

类型 · 新增

core 向已安装的日志 handler 写哪些工作单元的完成记录：全部、仅失败（默认）、不写。

```ts
export type CompletionLogMode = "all" | "failures" | "none"
```

#### `TelemetryOptions`

接口 · 新增

`newTelemetry` 的选项对象：至多一个 tracer provider，任意多个 meter provider 与日志 handler，可选传播器、完成日志模式与请求过滤。

```ts
export interface TelemetryOptions {
  /** At most one: span identity cannot be fanned out. */
  readonly tracerProvider?: TracerProvider
  /** Any number; every instrument records into each (Prometheus scrape + OTel push). */
  readonly meterProviders?: readonly MeterProvider[]
  /** Any number; core fans out to every handler whose enabled() is true. */
  readonly logHandlers?: readonly LogHandler[]
  /** undefined selects the W3C Trace Context propagator; null disables propagation. */
  readonly propagator?: Propagator | null
  /** Default "failures". */
  readonly completionLogs?: CompletionLogMode
  /** Web requests for which core records no unit at all (probes, scrapes). Must be cheap; a throw counts as false. */
  readonly ignoreRequest?: (request: Request) => boolean
}
```

#### `Telemetry`

接口 · 新增

一个显式的 provider 打包器，其生命周期只由 newApp 上的 `telemetry(...)` 或脚本的属主驱动。`server(...)` 与 `resources(...)` 在编译期拒绝它（D11）；品牌 symbol 保持模块私有。在 `start` 之前调用 `stop` 会不经接纳直接排空所有 provider 的 `lifecycle.stop` 并把 bundle 标记为已停止；此后再 `start` 以 `TelemetryAlreadyStartedError` 拒绝（D10）。

```ts
export interface Telemetry extends TelemetryLifecycle {
  readonly [telemetryBrand]: true
}
```

#### `TelemetryAlreadyStartedError`

接口 · 新增

`Telemetry.start` 的拒绝原因：bundle 已启动或已停止，因而不可再启动（错误码不变）。

```ts
export interface TelemetryAlreadyStartedError extends Error {
  readonly name: "TelemetryAlreadyStartedError"
  readonly code: "GO_LIKE_TELEMETRY_ALREADY_STARTED"
}
```

#### `SemconvVersion`

常量 · 新增

下列常量所核对的 OpenTelemetry 语义约定版本。

```ts
export declare const SemconvVersion: "1.45.0"
```

#### `AttributeKey`

常量 · 新增

span、指标与日志共用的属性键常量，分为 semconv 稳定键、semconv 开发中键与 `go_like.*` 命名空间键。`rpc.status_code` 的取值随 `rpc.system.name` 而定：go_like 为 ServiceError 码或 "ok"，grpc 与 connectrpc 为规范的大写 gRPC 状态名（`OK`、`DEADLINE_EXCEEDED`）。`go_like.job.system` 的取值为 `interval`、`memory`、`croner`、`bullmq`；`go_like.server.index` 是同一层（tier）内的下标，层由 `go_like.lifecycle.tier` 给出。

```ts
export declare const AttributeKey: {
  // stable in semconv 1.45.0
  readonly errorType: "error.type"
  readonly serviceName: "service.name"
  readonly serviceVersion: "service.version"
  readonly serviceInstanceId: "service.instance.id"
  readonly rpcSystemName: "rpc.system.name"
  readonly rpcMethod: "rpc.method"
  readonly rpcStatusCode: "rpc.status_code"
  readonly httpRequestMethod: "http.request.method"
  readonly httpResponseStatusCode: "http.response.status_code"
  readonly urlScheme: "url.scheme"
  // development (incubating) in semconv 1.45.0
  readonly messagingSystemName: "messaging.system.name"
  readonly messagingOperationName: "messaging.operation.name"
  readonly messagingOperationType: "messaging.operation.type"
  readonly messagingDestinationName: "messaging.destination.name"
  readonly messagingDestinationTemplate: "messaging.destination.template"
  readonly messagingMessageBodySize: "messaging.message.body.size"
  // go-like namespace
  readonly operation: "go_like.operation"
  readonly outcome: "go_like.outcome"
  readonly durationMs: "go_like.duration_ms"
  readonly rpcStream: "go_like.rpc.stream"
  readonly rpcStreamMessages: "go_like.rpc.stream.messages"
  readonly rpcStreamHandshakeMs: "go_like.rpc.stream.handshake_ms"
  readonly rpcStreamStatus: "go_like.rpc.stream.status"
  readonly rpcDirection: "go_like.rpc.direction"
  readonly jobName: "go_like.job.name"
  readonly jobTrigger: "go_like.job.trigger"
  readonly jobSystem: "go_like.job.system"
  readonly jobQueue: "go_like.job.queue"
  readonly jobId: "go_like.job.id"
  readonly jobAttempt: "go_like.job.attempt"
  readonly appStopReason: "go_like.app.stop.reason"
  readonly serverIndex: "go_like.server.index"
  /** "telemetry" | "resource" | "server": which App tier a lifecycle event belongs to (D8). */
  readonly lifecycleTier: "go_like.lifecycle.tier"
  readonly registryService: "go_like.registry.service"
  readonly registryInstances: "go_like.registry.instances"
  readonly retryAttempt: "go_like.retry.attempt"
  readonly retryDelayMs: "go_like.retry.delay_ms"
  readonly circuitBreakerName: "go_like.circuit_breaker.name"
  readonly circuitBreakerState: "go_like.circuit_breaker.state"
}
```

#### `SemconvValue`

常量 · 改名 · 替代 `@go-like/otel#RequestOutcome`、`@go-like/prometheus#RequestOutcome`

属性取值常量：`_OTHER` 兜底值、`rpc.system.name` 的三个取值、错误类型、消息操作、任务触发方式、流方向、完成结果与生命周期层。

```ts
export declare const SemconvValue: {
  readonly other: "_OTHER"
  readonly rpcSystemGoLike: "go_like"
  /** semconv 1.45.0 stable value of rpc.system.name. */
  readonly rpcSystemGrpc: "grpc"
  /** semconv 1.45.0 experimental value of rpc.system.name. */
  readonly rpcSystemConnectrpc: "connectrpc"
  readonly rpcStatusOk: "ok"
  readonly errorCanceled: "canceled"
  readonly errorDeadlineExceeded: "deadline_exceeded"
  readonly errorStreamTruncated: "stream_truncated"
  readonly messagingOperationTypeSend: "send"
  readonly messagingOperationTypeProcess: "process"
  readonly messagingOperationNamePublish: "publish"
  readonly messagingOperationNameProcess: "process"
  readonly jobTriggerSchedule: "schedule"
  readonly jobTriggerQueue: "queue"
  readonly directionSent: "sent"
  readonly directionReceived: "received"
  readonly outcomeSuccess: "success"
  readonly outcomeCallerFault: "caller_fault"
  readonly outcomeCanceled: "canceled"
  readonly outcomeFailure: "failure"
  readonly lifecycleTierTelemetry: "telemetry"
  readonly lifecycleTierResource: "resource"
  readonly lifecycleTierServer: "server"
}
```

#### `MetricName`

常量 · 改名 · 替代 `@go-like/otel#newRequestMetrics`

core 创建的指标名常量，名称遵循 semconv 1.45.0（RPC、HTTP、消息）与 `go_like.*` 命名空间。

```ts
export declare const MetricName: {
  readonly rpcServerCallDuration: "rpc.server.call.duration"
  readonly rpcClientCallDuration: "rpc.client.call.duration"
  readonly rpcStreamMessages: "go_like.rpc.stream.messages"
  readonly httpServerRequestDuration: "http.server.request.duration"
  readonly httpServerActiveRequests: "http.server.active_requests"
  readonly messagingClientOperationDuration: "messaging.client.operation.duration"
  readonly messagingProcessDuration: "messaging.process.duration"
  readonly jobRunDuration: "go_like.job.run.duration"
  readonly appReady: "go_like.app.ready"
  readonly configReloads: "go_like.config.reloads"
  readonly registryWatchUpdates: "go_like.registry.watch.updates"
  readonly retryAttempts: "go_like.retry.attempts"
  readonly circuitBreakerTransitions: "go_like.circuit_breaker.transitions"
  readonly rateLimitRejections: "go_like.rate_limit.rejections"
}
```

#### `LogEvent`

常量 · 新增

core 与 plug 写入 `LogRecord.event`（`event.name`）的事件名常量，覆盖完成记录与诊断事件。

```ts
export declare const LogEvent: {
  readonly rpcServerCompleted: "go_like.rpc.server.completed"
  readonly rpcClientCompleted: "go_like.rpc.client.completed"
  readonly httpServerCompleted: "go_like.http.server.completed"
  readonly messagingPublishCompleted: "go_like.messaging.publish.completed"
  readonly messagingProcessCompleted: "go_like.messaging.process.completed"
  readonly jobRunCompleted: "go_like.job.run.completed"
  readonly jobEnqueueCompleted: "go_like.job.enqueue.completed"
  readonly appStarted: "go_like.app.started"
  readonly appReady: "go_like.app.ready"
  readonly appStopping: "go_like.app.stopping"
  readonly appStopped: "go_like.app.stopped"
  readonly serverFailed: "go_like.server.failed"
  readonly configLoaded: "go_like.config.loaded"
  readonly configReloaded: "go_like.config.reloaded"
  readonly configReloadFailed: "go_like.config.reload_failed"
  readonly configTerminal: "go_like.config.terminal"
  readonly registryRegistered: "go_like.registry.registered"
  readonly registryDeregistered: "go_like.registry.deregistered"
  readonly registryWatchUpdated: "go_like.registry.watch.updated"
  readonly registryWatchFailed: "go_like.registry.watch.failed"
  readonly registryHeartbeatFailed: "go_like.registry.heartbeat_failed"
  readonly retryScheduled: "go_like.retry.scheduled"
  readonly circuitBreakerTransition: "go_like.circuit_breaker.transition"
  readonly rateLimitRejected: "go_like.rate_limit.rejected"
  readonly transportHandlerRejected: "go_like.transport.handler_rejected"
  readonly transportCleanupFailed: "go_like.transport.cleanup_failed"
  readonly webHostClientAborted: "go_like.web.host.client_aborted"
  readonly webHostResponseFailed: "go_like.web.host.response_failed"
  readonly instrumentFailed: "go_like.telemetry.instrument_failed"
}
```

#### `SpanEvent`

常量 · 新增

core 写入 span 的事件名常量。

```ts
export declare const SpanEvent: {
  readonly retry: "go_like.retry"
  readonly circuitBreakerTransition: "go_like.circuit_breaker.transition"
  readonly rateLimited: "go_like.rate_limited"
  readonly serverFailed: "go_like.server.failed"
}
```

#### `LogField`

常量 · 新增

每个日志 plug 写出的字段名（pino、winston）；OTel plug 把它们映射到 LogRecord 字段。

```ts
export declare const LogField: {
  readonly traceId: "trace_id"
  readonly spanId: "span_id"
  readonly traceFlags: "trace_flags"
  readonly event: "event.name"
  /** Diagnostic events (never completion records) attach the local Error under this attrs key. */
  readonly exception: "exception"
}
```

### `@go-like/core/telemetry/provider`

角色：插头 SDK；lane：P；16 个导出。

面向 plug 作者的遥测 SDK，应用代码不导入。两类使用者：拥有工作单元的 plug（broker 循环、任务执行器、gRPC/Connect 协议 plug）与填充遥测 socket 的 plug（otel、pino、winston、prometheus）。由 core 实现并导出，plug 消费；它只建立在 `@go-like/core/telemetry`、`log`、`trace` 之上。

#### `observing`

函数 · 改名 · 替代 `@go-like/transport/provider#observeCall`

判断 ctx 是否安装了遥测（一次 Context 查询）；为 false 时不构造 Unit，直接调用主体（禁用路径规则）。

```ts
export declare function observing(ctx: Context): boolean
```

#### `beginUnit`

函数 · 改名 · 替代 `@go-like/transport/provider#observeCall`

开始一个工作单元：从 carrier（若给出）提取远程父级，启动 span 与计时。对 `rpc.server` 单元，空 carrier 嵌套在显式 ctx 的 span 之下，从不使用隐式 span。

```ts
export declare function beginUnit(
  ctx: Context,
  unit: Unit,
  carrier?: PropagationCarrier | null
): UnitScope
```

#### `injectHeaders`

函数 · 新增

把 ctx 的追踪上下文用 set() 写入 Fetch headers，写入前先删除调用方提供的传播字段。

```ts
export declare function injectHeaders(ctx: Context, headers: Headers): void
```

#### `injectRecord`

函数 · 新增

返回冻结的 headers 副本：去掉调用方的传播字段（大小写不敏感），再加入 ctx 的追踪上下文。

```ts
export declare function injectRecord(
  ctx: Context,
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>>
```

#### `resourceFromContext`

函数 · 新增

App 由 AppInfo 派生的资源身份：service.name、service.version、service.instance.id（App 之外返回 {}）。

```ts
export declare function resourceFromContext(ctx: Context): Attributes
```

#### `logCorrelation`

函数 · 新增

返回 ctx 活动 span 的关联字段；ctx 不含有效 span 时返回 null（一次 Context 查询）。

```ts
export declare function logCorrelation(ctx: Context): LogCorrelation | null
```

#### `isValidSpanContext`

函数 · 新增

W3C 有效性判断：traceId 32 位、spanId 16 位小写十六进制，且不全为零。

```ts
export declare function isValidSpanContext(value: SpanContext): boolean
```

#### `withRemoteSpanContext`

函数 · 新增

把 ctx 的 span 设为冻结的非记录远程 span（供传播器使用）；身份无效时抛 TypeError。

```ts
export declare function withRemoteSpanContext(ctx: Context, context: SpanContext): Context
```

#### `logEvent`

函数 · 改名 · 替代 `@go-like/transport#TransportLogger`、`@go-like/registry#ProviderLogger`

plug 与 core 的诊断事件：写一条 record.event 等于 event（"go_like.<area>.*" 名称）的记录；本地 Error 放在 attrs[LogField.exception] 下。ctx 未安装任何 LogHandler 时，只有 level 为 error 的诊断事件以单行 JSON 写入 console.error，内容仅含 event.name、error.type 与 go_like.operation，从不含错误文本；其余级别与完成记录不写（D38，待维护者确认，OQ9）。未安装任何遥测时只做一次 Context 查询。

```ts
export declare function logEvent(
  ctx: Context,
  level: LogLevel,
  event: string,
  message: string,
  attrs?: LogAttrs
): void
```

#### `Unit`

类型 · 改名 · 替代 `@go-like/otel#RequestComponent`、`@go-like/prometheus#RequestComponent`

plug 可拥有的工作单元种类的判别联合；core 内部种类（http.server、app._、config._、registry.*）不导出。`go_like.job.system` 取值为 `interval`、`memory`、`croner`、`bullmq`；rpc 的 `system` 取值见 `SemconvValue.rpcSystem*`。

```ts
export type Unit =
  | {
      readonly kind: "rpc.server"
      readonly system: string // rpc.system.name: "go_like", "grpc", "connectrpc"
      readonly method: string // rpc.method: registered "service/endpoint", or "_OTHER"
      readonly stream: boolean
    }
  | {
      readonly kind: "rpc.client"
      readonly system: string
      readonly method: string
      readonly stream: boolean
    }
  | {
      readonly kind: "messaging.publish"
      readonly system: string // messaging.system.name
      readonly destination: string // concrete topic: span attribute only, never in the span name
      readonly bodySize: number
    }
  | {
      readonly kind: "messaging.process"
      readonly system: string
      readonly subscription: string // topic passed to subscribe (may be a wildcard): span name + template
      readonly destination: string // delivered event.topic: span attribute only
      readonly bodySize: number
    }
  | {
      readonly kind: "job.run"
      readonly system: string // go_like.job.system: "interval", "memory", "croner", "bullmq"
      readonly name: string // code-defined job name
      readonly trigger: "schedule" | "queue"
      readonly id: string | null // span attribute only
      readonly attempt: number // span attribute only; 1 for the first attempt
    }
  | {
      readonly kind: "job.enqueue"
      readonly system: string
      readonly name: string
      readonly queue: string
    }
```

#### `StreamResult`

接口 · 新增

流式 RPC 单元的终态结果：消息数、握手耗时与状态。

```ts
export interface StreamResult {
  readonly messages: number
  readonly handshakeMs: number
  readonly status: "success" | "canceled" | "truncated" | "error"
  /** Terminal SSE error code (ServiceError code) when status is "error". */
  readonly code: string | null
}
```

#### `UnitResult`

接口 · 新增

结束一个工作单元时交给 `UnitScope.end` 的结果。`rpcStatusCode` 的取值随系统而定：go_like 为 ServiceError 码或 "ok"，grpc 与 connectrpc 为规范的大写 gRPC 状态名（`OK`、`DEADLINE_EXCEEDED`）。

```ts
export interface UnitResult {
  /** Classified into a bounded error.type only; never serialized or copied. */
  readonly error?: unknown
  /** RPC units: system-specific protocol status (go_like: ServiceError code or "ok"; grpc and connectrpc: upper-case gRPC status name). Default "ok" on success. */
  readonly rpcStatusCode?: string
  /** Server-side units: the request was rejected for a caller fault (ServiceError status < 500, gRPC INVALID_ARGUMENT). Span status stays UNSET. */
  readonly callerFault?: boolean
  readonly httpStatus?: number
  readonly stream?: StreamResult
}
```

#### `UnitScope`

接口 · 新增

`beginUnit` 返回的单元作用域：携带单元 span 的 ctx、在 provider 隐式作用域内运行的 `run`，以及恰好一次的 `end`。

```ts
export interface UnitScope {
  /** ctx with the extracted parent and the unit span; derive every child from it. */
  readonly ctx: Context
  /** Runs fn(ctx) inside the tracer provider's implicit scope (TracerProvider.enter). */
  run<R>(fn: (ctx: Context) => R): R
  /** Completes the unit exactly once: span end, metrics, completion log. Later calls are no-ops. */
  end(result?: UnitResult): void
}
```

#### `PropagationCarrier`

类型 · 新增

传播载体：Fetch `Headers` 或字符串记录。

```ts
export type PropagationCarrier = Headers | Readonly<Record<string, string>>
```

#### `LogCorrelation`

接口 · 新增

每个日志 plug 写出的三个关联字段，键为 LogField 名称。

```ts
export interface LogCorrelation {
  readonly trace_id: string
  readonly span_id: string
  readonly trace_flags: string // two lowercase hex digits
}
```

#### `LogSeverityNumber`

常量 · 新增

每个 LogLevel 对应的 OTel SeverityNumber（日志数据模型：DEBUG 5、INFO 9、WARN 13、ERROR 17）。

```ts
export declare const LogSeverityNumber: {
  readonly debug: 5
  readonly info: 9
  readonly warn: 13
  readonly error: 17
}
```

### `@go-like/core/log`

角色：插座+机制；lane：P；12 个导出。

日志入口：声明 LogHandler socket，并提供以 Context 为首参的 `log.*` 前端。由 `@go-like/pino/log`、`@go-like/winston/log`、`@go-like/otel` 实现 LogHandler；应用代码与 core 的完成记录、诊断事件通过本入口写日志。

#### `log`

函数 · 新增

以给定级别写一条日志；ctx 中没有 LogHandler 时是一次 Context 查询后的空操作。

```ts
export declare function log(ctx: Context, level: LogLevel, message: string, attrs?: LogAttrs): void
```

#### `debug`

函数 · 新增

写一条 debug 级别日志。

```ts
export declare function debug(ctx: Context, message: string, attrs?: LogAttrs): void
```

#### `info`

函数 · 新增

写一条 info 级别日志。

```ts
export declare function info(ctx: Context, message: string, attrs?: LogAttrs): void
```

#### `warn`

函数 · 新增

写一条 warn 级别日志。

```ts
export declare function warn(ctx: Context, message: string, attrs?: LogAttrs): void
```

#### `error`

函数 · 新增

写一条 error 级别日志。

```ts
export declare function error(ctx: Context, message: string, attrs?: LogAttrs): void
```

#### `enabled`

函数 · 新增

级别守卫，用于避免构造昂贵属性（对应 slog Logger.Enabled）。

```ts
export declare function enabled(ctx: Context, level: LogLevel): boolean
```

#### `withLogAttrs`

函数 · 新增

派生一个其记录都带有 attrs 的 ctx（对应 slog Logger.With）；没有 handler 或 attrs 为 {} 时原样返回 ctx。

```ts
export declare function withLogAttrs(ctx: Context, attrs: LogAttrs): Context
```

#### `LogLevel`

类型 · 改名 · 替代 `@go-like/transport#TransportLogLevel`、`@go-like/registry#ProviderLogLevel`

日志级别，沿用 pino 与 winston 的名称，对应 OTel SeverityNumber 5、9、13、17。

```ts
export type LogLevel = "debug" | "info" | "warn" | "error"
```

#### `LogValue`

类型 · 新增

结构化日志值：属性值、null、本地 Error（诊断与用户日志）或嵌套映射。

```ts
export type LogValue = AttributeValue | null | Error | { readonly [key: string]: LogValue }
```

#### `LogAttrs`

类型 · 新增

一条日志的属性映射。

```ts
export type LogAttrs = Readonly<Record<string, LogValue>>
```

#### `LogRecord`

接口 · 新增

交给 handler 的一条日志记录；handler 没有 withAttrs 时，attrs 已包含绑定属性。

```ts
export interface LogRecord {
  readonly time: number // epoch milliseconds
  readonly level: LogLevel
  readonly message: string
  readonly event: string // "go_like.*" for core events, "" for user records
  readonly attrs: LogAttrs
}
```

#### `LogHandler`　[插座]

接口 · 新增

日志后端（对应 Go 的 slog.Handler，不含 group）；plug 实现并交给 `newTelemetry`，core 的完成记录与诊断事件都写入它。

```ts
export interface LogHandler {
  /** Cheap level gate; called before core builds any attribute. */
  enabled(ctx: Context, level: LogLevel): boolean
  /** Writes one record. Must not block and must not throw (core still isolates failures). */
  handle(ctx: Context, record: LogRecord): void
  /** Optional fast path (pino/winston child loggers). When absent, core merges bound attrs into record.attrs. */
  withAttrs?(attrs: LogAttrs): LogHandler
  /** Native lifecycle owned by the Telemetry after admission; absent when the application keeps it. Must accept `stop` before `start`. */
  readonly lifecycle?: TelemetryLifecycle
}
```

### `@go-like/core/trace`

角色：插座+机制；lane：P；14 个导出。

追踪入口：声明 Span、TracerProvider 与 Propagator 三个 socket，提供唯一的用户 span API `inSpan`，并内置零依赖的 W3C Trace Context 默认传播器。由 `@go-like/otel` 等 plug 实现三个 socket；应用代码与 core 自身通过 `inSpan`、`spanFromContext` 消费。

#### `spanFromContext`

函数 · 新增

读取 ctx 中的活动 span；没有时返回共享的、身份无效的非记录 span（对应 Go 的 trace.SpanFromContext）。

```ts
export declare function spanFromContext(ctx: Context): Span
```

#### `inSpan`

函数 · 新增

唯一的用户 span API（对应 OTel startActiveSpan）：在子 span 内并在 provider 的隐式作用域内运行 fn，使第三方自动插桩得以嵌套。fn 抛错或 reject 时 span 状态置为 "error" 并写入 "error.type"；fn 结算后 span 结束。没有 tracer 时直接调用 fn(ctx, spanFromContext(ctx))。

```ts
export declare function inSpan<T>(
  ctx: Context,
  name: string,
  fn: (ctx: Context, span: Span) => T | Promise<T>,
  options?: SpanOptions
): Promise<T>
```

#### `newTraceContextPropagator`

函数 · 新增

零依赖的 W3C Trace Context 传播器，未显式指定 propagator 时的默认实现：traceparent 版本 00，tracestate 原样透传（超过 512 字符则丢弃）。`fields()` 为 ["traceparent", "tracestate"]；`extract` 对版本 ff、版本 00 带尾随数据、全零 id、格式不符及逗号拼接的重复值返回原 ctx。

```ts
export declare function newTraceContextPropagator(): Propagator
```

#### `SpanKind`

类型 · 新增

span 的种类，对应 OTel SpanKind。

```ts
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer"
```

#### `SpanStatusCode`

类型 · 新增

span 的终态状态码：未设置、成功、失败。

```ts
export type SpanStatusCode = "unset" | "ok" | "error"
```

#### `SpanContext`

接口 · 新增

W3C 追踪身份：traceId 为 32 位、spanId 为 16 位小写十六进制，且不得全零。

```ts
export interface SpanContext {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: number // W3C trace-flags byte; bit 0 = sampled
  readonly traceState: string // serialized tracestate value; "" when absent
  readonly isRemote: boolean
}
```

#### `SpanLink`

接口 · 新增

指向另一条 trace 或同一 trace 较早部分中某个 span 的因果引用。

```ts
export interface SpanLink {
  readonly context: SpanContext
  readonly attributes: Attributes
}
```

#### `Span`　[插座]

接口 · 新增

一个 span；plug 实现它以接入追踪后端。方法不得抛错，core 仍会隔离失败。core 保存并原样返回 `TracerProvider.startSpan` 给出的同一个 Span 实例，只在调用点用 try/catch 隔离 plug 故障，绝不包装该 span。

```ts
export interface Span {
  spanContext(): SpanContext
  isRecording(): boolean
  setAttributes(attributes: Attributes): void
  addEvent(name: string, attributes?: Attributes): void
  setStatus(code: SpanStatusCode, description?: string): void
  /** User-only: core never calls it (redaction rule). */
  recordError(error: unknown, attributes?: Attributes): void
  /** Ends once; later calls are no-ops. */
  end(): void
}
```

#### `SpanStartOptions`

接口 · 新增

core 传给 TracerProvider 的 span 起始选项，所有字段均已解析完毕。

```ts
export interface SpanStartOptions {
  readonly kind: SpanKind
  readonly attributes: Attributes
  readonly links: readonly SpanLink[]
  /**
   * true: ctx carries no parent and the span starts a new trace. The provider MUST NOT consult its own
   * implicit context (for OTel: never context.active()), whatever its options say.
   */
  readonly root: boolean
}
```

#### `TracerProvider`　[插座]

接口 · 新增

创建 span 的追踪后端；父 span 取自 ctx 携带的 span（本地、远程或无）。plug 实现它，由 `newTelemetry` 装入 bundle。

```ts
export interface TracerProvider {
  startSpan(ctx: Context, scope: Scope, name: string, options: SpanStartOptions): Span
  /**
   * Optional bridge for providers with their own implicit context (OpenTelemetry JS AsyncLocalStorage).
   * Must call fn exactly once, synchronously, and return its result unchanged. When ctx carries no span
   * the provider's implicit context must become empty (OTel ROOT_CONTEXT) unless the application opted in
   * to implicit parenting.
   */
  enter?<R>(ctx: Context, fn: () => R): R
  /** Native lifecycle owned by the Telemetry after admission; absent when the application keeps it. Must accept `stop` before `start`. */
  readonly lifecycle?: TelemetryLifecycle
}
```

#### `CarrierReader`

接口 · 新增

传播载体的读端；键名大小写不敏感。

```ts
export interface CarrierReader {
  get(key: string): string | null
  keys(): readonly string[]
}
```

#### `CarrierWriter`

接口 · 新增

传播载体的写端；core 总是替换，从不追加。

```ts
export interface CarrierWriter {
  set(key: string, value: string): void
}
```

#### `Propagator`　[插座]

接口 · 新增

跨进程上下文传播（对应 Go 的 propagation.TextMapPropagator）；plug 实现，core 默认使用 W3C 传播器。

```ts
export interface Propagator {
  inject(ctx: Context, carrier: CarrierWriter): void
  /** Returns ctx unchanged when the carrier holds nothing valid; never throws on bad input. */
  extract(ctx: Context, carrier: CarrierReader): Context
  /** Header names this propagator owns; core strips caller-supplied copies before inject. */
  fields(): readonly string[]
}
```

#### `SpanOptions`

接口 · 新增

`inSpan` 的可选项。

```ts
export interface SpanOptions {
  readonly kind?: SpanKind // default "internal"
  readonly attributes?: Attributes
  readonly scope?: Scope // default { name: "app" }
}
```

### `@go-like/core/metric`

角色：插座+机制；lane：P；15 个导出。

指标入口：声明 MeterProvider 与 Instrument 两个 socket，并提供不持有 provider 引用的类型化惰性指标句柄。由 `@go-like/otel`、`@go-like/prometheus/metric` 实现 socket；core 的插桩与应用代码通过 `newCounter` 等句柄记录，句柄在首次使用时绑定 ctx 中的每个 provider。

#### `newCounter`

函数 · 新增

创建惰性计数器句柄：不持有 provider 引用与注册表，首次使用时绑定 ctx 中的每个 meter provider。

```ts
export declare function newCounter<const K extends string = never>(
  name: string,
  options?: InstrumentOptions<K>
): Counter<K>
```

#### `newUpDownCounter`

函数 · 新增

创建惰性增减计数器句柄；绑定规则同 `newCounter`。

```ts
export declare function newUpDownCounter<const K extends string = never>(
  name: string,
  options?: InstrumentOptions<K>
): UpDownCounter<K>
```

#### `newHistogram`

函数 · 新增

创建惰性直方图句柄；绑定规则同 `newCounter`。

```ts
export declare function newHistogram<const K extends string = never>(
  name: string,
  options?: HistogramOptions<K>
): Histogram<K>
```

#### `newGauge`

函数 · 新增

创建惰性仪表句柄；绑定规则同 `newCounter`。

```ts
export declare function newGauge<const K extends string = never>(
  name: string,
  options?: InstrumentOptions<K>
): Gauge<K>
```

#### `InstrumentKind`

类型 · 新增

指标种类：计数器、增减计数器、直方图、仪表。

```ts
export type InstrumentKind = "counter" | "up_down_counter" | "histogram" | "gauge"
```

#### `InstrumentDescriptor`

接口 · 新增

交给 MeterProvider 的完整解析后的指标定义。

```ts
export interface InstrumentDescriptor {
  readonly kind: InstrumentKind
  readonly name: string // ^[A-Za-z][A-Za-z0-9_./-]{0,254}$
  readonly unit: string // UCUM ("s", "By", "{request}", "1"); "" if unspecified
  readonly description: string
  readonly attributeKeys: readonly string[] // the complete label schema
  readonly buckets: readonly number[] | null // histogram advice; null = provider default
}
```

#### `Instrument`　[插座]

接口 · 新增

一个已创建的指标：counter 用 add（值不得为负），up_down_counter 用 add，histogram 用 record，gauge 用 set 语义；plug 实现，core 的句柄调用它。

```ts
export interface Instrument {
  record(ctx: Context, value: number, attributes: Attributes): void
}
```

#### `MeterProvider`　[插座]

接口 · 新增

指标后端，按描述符创建 Instrument；对同一 (provider, 句柄) 至多调用一次 `instrument`，core 缓存结果。plug 实现并交给 `newTelemetry`。

```ts
export interface MeterProvider {
  instrument(scope: Scope, descriptor: InstrumentDescriptor): Instrument
  /** Native lifecycle owned by the Telemetry after admission; absent for pull-only providers. Must accept `stop` before `start`. */
  readonly lifecycle?: TelemetryLifecycle
}
```

#### `MetricAttributes`

类型 · 新增

声明标签集为 K 的句柄所接受的属性；未声明的键是编译错误。

```ts
export type MetricAttributes<K extends string> = [K] extends [never]
  ? Readonly<Record<string, never>>
  : Readonly<Partial<Record<K, AttributeValue>>>
```

#### `InstrumentOptions`

接口 · 改名 · 替代 `@go-like/prometheus#RequestMetricLabel`

创建指标句柄的通用选项，`attributeKeys` 即完整的标签模式。

```ts
export interface InstrumentOptions<K extends string> {
  readonly unit?: string
  readonly description?: string
  readonly attributeKeys?: readonly K[]
  readonly scope?: Scope // default { name: "app" }
}
```

#### `HistogramOptions`

接口 · 新增

直方图句柄的选项，在通用选项之上增加分桶建议。

```ts
export interface HistogramOptions<K extends string> extends InstrumentOptions<K> {
  readonly buckets?: readonly number[]
}
```

#### `Counter`

接口 · 新增

单调递增计数器句柄。

```ts
export interface Counter<K extends string = never> {
  add(ctx: Context, value: number, attributes?: MetricAttributes<K>): void
}
```

#### `UpDownCounter`

接口 · 新增

可增可减的计数器句柄。

```ts
export interface UpDownCounter<K extends string = never> {
  add(ctx: Context, value: number, attributes?: MetricAttributes<K>): void
}
```

#### `Histogram`

接口 · 新增

直方图句柄，记录一个观测值的分布。

```ts
export interface Histogram<K extends string = never> {
  record(ctx: Context, value: number, attributes?: MetricAttributes<K>): void
}
```

#### `Gauge`

接口 · 新增

仪表句柄，记录某一时刻的当前值。

```ts
export interface Gauge<K extends string = never> {
  record(ctx: Context, value: number, attributes?: MetricAttributes<K>): void
}
```

### `@go-like/core/testing`

角色：测试套件；lane：P；30 个导出。

唯一的公开测试入口：内存遥测记录器 `newTelemetryRecorder`、共享的 `ConformanceCase` 类型，以及每个概念的 `<concept>Conformance(subject)` 一致性套件。由第三方 plug 作者与 core 自身的测试消费；套件作为公开测试 API 发布，用例可在小版本中增加。各套件的声明由所属概念的文件提供，本入口只负责再导出。

#### `newTelemetryRecorder`

函数 · 新增

创建内存遥测记录器，用于断言 core 各处插桩产生的 span、指标与日志；core 自身的插桩测试与 plug 测试都用它。

```ts
export declare function newTelemetryRecorder(options?: RecorderOptions): TelemetryRecorder
```

#### `logHandlerConformance`

函数 · 新增

LogHandler 一致性套件：handle 永不抛错、enabled 被遵守、withAttrs 不可变、关联字段与 `logCorrelation(ctx)` 一致、`event.name` 的写出、`LogField.exception` 进入原生错误槽且消息不被复制，以及 `stop` 先于 `start` 时排空或关闭交给它的原生对象（D10）。

```ts
export declare function logHandlerConformance(
  subject: LogHandlerSubject
): readonly ConformanceCase[]
```

#### `tracerProviderConformance`

函数 · 新增

TracerProvider 一致性套件：本地、远程与无父级，`root: true` 忽略隐式上下文，链接到达后端，`end` 幂等，`enter` 恰好调用 fn 一次，客户端嵌套用例，无 span 的 `enter` 得到空隐式上下文，`enter(detachSpan(extract(...)))` 得到空隐式上下文，`startSpan` 返回的 Span 实例身份被原样保留（D39），以及 `stop` 先于 `start`（D10）。

```ts
export declare function tracerProviderConformance(
  subject: TracerProviderSubject
): readonly ConformanceCase[]
```

#### `meterProviderConformance`

函数 · 新增

MeterProvider 一致性套件：四种指标、标签恰为 `attributeKeys`、重复描述符返回同一指标、分桶建议到达直方图，以及 `stop` 先于 `start`（D10）。

```ts
export declare function meterProviderConformance(
  subject: MeterProviderSubject
): readonly ConformanceCase[]
```

#### `propagatorConformance`

函数 · 新增

Propagator 一致性套件：往返、畸形与重复输入保持 ctx 不变、`fields()` 覆盖所有注入的键、无 span 时 inject 不写入。

```ts
export declare function propagatorConformance(
  newPropagator: () => Propagator
): readonly ConformanceCase[]
```

#### `ConformanceCase`

接口 · 新增

与测试运行器无关的一条一致性用例：由套件返回，用 bun:test、node:test 或任何运行器逐条执行。所有 `<concept>Conformance(subject)` 套件共用本类型。

```ts
export interface ConformanceCase {
  readonly name: string
  run(): Promise<void>
}
```

#### `registryConformance`

函数 · 改名 · 替代 `@go-like/registry#registryConformanceCases`

返回 Registry 一致性用例（与测试运行器无关）；由

```ts
export declare function registryConformance(
  subject: RegistryConformanceSubject
): readonly ConformanceCase[]
```

#### `RegistryConformanceSubject`

接口 · 迁移 · 替代 `@go-like/registry#RegistryConformanceSubject`

Registry 一致性套件的被测对象：由 plug 作者提供隔离与共享后端两种构造方式。

```ts
export interface RegistryConformanceSubject {
  /** One isolated provider per call. */
  readonly createRegistry: () => Registry | Promise<Registry>
  /** Two distinct provider objects over one shared backend. */
  readonly createSharedRegistries: () =>
    | readonly [Registry, Registry]
    | Promise<readonly [Registry, Registry]>
  /** Same id and name for both revisions, different content. */
  readonly service: (revision: "initial" | "updated") => ServiceInstance
  /** Integer 1..60000, default 5000. */
  readonly convergenceTimeoutMs?: number
}
```

#### `cacheConformance`

函数 · 改名 · 替代 `packages/cache/src/testing.ts#cacheConformanceCases`

Cache 一致性用例：稳定的 `string()`、get/put/delete 的字节所有权、TTL 过期、已取消 ctx，以及可选的共享写入者。

```ts
export declare function cacheConformance<T extends Cache>(
  subject: CacheConformanceSubject<T>
): readonly ConformanceCase[]
```

#### `CacheConformanceSubject`

接口 · 迁移 · 替代 `packages/cache/src/testing.ts#CacheConformanceSubject`

向 Cache 一致性套件提供全新的提供者状态与所选限制。

```ts
export interface CacheConformanceSubject<T extends Cache = Cache> {
  /** Creates one synchronous, I/O-free Cache attached to isolated backend state. */
  readonly createCache: () => T
  /** Creates two clients for one isolated shared backend when cross-client checks apply. */
  readonly createSharedCaches?: () => readonly [T, T]
  /** Runs one case while the provider owns setup and cleanup outside the Cache contract (resource start/stop). */
  readonly useCache?: (cache: T, run: (cache: T) => Promise<void>) => Promise<void>
  /** Advances a deterministic provider clock; real providers omit it. */
  readonly advanceTime?: (milliseconds: number) => void | Promise<void>
  /** Bounds each operation and eventual convergence; default 5,000 ms. */
  readonly convergenceTimeoutMs?: number
  /** One supported TTL used by expiry conformance. */
  readonly ttlMs?: number
}
```

#### `storeConformance`

函数 · 改名 · 替代 `packages/store/src/testing.ts#storeConformanceCases`

Store 一致性用例：CRUD 快照、列表顺序/limit/cursor、TTL、CAS、已取消 ctx，以及可选的共享写入者。

```ts
export declare function storeConformance(
  subject: StoreConformanceSubject
): readonly ConformanceCase[]
```

#### `StoreConformanceLimits`

接口 · 迁移 · 替代 `packages/store/src/testing.ts#StoreConformanceLimits`

描述仅用于挑选可移植用例的提供者语义；它从来不是运行时能力（ADR 0006 :35-36）。

```ts
export interface StoreConformanceLimits {
  readonly ttl: { readonly minimumMs: number; readonly maximumMs: number } | null
  readonly cas: boolean
  readonly sharedWriters: boolean
}
```

#### `StoreConformanceSubject`

接口 · 迁移 · 替代 `packages/store/src/testing.ts#StoreConformanceSubject`

向 Store 一致性套件提供全新提供者状态、限制与可选的资源准备/释放钩子。

```ts
export interface StoreConformanceSubject {
  readonly limits: StoreConformanceLimits
  readonly createStore: () => Store
  readonly createSharedStores?: () => readonly [Store, Store]
  /** Prepares one provider that owns resources outside the Store contract (resource start). */
  readonly prepareStore?: (ctx: Context, store: Store) => Promise<void>
  /** Releases what prepareStore admitted (resource stop). */
  readonly releaseStore?: (ctx: Context, store: Store) => Promise<void>
  readonly convergenceTimeoutMs?: number
  readonly ttlMs?: number
}
```

#### `brokerConformance`

函数 · 新增

Broker 行为用例：稳定 `string()`、往返与字节所有权、I/O 之前的拒绝、`Subscriber.topic`、串行投递、处理函数失败终止订阅、`unsubscribe` 语义、每次投递的 Context。

```ts
export declare function brokerConformance<PublishOptions, PublishResult, SubscribeOptions, Native>(
  subject: BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>
): readonly ConformanceCase[]
```

#### `brokerTelemetryConformance`

函数 · 新增

Broker 遥测用例：traceparent 注入到被复制的头里、每次投递的 Context 以生产者 span 为父、失败与无遥测时一样到达订阅。

```ts
export declare function brokerTelemetryConformance<
  PublishOptions,
  PublishResult,
  SubscribeOptions,
  Native
>(
  subject: BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>
): readonly ConformanceCase[]
```

#### `BrokerConformanceSubject`

接口 · 新增

向 Broker 行为套件与遥测套件提供全新的代理、可路由主题与可选的原生结算/清理钩子；一个 subject 类型服务两套用例。

```ts
export interface BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native> {
  /** A fresh broker connected to a backend the cases may publish to. */
  newBroker(ctx: Context): Promise<Broker<PublishOptions, PublishResult, SubscribeOptions, Native>>
  /** A topic the backend routes back to a subscription on the same topic. */
  readonly topic: string
  readonly publishOptions?: PublishOptions
  readonly subscribeOptions?: SubscribeOptions
  /** Native settlement after a successful handler (JetStream ack, RabbitMQ ack); omit when the backend needs none. */
  settle?(event: BrokerEvent<Native>): void | Promise<void>
  /** Bounds every wait for a delivery or terminal; default 5,000 ms. */
  readonly timeoutMs?: number
  /** Releases the broker and backend resources the subject created. */
  close(ctx: Context): Promise<void>
}
```

#### `jobQueueConformance`

函数 · 新增

JobQueue 一致性用例：处理函数看到的名称/载荷/尝试序号/id、id 去重、尝试次数与退避、未知名称不重试、永久失败不重试、处理函数失败不停 worker、并发度、排空与超时、I/O 之前的拒绝、二次 start 的 `JobStateError`。

```ts
export declare function jobQueueConformance(
  subject: JobQueueConformanceSubject
): readonly ConformanceCase[]
```

#### `jobTelemetryConformance`

函数 · 新增

作业遥测用例：入队/运行单元、父子关系与失败语义，同时覆盖队列与（经核心调度 Server 的）时刻表。

```ts
export declare function jobTelemetryConformance(
  subject: JobTelemetrySubject
): readonly ConformanceCase[]
```

#### `scheduleConformance`

函数 · 新增

Schedule 一致性用例：`next(t) > t` 且为整数、纯、单调、`string()` 稳定、非法 `afterMs` 抛出 RangeError。

```ts
export declare function scheduleConformance(newSchedule: () => Schedule): readonly ConformanceCase[]
```

#### `JobConformancePayload`

接口 · 新增

队列一致性套件使用的载荷类型。

```ts
export interface JobConformancePayload {
  readonly n: number
}
```

#### `JobQueueConformanceSubject`

接口 · 新增

向 `jobQueueConformance` 提供已 start 的全新队列与清理钩子。

```ts
export interface JobQueueConformanceSubject {
  /** A fresh, admitted (started) queue on isolated backend state. */
  newQueue(ctx: Context): Promise<JobQueue<JobConformancePayload>>
  /** Stops and removes what newQueue created. */
  close(ctx: Context): Promise<void>
  /** Bounds every wait; default 10,000 ms. */
  readonly timeoutMs?: number
}
```

#### `JobTelemetrySubject`

接口 · 新增

向 `jobTelemetryConformance` 提供待验证的队列和/或时刻表；用例 1、4 需要 `queue`，用例 2、3 在核心调度 Server 上运行，默认时刻表为 `newIntervalSchedule(50)`。

```ts
export interface JobTelemetrySubject {
  readonly queue?: JobQueueConformanceSubject
  readonly schedule?: Schedule
}
```

#### `RecordedSpan`

接口 · 新增

记录器捕获的一个已创建 span：作用域、名称、种类、身份、父级、链接、属性、事件、状态与是否已结束。

```ts
export interface RecordedSpan {
  readonly scope: Scope
  readonly name: string
  readonly kind: SpanKind
  readonly context: SpanContext
  readonly parent: SpanContext | null
  readonly root: boolean
  readonly links: readonly SpanLink[]
  readonly attributes: Attributes
  readonly events: readonly { readonly name: string; readonly attributes: Attributes }[]
  readonly status: SpanStatusCode
  readonly ended: boolean
}
```

#### `RecordedMeasurement`

接口 · 新增

记录器捕获的一次指标测量：作用域、描述符、值、属性与记录时的活动 span 身份。

```ts
export interface RecordedMeasurement {
  readonly scope: Scope
  readonly descriptor: InstrumentDescriptor
  readonly value: number
  readonly attributes: Attributes
  readonly spanContext: SpanContext | null
}
```

#### `RecordedLog`

接口 · 新增

记录器捕获的一条日志及记录时的活动 span 身份。

```ts
export interface RecordedLog {
  /** attrs include the withLogAttrs attrs (the recorder handler has no withAttrs). */
  readonly record: LogRecord
  readonly spanContext: SpanContext | null
}
```

#### `TelemetryRecorder`

接口 · 新增

内存遥测记录器：持有一个装好三类内存 provider 的 `Telemetry`，并按信号暴露所捕获的 span、测量与日志。

```ts
export interface TelemetryRecorder {
  readonly telemetry: Telemetry
  readonly tracerProvider: TracerProvider
  readonly meterProvider: MeterProvider
  readonly logHandler: LogHandler
  spans(): readonly RecordedSpan[]
  measurements(): readonly RecordedMeasurement[]
  logs(): readonly RecordedLog[]
  reset(): void
}
```

#### `RecorderOptions`

接口 · 新增

`newTelemetryRecorder` 的选项。

```ts
export interface RecorderOptions {
  readonly propagator?: Propagator | null
  readonly completionLogs?: CompletionLogMode // default "all" in the recorder
  readonly level?: LogLevel // default "debug"
}
```

#### `LogHandlerSubject`

接口 · 新增

日志 handler 一致性套件的被测对象：创建 handler，并读出 plug 原生输出解码后的扁平字段记录。

```ts
export interface LogHandlerSubject {
  newHandler(): LogHandler
  /** The plug's native output decoded to flat field records, oldest first. */
  written(): Promise<readonly Readonly<Record<string, unknown>>[]>
}
```

#### `TracerProviderSubject`

接口 · 新增

tracer provider 一致性套件的被测对象：provider、可选的隐式 span 读取，以及后端已结束 span 的 core 视图。

```ts
export interface TracerProviderSubject {
  readonly provider: TracerProvider
  /** Reads the provider's own implicit current span (OTel: trace.getActiveSpan()); omit when enter is absent. */
  implicitSpanContext?(): SpanContext | null
  /** Spans the backend finished, in core terms. */
  finished(): Promise<
    readonly {
      readonly name: string
      readonly context: SpanContext
      readonly parentSpanId: string | null
      readonly links: readonly SpanContext[]
    }[]
  >
}
```

#### `MeterProviderSubject`

接口 · 新增

meter provider 一致性套件的被测对象：provider 与后端收集到的测量。

```ts
export interface MeterProviderSubject {
  readonly provider: MeterProvider
  collect(): Promise<
    readonly {
      readonly name: string
      readonly attributes: Readonly<Record<string, string | number | boolean>>
      readonly value: number
    }[]
  >
}
```

### `@go-like/core/transport`

角色：插座+机制；lane：P；40 个导出。

内部同步通信的 Transport 套接字及其用户 API：Transport/Client/Listener 套接字、通用选项与错误分类、ServiceError 模型、TransportInfo 读取器与类型化的服务契约 DSL（defineService/endpoint）。由 core 的 memory/http 参考实现与第三方传输插件实现；由 /server、/client 与应用代码消费。/// <reference lib="esnext.disposable" />

#### `timeout`

函数 · 迁移 · 替代 `@go-like/transport#timeout`

设置 Transport 的默认操作超时（毫秒）。

```ts
export declare function timeout(timeoutMs: number): Option
```

#### `secure`

函数 · 迁移 · 替代 `@go-like/transport#secure`

声明 Transport 是否使用加密连接。

```ts
export declare function secure(enabled: boolean): Option
```

#### `tlsConfig`

函数 · 迁移 · 替代 `@go-like/transport#tlsConfig`

设置 Transport 的 TLS 身份与信任材料；传 null 清除。

```ts
export declare function tlsConfig(value: TLSConfig | null): Option
```

#### `withTimeout`

函数 · 迁移 · 替代 `@go-like/transport#withTimeout`

为单次 dial 设置超时（毫秒）。

```ts
export declare function withTimeout(timeoutMs: number): DialOption
```

#### `withConnClose`

函数 · 迁移 · 替代 `@go-like/transport#withConnClose`

要求单次 dial 得到的连接在使用后关闭而不复用。

```ts
export declare function withConnClose(): DialOption
```

#### `serviceError`

函数 · 迁移 · 替代 `@go-like/transport#serviceError`

创建一个 ServiceError；服务端处理器抛出它即可控制返回给调用方的错误码与状态。

```ts
export declare function serviceError(
  code: string,
  message: string,
  status?: number,
  metadata?: Readonly<Record<string, string>>
): ServiceError
```

#### `isServiceError`

函数 · 迁移 · 替代 `@go-like/transport#isServiceError`

判断一个值是否为 ServiceError。

```ts
export declare function isServiceError(value: unknown): value is ServiceError
```

#### `fromClientContext`

函数 · 迁移 · 替代 `@go-like/transport#fromClientContext`

读取核心客户端为一次逻辑调用安装的客户端侧 TransportInfo（客户端中间件使用），未安装时返回 null。

```ts
export declare function fromClientContext(ctx: Context): TransportInfo | null
```

#### `fromServerContext`

函数 · 迁移 · 替代 `@go-like/transport#fromServerContext`

读取 Listener 为一次请求发布的服务端侧 TransportInfo（mTLS 对端身份在此），未发布时返回 null。

```ts
export declare function fromServerContext(ctx: Context): TransportInfo | null
```

#### `endpoint`

函数 · 迁移 · 替代 `@go-like/transport#endpoint`

声明一个类型化端点；传入 `true` 作为最后一个参数声明服务端流端点。

```ts
export declare function endpoint<const Request extends Struct, const Response extends Struct>(
  service: string,
  name: string,
  request: Request,
  response: Response
): Endpoint<Request, Response, false>
export declare function endpoint<const Request extends Struct, const Response extends Struct>(
  service: string,
  name: string,
  request: Request,
  response: Response,
  stream: true
): Endpoint<Request, Response, true>
```

#### `defineService`

函数 · 迁移 · 替代 `@go-like/transport#defineService`

用端点定义表声明一个类型化服务契约；未知的端点字段在类型层面被拒绝。

```ts
export declare function defineService<const Definitions extends ServiceDefinitions>(
  name: string,
  definitions: Definitions extends StrictDefinitions<Definitions>
    ? Definitions
    : StrictDefinitions<Definitions>
): DefinedService<Definitions>
```

#### `Transport`　[插座]

接口 · 语义变化 · 替代 `@go-like/transport#Transport`

内部服务传输的配置与创建入口：创建客户端（dial）与监听器（listen）；传输插件与 core 的 memory/http 实现它。

```ts
export interface Transport {
  /** Stable protocol kind, `^[a-z0-9][a-z0-9+._-]*$`, at most 64 bytes ("memory", "http"). Now required. */
  kind(): string
  /** Applies common options in declaration order without performing I/O. */
  init(...options: readonly Option[]): void
  /** Returns an immutable defensive snapshot of the current common options. */
  options(): Options
  /** Creates a client for address under the supplied operation Context. */
  dial(ctx: Context, address: string, ...options: readonly DialOption[]): Promise<Client>
  /** Creates a bound listener for address under the supplied operation Context. */
  listen(ctx: Context, address: string, ...options: readonly ListenOption[]): Promise<Listener>
  /** Returns the implementation's stable diagnostic name. */
  string(): string
}
```

#### `TransportHandler`　[插座]

类型 · 迁移 · 替代 `@go-like/transport#TransportHandler`

处理一个请求并返回标准 Fetch 响应；ctx 由 Listener.serve 为每个请求创建，并在响应体到达终止态后才取消。

```ts
export type TransportHandler = (ctx: Context, request: Request) => Response | Promise<Response>
```

#### `Client`　[插座]

接口 · 迁移 · 替代 `@go-like/transport#Client`

一条可复用的 Fetch 连接，由调用 Transport.dial 的一方持有并负责关闭。

```ts
export interface Client {
  /** Sends one Request and returns its Response without consuming the body. */
  fetch(ctx: Context, request: Request): Promise<Response>
  /** Idempotently closes this Client; ctx bounds only the caller's wait. */
  close(ctx: Context): Promise<void>
}
```

#### `Listener`　[插座]

接口 · 语义变化 · 替代 `@go-like/transport#Listener`

一个已绑定的传输端点与一次性的服务循环，由调用 listen 的一方持有并负责关闭。

```ts
export interface Listener {
  /**
   * The actual bound address. URL-addressed transports return an absolute root URL whose scheme is
   * the advertised one ("http://127.0.0.1:43123", "https://...", "memory://host/path"). Changed: the
   * HTTP listener returned "host:port" before (transport/http/test/listener.test.ts:449).
   */
  addr(): string
  /** Idempotently closes the listener; ctx bounds only the caller's wait. */
  close(ctx: Context): Promise<void>
  /**
   * Serves Fetch requests until close, cancellation, or host failure. MUST call handler with a
   * cancelable Context derived from ctx, one per request, and cancel it at the first terminal body
   * event of the delivered Response (a null body is terminal at delivery), not before. Only request
   * abort, listener close or failure, and cancellation of ctx may end it earlier. One-shot.
   */
  serve(ctx: Context, handler: TransportHandler): Promise<void>
}
```

#### `TransportInfo`　[插座]

接口 · 迁移 · 替代 `@go-like/transport#TransportInfo`

一次操作中与具体传输无关的细节，由传输实现发布，供中间件与处理器只读使用。

```ts
export interface TransportInfo {
  kind(): string
  /** Provider endpoint, or "" when unavailable. */
  endpoint(): string
  /** Provider operation name, or "" when unavailable. */
  operation(): string
  requestHeaders(): Metadata
  replyHeaders(): Metadata
  /** The verified peer identity (mTLS URI SAN), or null when the provider did not authenticate one. */
  peerIdentity(): string | null
}
```

#### `TLSEncoding`

类型 · 迁移 · 替代 `@go-like/transport#TLSEncoding`

可移植的 TLS 字节编码类型（PEM 或 DER）。

```ts
export type TLSEncoding = "pem" | "der"
```

#### `TLSEncodedBytes`

接口 · 迁移 · 替代 `@go-like/transport#TLSEncodedBytes`

带编码标记的一段 TLS 字节。

```ts
export interface TLSEncodedBytes {
  readonly encoding: TLSEncoding
  readonly bytes: Uint8Array
}
```

#### `TLSConfig`

接口 · 迁移 · 替代 `@go-like/transport#TLSConfig`

不依赖运行时类型的可移植 TLS 身份与信任材料。

```ts
export interface TLSConfig {
  readonly serverName: string | null
  readonly caCertificate: TLSEncodedBytes | null
  readonly certificateChain: TLSEncodedBytes | null
  readonly privateKey: TLSEncodedBytes | null
}
```

#### `Options`

接口 · 语义变化 · 替代 `@go-like/transport#Options`

Transport 的公共不可变配置（超时、是否加密、TLS）；`logger` 成员已移除，日志改由 ctx 提供。

```ts
export interface Options {
  readonly timeoutMs: number
  readonly secure: boolean
  readonly tlsConfig: TLSConfig | null
}
```

#### `DialOptions`

接口 · 迁移 · 替代 `@go-like/transport#DialOptions`

一次 dial 的不可变选项。

```ts
export interface DialOptions {
  readonly timeoutMs: number
  readonly connectionClose: boolean
}
```

#### `ListenOptions`

接口 · 迁移 · 替代 `@go-like/transport#ListenOptions`

实现专属 listen 选项的可扩展结构基类型。

```ts
export interface ListenOptions {}
```

#### `Option`

类型 · 迁移 · 替代 `@go-like/transport#Option`

作用于 Transport 公共配置的选项函数。

```ts
export type Option = (options: Options) => Options
```

#### `DialOption`

类型 · 迁移 · 替代 `@go-like/transport#DialOption`

作用于 dial 选项的选项函数。

```ts
export type DialOption = (options: DialOptions) => DialOptions
```

#### `ListenOption`

类型 · 迁移 · 替代 `@go-like/transport#ListenOption`

作用于实现专属 listen 选项的选项函数。

```ts
export type ListenOption = <T extends ListenOptions>(options: T) => T
```

#### `TransportClosedError`

接口 · 迁移 · 替代 `@go-like/transport/provider#TransportClosedError`

对已关闭的传输资源执行操作时的稳定错误（`GO_LIKE_TRANSPORT_CLOSED`）；工厂在 /transport/provider。

```ts
export interface TransportClosedError extends Error {
  readonly name: "TransportClosedError"
  readonly code: "GO_LIKE_TRANSPORT_CLOSED"
  readonly cause: Error | undefined
}
```

#### `TransportStateError`

接口 · 迁移 · 替代 `@go-like/transport/provider#TransportStateError`

非法状态迁移的稳定错误（`GO_LIKE_TRANSPORT_STATE`）；工厂在 /transport/provider。

```ts
export interface TransportStateError extends Error {
  readonly name: "TransportStateError"
  readonly code: "GO_LIKE_TRANSPORT_STATE"
  readonly cause: Error | undefined
}
```

#### `UnsupportedTransportCapabilityError`

接口 · 迁移 · 替代 `@go-like/transport/provider#UnsupportedTransportCapabilityError`

传输无法满足所请求选项时的稳定错误（`GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY`）；工厂在 /transport/provider。

```ts
export interface UnsupportedTransportCapabilityError extends Error {
  readonly name: "UnsupportedTransportCapabilityError"
  readonly code: "GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY"
  readonly cause: Error | undefined
}
```

#### `TransportProtocolError`

接口 · 迁移 · 替代 `@go-like/transport/provider#TransportProtocolError`

线上数据非法时的稳定错误（`GO_LIKE_TRANSPORT_PROTOCOL`）；工厂在 /transport/provider。

```ts
export interface TransportProtocolError extends Error {
  readonly name: "TransportProtocolError"
  readonly code: "GO_LIKE_TRANSPORT_PROTOCOL"
  readonly cause: Error | undefined
}
```

#### `ServiceError`

接口 · 迁移 · 替代 `@go-like/transport#ServiceError`

一个不可变、与传输无关的服务失败（线上形态为 HTTP 状态加 {code,message,metadata}）。

```ts
export interface ServiceError extends Error {
  readonly name: "ServiceError"
  readonly code: string
  readonly status: number
  readonly metadata: Readonly<Record<string, string>>
}
```

#### `Endpoint`

接口 · 迁移 · 替代 `@go-like/transport#Endpoint`

一个类型化的内部端点：服务名、端点名、请求与响应 Struct 以及是否为服务端流。

```ts
export interface Endpoint<
  Request extends Struct = Struct,
  Response extends Struct = Struct,
  Stream extends boolean = boolean
> {
  readonly service: string
  readonly endpoint: string
  readonly request: Request
  readonly response: Response
  readonly stream: Stream
}
```

#### `ServerStream`

接口 · 迁移 · 替代 `@go-like/transport#ServerStream`

一次服务端流调用的活动流：可异步迭代、可显式关闭，由核心客户端产生。

```ts
export interface ServerStream<T> extends AsyncIterable<T>, AsyncDisposable {
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}
```

#### `ServiceEndpointDefinition`

接口 · 迁移 · 替代 `@go-like/transport#ServiceEndpointDefinition`

defineService 中单个端点的定义：请求/响应 Struct 与可选的服务端流标记。

```ts
export interface ServiceEndpointDefinition {
  readonly request?: Struct
  readonly response: Struct
  readonly stream?: true
}
```

#### `ServiceDefinitions`

类型 · 迁移 · 替代 `@go-like/transport#ServiceDefinitions`

defineService 的端点定义表，键为端点名。

```ts
export type ServiceDefinitions = Readonly<Record<string, ServiceEndpointDefinition>>
```

#### `ServiceCallOption`

接口 · 语义变化 · 替代 `@go-like/transport#ServiceCallOption`

生成的服务客户端方法接受的单次调用选项（品牌类型），不依赖 /client 子路径；仅 withFilter/withRetry 产生它，因此 withEndpoint(...) 或服务端选项无法作为调用选项传入。

```ts
export interface ServiceCallOption {
  readonly [callOptionBrand]: "CallOption"
}
```

#### `ServiceServer`

接口 · 迁移 · 替代 `@go-like/transport#ServiceServer`

由核心服务端 registerHandlers 实现的结构性接缝，供生成的服务注册处理器使用。

```ts
export interface ServiceServer {
  registerHandlers(
    handlers: readonly {
      readonly endpoint: Endpoint
      readonly handler: (ctx: Context, request: unknown) => unknown
    }[]
  ): void
}
```

#### `ServiceConnection`

接口 · 迁移 · 替代 `@go-like/transport#ServiceConnection`

由核心客户端 call/stream 实现的结构性接缝，供生成的服务客户端使用。

```ts
export interface ServiceConnection {
  call(...args: readonly unknown[]): Promise<unknown>
  stream?(...args: readonly unknown[]): Promise<unknown>
}
```

#### `DefinedService`

接口 · 迁移 · 替代 `@go-like/transport#DefinedService`

defineService 的结果：服务名、各端点、registerHandler 与 newClient 两个入口。

```ts
export interface DefinedService<Definitions extends ServiceDefinitions> {
  readonly name: string
  readonly endpoints: EndpointsOf<Definitions>
  registerHandler(server: ServiceServer, handler: HandlersOf<Definitions>): void
  newClient(conn: ServiceConnection): ClientsOf<Definitions>
}
```

#### `ServiceHandler`

类型 · 迁移 · 替代 `@go-like/transport#ServiceHandler`

由 DefinedService 推导出的服务端处理器对象类型。

```ts
export type ServiceHandler<Service extends DefinedService<ServiceDefinitions>> =
  Service extends DefinedService<infer Definitions> ? HandlersOf<Definitions> : never
```

#### `ServiceClient`

类型 · 迁移 · 替代 `@go-like/transport#ServiceClient`

由 DefinedService 推导出的服务客户端对象类型。

```ts
export type ServiceClient<Service extends DefinedService<ServiceDefinitions>> =
  Service extends DefinedService<infer Definitions> ? ClientsOf<Definitions> : never
```

### `@go-like/core/transport/provider`

角色：插头 SDK；lane：P；9 个导出。

面向 Transport 实现者的插件 SDK：四个错误工厂、发布服务端 TransportInfo 的 newServerContext，以及让 Listener 在响应体终止前保持请求 Context 的 observeResponseBody。应用代码不应导入它；客户端/服务端的线上编解码属于 core 内部，不在此导出。

#### `newTransportClosedError`

函数 · 迁移 · 替代 `@go-like/transport/provider#newTransportClosedError`

创建稳定的 `GO_LIKE_TRANSPORT_CLOSED` 错误，用于对已关闭的传输资源执行操作。

```ts
export declare function newTransportClosedError(
  message: string,
  cause?: Error
): TransportClosedError
```

#### `newTransportStateError`

函数 · 迁移 · 替代 `@go-like/transport/provider#newTransportStateError`

创建稳定的 `GO_LIKE_TRANSPORT_STATE` 错误，用于非法的状态迁移。

```ts
export declare function newTransportStateError(message: string, cause?: Error): TransportStateError
```

#### `newUnsupportedTransportCapabilityError`

函数 · 迁移 · 替代 `@go-like/transport/provider#newUnsupportedTransportCapabilityError`

创建稳定的 `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY` 错误，用于传输无法满足的选项。

```ts
export declare function newUnsupportedTransportCapabilityError(
  message: string,
  cause?: Error
): UnsupportedTransportCapabilityError
```

#### `newTransportProtocolError`

函数 · 迁移 · 替代 `@go-like/transport/provider#newTransportProtocolError`

创建稳定的 `GO_LIKE_TRANSPORT_PROTOCOL` 错误，用于非法的线上数据。

```ts
export declare function newTransportProtocolError(
  message: string,
  cause?: Error
): TransportProtocolError
```

#### `newServerContext`

函数 · 迁移 · 替代 `@go-like/transport#newServerContext`

发布一次请求的服务端 TransportInfo（经校验并快照，带模块私有品牌）；只有 Listener 实现应调用。

```ts
export declare function newServerContext(ctx: Context, info: TransportInfo): Context
```

#### `observeResponseBody`

函数 · 语义变化 · 替代 `@go-like/transport#observeResponseBody`

返回一个响应，其响应体在首次终止事件时恰好一次地通知 onEnd（null 响应体同步报告 "end"，onEnd 的失败被隔离）；每个 Listener.serve 实现用它把请求 Context 保持到响应体结束。

```ts
export declare function observeResponseBody(
  response: Response,
  onEnd: (end: ResponseBodyEnd) => void,
  options?: ObserveResponseBodyOptions
): Response
```

#### `ResponseBodyEndReason`

类型 · 迁移 · 替代 `@go-like/transport/provider#ResponseBodyEndReason`

响应体到达终止态的原因。

```ts
export type ResponseBodyEndReason = "end" | "error" | "cancel"
```

#### `ResponseBodyEnd`

接口 · 语义变化 · 替代 `@go-like/transport#ResponseBodyEnd`

响应体首次终止事件的描述；已精简为 reason 与 cause，RPC 流分类与计时属于 core 内部。

```ts
export interface ResponseBodyEnd {
  readonly reason: ResponseBodyEndReason
  /** The read error or cancel reason; null on "end". */
  readonly cause: unknown
}
```

#### `ObserveResponseBodyOptions`

接口 · 语义变化 · 替代 `@go-like/transport#ObserveResponseBodyOptions`

observeResponseBody 的选项；已精简为中止信号，startedAt/headersAt/cancelSource 属于 core 内部。

```ts
export interface ObserveResponseBodyOptions {
  /** Aborts the unread source; a later read fails with the signal's reason. */
  readonly signal?: AbortSignal
}
```

### `@go-like/core/transport/memory`

角色：参考实现；lane：P；2 个导出。

进程内的参考 Transport：每个实例拥有私有的地址命名空间（memory://host/path），用于测试与同进程服务装配。它只实现 /transport 的 Transport 套接字，不依赖任何运行时宿主。

#### `newMemoryTransport`

函数 · 迁移 · 替代 `@go-like/transport-memory#newMemoryTransport`

创建一个进程内 Transport。

```ts
export declare function newMemoryTransport(): MemoryTransport
```

#### `MemoryTransport`

接口 · 迁移 · 替代 `@go-like/transport-memory#MemoryTransport`

进程内 Transport；每个实例拥有私有的地址命名空间（memory://host/path）。

```ts
export interface MemoryTransport extends Transport {
  kind(): "memory"
}
```

### `@go-like/core/transport/http`

角色：参考实现；lane：P；7 个导出。

基于 Web 标准 Fetch 的 HTTP Transport 参考实现，只能 dial；listen 需要 /transport/http/node 提供的运行时宿主。Node 服务两端都使用 newNodeHTTPTransport；本入口用于浏览器或边缘等可移植客户端。

#### `executor`

函数 · 迁移 · 替代 `@go-like/transport-http#executor`

指定 HTTP Transport 使用的 Fetch 执行器。

```ts
export declare function executor(value: HTTPExecutor): HTTPTransportOption
```

#### `maxMessageBytes`

函数 · 迁移 · 替代 `@go-like/transport-http#maxMessageBytes`

设置单条消息的最大字节数。

```ts
export declare function maxMessageBytes(value: number): HTTPTransportOption
```

#### `newHTTPTransport`

函数 · 迁移 · 替代 `@go-like/transport-http#newHTTPTransport`

创建基于 Fetch 的 HTTP Transport；listen 以 UnsupportedTransportCapabilityError("HTTP listen requires a runtime host") 拒绝。

```ts
export declare function newHTTPTransport(...options: readonly HTTPTransportOption[]): HTTPTransport
```

#### `HTTPExecutor`

接口 · 迁移 · 替代 `@go-like/transport-http#HTTPExecutor`

执行一次标准 Fetch 请求的函数（默认在构造时捕获 globalThis.fetch）。

```ts
export interface HTTPExecutor {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
```

#### `HTTPTransportOptions`

接口 · 迁移 · 替代 `@go-like/transport-http#HTTPTransportOptions`

HTTP Transport 的不可变配置：Fetch 执行器与单条消息的最大字节数。

```ts
export interface HTTPTransportOptions {
  readonly executor: HTTPExecutor
  /** Maximum unary request or successful-response body size in bytes (default 4 MiB). */
  readonly maxMessageBytes: number
}
```

#### `HTTPTransportOption`

类型 · 迁移 · 替代 `@go-like/transport-http#HTTPTransportOption`

作用于 HTTPTransportOptions 的选项函数。

```ts
export type HTTPTransportOption = (options: HTTPTransportOptions) => HTTPTransportOptions
```

#### `HTTPTransport`

接口 · 语义变化 · 替代 `@go-like/transport-http#HTTPTransport`

HTTP Transport；listen 保持基础套接字签名，HTTPListenOption(s)/HTTPListener 已移除。

```ts
export interface HTTPTransport extends Transport {
  kind(): "http"
  /** The configured per-message receive ceiling in bytes (read by the core client for SSE limits). */
  maxMessageBytes(): number
}
```

### `@go-like/core/transport/http/node`

角色：运行时绑定；lane：N；6 个导出。

HTTP Transport 的 Node 运行时绑定（node:http、node:http2、node:tls、node:net、node:crypto），在 Bun 下同样是受支持的监听器；公开声明不引用 Node 类型。Node 服务的服务端与客户端都用 newNodeHTTPTransport。

#### `allowHTTP1`

函数 · 迁移 · 替代 `@go-like/transport-http/node#allowHTTP1`

允许加密监听器通过 ALPN 接受 HTTP/1.1。

```ts
export declare function allowHTTP1(enabled: boolean): NodeHTTPTransportOption
```

#### `clientAuth`

函数 · 迁移 · 替代 `@go-like/transport-http/node#clientAuth`

设置客户端证书校验模式；"require" 时 URI SAN 成为 TransportInfo.peerIdentity()。

```ts
export declare function clientAuth(value: NodeHTTPClientAuth): NodeHTTPTransportOption
```

#### `newNodeHTTPTransport`

函数 · 语义变化 · 替代 `@go-like/transport-http/node#newNodeHTTPTransport`

创建带 Node 监听器的 HTTP Transport；返回 HTTPTransport（此前为 Transport），使 maxMessageBytes() 有类型。

```ts
export declare function newNodeHTTPTransport(
  ...options: readonly NodeHTTPTransportOption[]
): HTTPTransport
```

#### `NodeHTTPClientAuth`

类型 · 迁移 · 替代 `@go-like/transport-http/node#NodeHTTPClientAuth`

客户端证书校验模式：none 不校验，require 要求并校验。

```ts
export type NodeHTTPClientAuth = "none" | "require"
```

#### `NodeHTTPTransportOptions`

接口 · 迁移 · 替代 `@go-like/transport-http/node#NodeHTTPTransportOptions`

Node HTTP 监听器的专属配置。

```ts
export interface NodeHTTPTransportOptions {
  /** Secure listeners admit HTTP/1.1 through ALPN (default true). */
  readonly allowHTTP1: boolean
  /** "require" verifies client certificates; the URI SAN becomes TransportInfo.peerIdentity(). */
  readonly clientAuth: NodeHTTPClientAuth
}
```

#### `NodeHTTPTransportOption`

类型 · 迁移 · 替代 `@go-like/transport-http/node#NodeHTTPTransportOption`

newNodeHTTPTransport 接受的选项：通用 HTTP 选项或 Node 监听器专属选项。

```ts
export type NodeHTTPTransportOption = HTTPTransportOption | NodeHTTPServerOption
```

### `@go-like/core/server`

角色：机制；lane：P；20 个导出。

内部 RPC 服务端：由任意 Transport 驱动的分发器、JSON/SSE 线上格式与调用管线。它是生命周期 Server、Endpointer 与处理器注册器；Handler/Middleware 是应用与插件可实现的套接字。rpc.server 遥测单元固定在管线最外层，中间件只承载用户策略。

#### `transport`

函数 · 迁移 · 替代 `@go-like/server#transport`

指定服务端使用的 Transport（必需，没有静默默认值）。

```ts
export declare function transport(value: Transport): ServerOption
```

#### `address`

函数 · 迁移 · 替代 `@go-like/server#address`

设置监听地址。

```ts
export declare function address(value: string): ServerOption
```

#### `advertise`

函数 · 迁移 · 替代 `@go-like/server#advertise`

设置对外宣告的地址（注册到服务发现的地址）。

```ts
export declare function advertise(value: string): ServerOption
```

#### `middleware`

函数 · 迁移 · 替代 `@go-like/server#middleware`

追加全局中间件，按声明顺序，先声明者在最外层。

```ts
export declare function middleware(...values: readonly Middleware[]): ServerOption
```

#### `use`

函数 · 迁移 · 替代 `@go-like/server#use`

为匹配 selector 的操作追加中间件（精确匹配，否则取最长的尾部通配）。

```ts
export declare function use(selector: string, ...values: readonly Middleware[]): ServerOption
```

#### `listenOption`

函数 · 迁移 · 替代 `@go-like/server#listenOption`

追加传给 Transport.listen 的实现专属选项。

```ts
export declare function listenOption(...values: readonly ListenOption[]): ServerOption
```

#### `httpRoute`

函数 · 迁移 · 替代 `@go-like/server#httpRoute`

把一个确切的 HTTP 方法与路径映射到已注册的一元端点，使 REST 成功状态与 ServiceError 状态反映承载协议。

```ts
export declare function httpRoute(
  method: string,
  path: string,
  service: string,
  endpoint: string,
  successStatus?: number
): ServerOption
```

#### `streamKeepAlive`

函数 · 迁移 · 替代 `@go-like/server#streamKeepAlive`

设置服务端流的保活间隔（毫秒）。

```ts
export declare function streamKeepAlive(intervalMs: number): ServerOption
```

#### `maxSendMessageBytes`

函数 · 迁移 · 替代 `@go-like/server#maxSendMessageBytes`

设置单条发送消息的最大字节数。

```ts
export declare function maxSendMessageBytes(bytes: number): ServerOption
```

#### `rateLimitMiddleware`

函数 · 语义变化 · 替代 `@go-like/server#rateLimitMiddleware`

限流中间件：被拒绝时以 ServiceError rate_limited/429 {retryAfterMs} 失败并记录 rate_limit.rejected 事件；同步或异步的 limiter 均可。

```ts
export declare function rateLimitMiddleware(limiter: RateLimiter): Middleware
```

#### `newServer`

函数 · 迁移 · 替代 `@go-like/server#newServer`

创建内部 RPC 服务端；必须通过 transport(...) 指定 Transport。

```ts
export declare function newServer(...values: readonly ServerOption[]): Server
```

#### `Handler`　[插座]

类型 · 迁移 · 替代 `@go-like/server#Handler`

处理路由之后的一个内部请求；ctx 是 rpc.server 单元的 Context，已含元数据与截止时间。

```ts
export type Handler = (ctx: Context, request: Request) => Response | Promise<Response>
```

#### `TypedHandler`

类型 · 迁移 · 替代 `@go-like/server#TypedHandler`

处理一个类型化一元请求。

```ts
export type TypedHandler<Request extends Struct, Response extends Struct> = (
  ctx: Context,
  request: Infer<Request>
) => Infer<Response> | Promise<Infer<Response>>
```

#### `Middleware`　[插座]

类型 · 迁移 · 替代 `@go-like/server#Middleware`

包装一个 Handler；在 rpc.server 单元内运行，先声明者在最外层。

```ts
export type Middleware = (next: Handler) => Handler
```

#### `HTTPRoute`

接口 · 迁移 · 替代 `@go-like/server#HTTPRoute`

把一个确切的 HTTP 方法与路径映射到已注册的一元端点。

```ts
export interface HTTPRoute {
  readonly method: string
  readonly path: string
  readonly service: string
  readonly endpoint: string
  readonly successStatus: number
}
```

#### `ServerOptions`

接口 · 迁移 · 替代 `@go-like/server#ServerOptions`

服务端的不可变配置，由 ServerOption 归约得到。

```ts
export interface ServerOptions {
  readonly address: string
  readonly advertise: string | null
  readonly transport: Transport | null
  readonly middleware: readonly Middleware[]
  readonly operationMiddleware: ReadonlyMap<string, readonly Middleware[]>
  readonly listenOptions: readonly ListenOption[]
  readonly httpRoutes: readonly HTTPRoute[]
  readonly streamKeepAliveMs: number
  readonly maxSendMessageBytes: number
}
```

#### `ServerOption`

类型 · 迁移 · 替代 `@go-like/server#ServerOption`

作用于 ServerOptions 的选项函数。

```ts
export type ServerOption = (options: ServerOptions) => ServerOptions
```

#### `HandlerRegistration`

接口 · 迁移 · 替代 `@go-like/server#HandlerRegistration`

一条处理器注册：端点与其处理函数。

```ts
export interface HandlerRegistration {
  readonly endpoint: Endpoint
  readonly handler: (ctx: Context, request: unknown) => unknown
}
```

#### `HandlerRegistrar`

接口 · 迁移 · 替代 `@go-like/server#HandlerRegistrar`

处理器注册器：按类型化端点、原始 (service, endpoint) 或批量注册处理器。

```ts
export interface HandlerRegistrar {
  registerHandler<Request extends Struct, Response extends Struct>(
    endpoint: Endpoint<Request, Response, false>,
    handler: TypedHandler<Request, Response>
  ): void
  registerHandler<Request extends Struct, Response extends Struct>(
    endpoint: Endpoint<Request, Response, true>,
    handler: (ctx: Context, request: Infer<Request>) => AsyncIterable<Infer<Response>>
  ): void
  registerHandler(service: string, endpoint: string, handler: Handler): void
  registerHandlers(handlers: readonly HandlerRegistration[]): void
}
```

#### `Server`

接口 · 迁移 · 替代 `@go-like/server#Server`

内部 RPC 服务端：同时是生命周期 Server、Endpointer 与处理器注册器。

```ts
export interface Server extends LifecycleServer, Endpointer, HandlerRegistrar {
  /** transport.kind(). */
  protocol(): string
  /** Seals, binds once, returns the advertised URL (Listener.addr() when absolute, else `${kind}://${addr}`). */
  endpoint(ctx: Context): Promise<string>
  options(): ServerOptions
  string(): string
}
```

### `@go-like/core/client`

角色：机制；lane：P；23 个导出。

内部 RPC 客户端：调用管线、连接池、服务发现与选择、重试与 SSE 流，通过 withTransport 接入任意 Transport。Call/ClientMiddleware 是可实现的套接字；rpc.client 遥测单元固定在管线最外层，中间件只承载用户策略（熔断、授权等）。

#### `withEndpoint`

函数 · 迁移 · 替代 `@go-like/client#withEndpoint`

指定固定的服务端地址（一个或多个）。

```ts
export declare function withEndpoint(endpoint: string | readonly string[]): ClientOption
```

#### `withDiscovery`

函数 · 迁移 · 替代 `@go-like/client#withDiscovery`

通过服务发现解析服务实例。

```ts
export declare function withDiscovery(value: Discovery): ClientOption
```

#### `withBlock`

函数 · 迁移 · 替代 `@go-like/client#withBlock`

发现结果为空时阻塞等待而不是立即失败。

```ts
export declare function withBlock(): ClientOption
```

#### `withSelector`

函数 · 迁移 · 替代 `@go-like/client#withSelector`

指定实例选择器；缺省时使用

```ts
export declare function withSelector(value: Selector): ClientOption
```

#### `withTransport`

函数 · 迁移 · 替代 `@go-like/client#withTransport`

指定客户端使用的 Transport（必需，没有静默默认值）。

```ts
export declare function withTransport(value: Transport): ClientOption
```

#### `middleware`

函数 · 迁移 · 替代 `@go-like/client#middleware`

追加全局客户端中间件，按声明顺序，先声明者在最外层。

```ts
export declare function middleware(value: ClientMiddleware): ClientOption
```

#### `use`

函数 · 迁移 · 替代 `@go-like/client#use`

为匹配 selector 的操作追加客户端中间件。

```ts
export declare function use(selector: string, ...values: readonly ClientMiddleware[]): ClientOption
```

#### `circuitBreakerMiddleware`

函数 · 语义变化 · 替代 `@go-like/client#circuitBreakerMiddleware`

熔断中间件：每个操作一个熔断器，熔断器以 operation 命名（CircuitBreakerOptions.name）。

```ts
export declare function circuitBreakerMiddleware(options: CircuitBreakerOptions): ClientMiddleware
```

#### `closeTimeout`

函数 · 迁移 · 替代 `@go-like/client#closeTimeout`

设置 close 等待池内连接关闭的上限（毫秒）。

```ts
export declare function closeTimeout(timeoutMs: number): ClientOption
```

#### `poolSize`

函数 · 迁移 · 替代 `@go-like/client#poolSize`

设置连接池的最大空闲连接数。

```ts
export declare function poolSize(maxIdle: number): ClientOption
```

#### `poolTtl`

函数 · 迁移 · 替代 `@go-like/client#poolTtl`

设置空闲连接的存活时间（毫秒）。

```ts
export declare function poolTtl(milliseconds: number): ClientOption
```

#### `withFilter`

函数 · 迁移 · 替代 `@go-like/client#withFilter`

单次调用选项：在选择实例前按过滤器筛选候选实例。

```ts
export declare function withFilter(...values: readonly Filter[]): CallOption
```

#### `withRetry`

函数 · 迁移 · 替代 `@go-like/client#withRetry`

单次调用选项：显式授权重试；没有它时只尝试一次。

```ts
export declare function withRetry(options: CallRetryOptions): CallOption
```

#### `newClient`

函数 · 迁移 · 替代 `@go-like/client#newClient`

创建内部 RPC 客户端；必须通过 withTransport(...) 指定 Transport。

```ts
export declare function newClient(...options: readonly ClientOption[]): Client
```

#### `CallRequest`

接口 · 迁移 · 替代 `@go-like/client#CallRequest`

由一个 Fetch 请求承载的原始一元调用。

```ts
export interface CallRequest {
  readonly service: string
  readonly endpoint: string
  readonly headers: HeadersInit
  readonly body: Uint8Array | null
}
```

#### `Client`

接口 · 迁移 · 替代 `@go-like/client#Client`

内部 RPC 客户端：类型化 call/stream、原始 call 与 close。

```ts
export interface Client {
  call<Request extends Struct, ResponseSchema extends Struct>(
    ctx: Context,
    endpoint: Endpoint<Request, ResponseSchema>,
    request: NoInfer<Infer<Request>>,
    ...options: readonly CallOption[]
  ): Promise<Infer<ResponseSchema>>
  call(ctx: Context, request: CallRequest, ...options: readonly CallOption[]): Promise<Response>
  stream<Request extends Struct, ResponseSchema extends Struct>(
    ctx: Context,
    endpoint: Endpoint<Request, ResponseSchema, true>,
    request: NoInfer<Infer<Request>>,
    ...options: readonly CallOption[]
  ): Promise<ServerStream<Infer<ResponseSchema>>>
  /** Stops pooled transport clients and the resolver; ctx bounds only the caller's wait. */
  close(ctx: Context): Promise<void>
}
```

#### `CallOptions`

接口 · 迁移 · 替代 `@go-like/client#CallOptions`

单次调用的不可变选项：端点过滤器与显式的重试授权。

```ts
export interface CallOptions {
  readonly filters: readonly Filter[]
  /** Explicit replay authorization (ADR 0005) or null for exactly one attempt. */
  readonly retry: RetryOptions | null
}
```

#### `CallOption`

类型 · 语义变化 · 替代 `@go-like/client#CallOption`

单次调用选项（品牌类型）：只能由 withFilter/withRetry 产生，因此 withEndpoint(...) 或服务端选项无法误作调用选项传入。

```ts
export type CallOption = ServiceCallOption & ((options: CallOptions) => CallOptions)
```

#### `CallRetryOptions`

类型 · 迁移 · 替代 `@go-like/client#CallRetryOptions`

withRetry 接受的重试配置（即 resilience 的 RetryOptions）。

```ts
export type CallRetryOptions = RetryOptions
```

#### `Call`　[插座]

类型 · 语义变化 · 替代 `@go-like/client#Call`

一次逻辑原始调用，是具体的函数类型（此前是 transport 的泛型 Handler）。

```ts
export type Call = (
  ctx: Context,
  request: CallRequest,
  ...options: readonly CallOption[]
) => Promise<Response>
```

#### `ClientMiddleware`　[插座]

类型 · 语义变化 · 替代 `@go-like/client#ClientMiddleware`

包装一次逻辑调用（含全部重试尝试）；在 rpc.client 单元内运行，先声明者在最外层。

```ts
export type ClientMiddleware = (next: Call) => Call
```

#### `ClientOptions`

接口 · 迁移 · 替代 `@go-like/client#ClientOptions`

客户端的不可变配置，由 ClientOption 归约得到。

```ts
export interface ClientOptions {
  readonly addresses: readonly string[]
  readonly service: string | null
  readonly discovery: Discovery | null
  readonly selector: Selector | null
  readonly transport: Transport | null
  readonly block?: boolean
  readonly middleware: readonly ClientMiddleware[]
  readonly operationMiddleware: ReadonlyMap<string, readonly ClientMiddleware[]>
  readonly closeTimeoutMs: number
  readonly poolSize?: number
  readonly poolTtlMs?: number
}
```

#### `ClientOption`

类型 · 迁移 · 替代 `@go-like/client#ClientOption`

作用于 ClientOptions 的选项函数。

```ts
export type ClientOption = (options: ClientOptions) => ClientOptions
```

### `@go-like/core/web`

角色：插座+机制；lane：P；7 个导出。

对外 HTTP 的 Fetch 处理器套接字及其 Context 桥：单参数 Handler 与 hono/elysia/h3 的 `app.fetch` 同形，由 /web/node、/web/bun 与插件宿主承载；contextHandler 与 requestContext 让路由取得宿主创建的请求 Context，createHealthHandler 基于 ProbeRegistry 提供 livez/readyz。

#### `contextHandler`

函数 · 语义变化 · 替代 `@go-like/web#contextHandler`

把 ContextHandler 适配为 Handler。每请求 Context 派生自 requestContext(request) ?? background()（此前是 background()）；它仍在处理器结束、请求中止或超时时取消。不是由 core 宿主创建的 Request（被框架克隆或单元测试直接构造）会丢失 AppInfo 与遥测。

```ts
export declare function contextHandler(
  handler: ContextHandler,
  options?: ContextHandlerOptions
): Handler
```

#### `requestContext`

函数 · 新增

返回 core web 宿主为这个确切 Request 对象创建的请求 Context（类似 Go 的 `r.Context()`）：派生自宿主的接纳 ctx，遥测观察时携带 http.server 单元的 span，并在客户端中止、宿主强制关闭或首个终止响应体事件时取消；Request 不是由 core 宿主交付（或被框架克隆）时返回 null。

```ts
export declare function requestContext(request: Request): Context | null
```

#### `createHealthHandler`

函数 · 迁移 · 替代 `@go-like/web/health#createHealthHandler`

基于 ProbeRegistry 创建存活/就绪处理器：仅 GET/HEAD，返回 JSON {status, checks}，状态 200 或 503；响应带标记，core 不为其写完成日志。

```ts
export declare function createHealthHandler(
  registry: ProbeRegistry,
  options?: HealthHandlerOptions
): Handler
```

#### `Handler`　[插座]

类型 · 迁移 · 替代 `@go-like/web#Handler`

处理一个标准 Web 请求；与 hono/elysia/h3 的 `app.fetch` 同形（单参数 ABI）。

```ts
export type Handler = (request: Request) => Response | Promise<Response>
```

#### `ContextHandler`

类型 · 迁移 · 替代 `@go-like/web#ContextHandler`

带显式请求级 Context 的处理函数。

```ts
export type ContextHandler = (ctx: Context, request: Request) => Response | Promise<Response>
```

#### `ContextHandlerOptions`

接口 · 迁移 · 替代 `@go-like/web#ContextHandlerOptions`

contextHandler 的选项（每请求超时）。

```ts
export interface ContextHandlerOptions {
  readonly timeoutMs?: number
}
```

#### `HealthHandlerOptions`

接口 · 迁移 · 替代 `@go-like/web/health#HealthHandlerOptions`

createHealthHandler 的路径选项。

```ts
export interface HealthHandlerOptions {
  /** Default "/livez". */
  readonly livePath?: string
  /** Default "/readyz". */
  readonly readyPath?: string
}
```

### `@go-like/core/web/node`

角色：运行时绑定；lane：N；10 个导出。

本入口是 web Handler 的 Node 运行时宿主（node:http、node:stream），公开声明不引用 Node 类型。它既是生命周期 Server 也是 Endpointer；绑定调用（endpoint 或 start，先到者）的 ctx 成为宿主 ctx，每个请求在 http.server 遥测单元中处理。

#### `hostname`

函数 · 迁移 · 替代 `@go-like/web/node#hostname`

设置监听主机名。

```ts
export declare function hostname(value: string): NodeServerOption
```

#### `port`

函数 · 迁移 · 替代 `@go-like/web/node#port`

设置监听端口。

```ts
export declare function port(value: number): NodeServerOption
```

#### `nodeShutdownTimeout`

函数 · 迁移 · 替代 `@go-like/web/node#nodeShutdownTimeout`

设置优雅关停的等待上限（毫秒），超时后强制关闭。

```ts
export declare function nodeShutdownTimeout(timeoutMs: number): NodeServerOption
```

#### `newNodeServer`

函数 · 迁移 · 替代 `@go-like/web/node#newNodeServer`

创建承载 Handler 的 Node web 宿主。

```ts
export declare function newNodeServer(
  handler: Handler,
  ...options: readonly NodeServerOption[]
): NodeServer
```

#### `NodeServer`

接口 · 迁移 · 替代 `@go-like/web/node#NodeServer`

Node web 宿主：生命周期 Server 与 Endpointer。

```ts
export interface NodeServer extends Server, Endpointer {
  /** "http". */
  protocol(): string
  /** Binds once; returns http://host:port/. The binding call's ctx becomes the host ctx. */
  endpoint(ctx: Context): Promise<string>
}
```

#### `NodeServerOptions`

接口 · 迁移 · 替代 `@go-like/web/node#NodeServerOptions`

Node 宿主的不可变配置。

```ts
export interface NodeServerOptions {
  readonly hostname: string
  readonly port: number
  readonly shutdownTimeoutMs: number
}
```

#### `NodeServerOption`

类型 · 迁移 · 替代 `@go-like/web/node#NodeServerOption`

作用于 NodeServerOptions 的选项函数。

```ts
export type NodeServerOption = (options: NodeServerOptions) => NodeServerOptions
```

#### `NodeServerAlreadyStartedError`

接口 · 迁移 · 替代 `@go-like/web/node#NodeServerAlreadyStartedError`

宿主已启动后再次启动时的稳定错误（`GO_LIKE_NODE_SERVER_ALREADY_STARTED`）。

```ts
export interface NodeServerAlreadyStartedError extends Error {
  readonly name: "NodeServerAlreadyStartedError"
  readonly code: "GO_LIKE_NODE_SERVER_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}
```

#### `NodeServerForceCloseError`

接口 · 迁移 · 替代 `@go-like/web/node#NodeServerForceCloseError`

关停超时后强制关闭仍活动连接时的稳定错误（`GO_LIKE_NODE_SERVER_FORCE_CLOSE`）。

```ts
export interface NodeServerForceCloseError extends Error {
  readonly name: "NodeServerForceCloseError"
  readonly code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE"
  readonly timeoutMs: number
  readonly activeConnections: number
}
```

#### `NodeServerUnexpectedCloseError`

接口 · 迁移 · 替代 `@go-like/web/node#NodeServerUnexpectedCloseError`

宿主在未请求关闭时意外关闭的稳定错误（`GO_LIKE_NODE_SERVER_UNEXPECTED_CLOSE`）。

```ts
export interface NodeServerUnexpectedCloseError extends Error {
  readonly name: "NodeServerUnexpectedCloseError"
  readonly code: "GO_LIKE_NODE_SERVER_UNEXPECTED_CLOSE"
}
```

### `@go-like/core/web/bun`

角色：运行时绑定；lane：B；9 个导出。

本入口是 web Handler 的 Bun 运行时宿主：以结构方式使用 globalThis.Bun.serve，不依赖 Bun 类型。它既是生命周期 Server 也是 Endpointer；请求 Context 由宿主接纳 ctx 派生，并在 http.server 遥测单元中处理每个请求。

#### `hostname`

函数 · 迁移 · 替代 `@go-like/web/bun#hostname`

设置监听主机名。

```ts
export declare function hostname(value: string): BunServerOption
```

#### `port`

函数 · 迁移 · 替代 `@go-like/web/bun#port`

设置监听端口。

```ts
export declare function port(value: number): BunServerOption
```

#### `bunShutdownTimeout`

函数 · 迁移 · 替代 `@go-like/web/bun#bunShutdownTimeout`

设置优雅关停的等待上限（毫秒），超时后强制关闭。

```ts
export declare function bunShutdownTimeout(timeoutMs: number): BunServerOption
```

#### `newBunServer`

函数 · 迁移 · 替代 `@go-like/web/bun#newBunServer`

创建承载 Handler 的 Bun web 宿主。

```ts
export declare function newBunServer(
  handler: Handler,
  ...options: readonly BunServerOption[]
): BunServer
```

#### `BunServer`

接口 · 迁移 · 替代 `@go-like/web/bun#BunServer`

Bun web 宿主：生命周期 Server 与 Endpointer。

```ts
export interface BunServer extends Server, Endpointer {
  protocol(): string
  endpoint(ctx: Context): Promise<string>
}
```

#### `BunServerOptions`

接口 · 迁移 · 替代 `@go-like/web/bun#BunServerOptions`

Bun 宿主的不可变配置。

```ts
export interface BunServerOptions {
  readonly hostname: string
  readonly port: number
  readonly shutdownTimeoutMs: number
}
```

#### `BunServerOption`

类型 · 迁移 · 替代 `@go-like/web/bun#BunServerOption`

作用于 BunServerOptions 的选项函数。

```ts
export type BunServerOption = (options: BunServerOptions) => BunServerOptions
```

#### `BunServerAlreadyStartedError`

接口 · 迁移 · 替代 `@go-like/web/bun#BunServerAlreadyStartedError`

宿主已启动后再次启动时的稳定错误（`GO_LIKE_BUN_SERVER_ALREADY_STARTED`）。

```ts
export interface BunServerAlreadyStartedError extends Error {
  readonly name: "BunServerAlreadyStartedError"
  readonly code: "GO_LIKE_BUN_SERVER_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}
```

#### `BunServerForceCloseError`

接口 · 迁移 · 替代 `@go-like/web/bun#BunServerForceCloseError`

关停超时后强制关闭仍活动请求时的稳定错误（`GO_LIKE_BUN_SERVER_FORCE_CLOSE`）。

```ts
export interface BunServerForceCloseError extends Error {
  readonly name: "BunServerForceCloseError"
  readonly code: "GO_LIKE_BUN_SERVER_FORCE_CLOSE"
  readonly timeoutMs: number
  readonly activeRequests: number
}
```

### `@go-like/core/registry`

角色：插座+机制；lane：P；33 个导出。

服务注册与发现的 socket 与机制：Registrar、Discovery、Watcher、Registry、Selector 及参考选择器、过滤器、快照校验、发现解析器与 selectEndpoint。由 consul、etcd、kubernetes、zookeeper、mdns 等 plug 实现 Registry，由 App 内核（注册）、核心客户端与 Connect plug（发现与选择）消费。

#### `Discovery`　[插座]

接口 · 迁移 · 替代 `@go-like/registry#Discovery`

读取并监听完整的服务实例快照；由注册中心类 plug 实现，客户端的解析器与选择器消费它。watch transfers ownership of the returned Watcher to the caller, who must stop it.

```ts
export interface Discovery {
  getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]>
  /** The first next returns the current snapshot when it is non-empty. */
  watch(ctx: Context, name: string): Promise<Watcher>
}
```

#### `DiscoveryResolver`

接口 · 迁移 · 替代 `@go-like/client/discovery#DiscoveryResolver`

常驻的按服务快照缓存，包裹一个 Discovery；按需惰性打开每个服务的 watcher，由核心客户端和 Connect plug 的 gRPC 客户端复用。

```ts
export interface DiscoveryResolver {
  /** Latest snapshot; opens one watcher per service lazily; block waits until an endpoint exists. */
  getService(ctx: Context, name: string, block?: boolean): Promise<readonly ServiceInstance[]>
  /** Starts the single owner drain of every watcher; ctx bounds only this wait. */
  close(ctx: Context): Promise<void>
}
```

#### `EWMASelectorOptions`

接口 · 迁移 · 替代 `@go-like/registry#EWMASelectorOptions`

newEWMASelector 的选项：可注入随机数与时钟，并可追加端点健康失败的判定。

```ts
export interface EWMASelectorOptions {
  readonly random?: () => number
  readonly now?: () => number
  /** Extra endpoint-health failures after the built-in portable classification. */
  readonly isFailure?: (error: Error) => boolean
}
```

#### `Filter`　[插座]

类型 · 迁移 · 替代 `@go-like/registry#Filter`

在端点选择之前对一份 ServiceInstance 快照做过滤（版本、标签等）；由应用实现并经 client 的 withFilter 等传入。

```ts
export type Filter = (instances: readonly ServiceInstance[]) => readonly ServiceInstance[]
```

#### `NoAvailableEndpointError`

接口 · 迁移 · 替代 `@go-like/registry#NoAvailableEndpointError`

过滤后没有任何可选端点时，Selector 抛出的错误。

```ts
export interface NoAvailableEndpointError extends Error {
  readonly name: "NoAvailableEndpointError"
  readonly code: "GO_LIKE_NO_AVAILABLE_ENDPOINT"
}
```

#### `P2CSelectorOptions`

接口 · 迁移 · 替代 `@go-like/registry#P2CSelectorOptions`

newP2CSelector 的选项：可注入随机数与时钟，便于确定性测试。

```ts
export interface P2CSelectorOptions {
  /** One random number in [0, 1). */
  readonly random?: () => number
  /** Finite non-negative monotonic milliseconds; default performance.now. */
  readonly now?: () => number
  /** Consecutive failures before cooldown; default 3. */
  readonly failureThreshold?: number
  /** Cooldown in integer milliseconds; default 10000. */
  readonly cooldownMs?: number
}
```

#### `RegistrationErrorHandler`

类型 · 迁移 · 替代 `@go-like/registry/provider#RegistrationErrorHandler`

观察一个常驻注册世代的永久丢失，是各注册中心 plug 的选项，仅供通知，不控制状态。

```ts
export type RegistrationErrorHandler = (
  error: Error,
  service: ServiceInstance
) => void | Promise<void>
```

#### `Registrar`　[插座]

接口 · 迁移 · 替代 `@go-like/registry#Registrar`

注册与注销服务实例；由注册中心类 plug 实现，App 内核在所有 Server 就绪后调用 register、停止 Server 之前调用 deregister。Ownership: the App kernel calls register after every Server was admitted and deregister before Servers stop. A plug that keeps a registration alive (TTL heartbeat, lease, ephemeral node) owns that private resident work until deregister or until onRegistrationError reports its loss. Terminal: register resolving means the backend accepted the instance; ctx bounds only the caller wait.

```ts
export interface Registrar {
  register(ctx: Context, service: ServiceInstance): Promise<void>
  deregister(ctx: Context, service: ServiceInstance): Promise<void>
}
```

#### `Registry`　[插座]

接口 · 迁移 · 替代 `@go-like/registry#Registry`

完整的注册中心契约：同一个对象既是 Registrar 也是 Discovery，一个后端 plug 通常只需实现它。

```ts
export interface Registry extends Registrar, Discovery {}
```

#### `RegistryProtocolError`

接口 · 迁移 · 替代 `@go-like/registry#RegistryProtocolError`

注册中心后端返回了无法解析或违反协议的响应。

```ts
export interface RegistryProtocolError extends Error {
  readonly name: "RegistryProtocolError"
  readonly code: "GO_LIKE_REGISTRY_PROTOCOL"
}
```

#### `RegistryStateError`

接口 · 迁移 · 替代 `@go-like/registry#RegistryStateError`

注册中心对象处于不允许该操作的状态（例如重复注册后的冲突或已关闭）。

```ts
export interface RegistryStateError extends Error {
  readonly name: "RegistryStateError"
  readonly code: "GO_LIKE_REGISTRY_STATE"
  readonly operation: string
  readonly state: string
}
```

#### `SelectionDone`

类型 · 迁移 · 替代 `@go-like/registry#SelectionDone`

完成一次选择观察的回调，调用它不转移任何资源所有权。

```ts
export type SelectionDone = (ctx: Context, outcome: SelectionOutcome) => void
```

#### `SelectionOutcome`

接口 · 迁移 · 替代 `@go-like/registry#SelectionOutcome`

一次已完成请求的结果，回报给选出该端点的 Selector，用于健康与延迟统计。

```ts
export interface SelectionOutcome {
  readonly error: Error | null
  readonly replyMetadata?: Metadata
  readonly bytesSent?: boolean
  readonly bytesReceived?: boolean
}
```

#### `Selector`　[插座]

接口 · 迁移 · 替代 `@go-like/registry#Selector`

从一份完整快照中选出一个端点；有意设计为同步：不持有常驻资源、不做 I/O、不重试（research/adr/0004 :146-147）。

```ts
export interface Selector {
  select(
    ctx: Context,
    instances: readonly ServiceInstance[]
  ): readonly [ServiceEndpoint, SelectionDone]
}
```

#### `ServiceEndpoint`

接口 · 迁移 · 替代 `@go-like/registry#ServiceEndpoint`

Selector 选中的一个端点及其所属的不可变 ServiceInstance。

```ts
export interface ServiceEndpoint {
  readonly instance: ServiceInstance
  readonly url: string
}
```

#### `ServiceInstance`

接口 · 迁移 · 替代 `@go-like/registry#ServiceInstance`

一个已注册或经服务发现返回的服务实例，是 Registry 各 socket 之间传递的不可变数据。端点由 snapshotServiceInstance 校验并规范化，使用方不应自行修改。

```ts
export interface ServiceInstance {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly metadata: Readonly<Record<string, string>>
  /** Absolute URLs without credentials or fragments (enforced by snapshotServiceInstance). */
  readonly endpoints: readonly string[]
}
```

#### `UnsupportedRegistryCapabilityError`

接口 · 迁移 · 替代 `@go-like/registry#UnsupportedRegistryCapabilityError`

后端不支持被请求的注册中心能力（例如 mDNS 不支持某类元数据）。

```ts
export interface UnsupportedRegistryCapabilityError extends Error {
  readonly name: "UnsupportedRegistryCapabilityError"
  readonly code: "GO_LIKE_UNSUPPORTED_REGISTRY_CAPABILITY"
  readonly capability: string
}
```

#### `Watcher`　[插座]

接口 · 迁移 · 替代 `@go-like/registry#Watcher`

一个服务的完整替换快照流（从不发增量，空快照有意义）；由 Discovery.watch 返回，调用方负责 stop。stop starts one owner drain; every caller ctx bounds only its own wait; next after stop rejects with WatcherStoppedError; a full buffer is terminal WatcherOverflowError.

```ts
export interface Watcher {
  next(ctx: Context): Promise<readonly ServiceInstance[]>
  stop(ctx: Context): Promise<void>
}
```

#### `WatcherOverflowError`

接口 · 迁移 · 替代 `@go-like/registry#WatcherOverflowError`

Watcher 的缓冲队列写满，是该 Watcher 的终止性失败。

```ts
export interface WatcherOverflowError extends Error {
  readonly name: "WatcherOverflowError"
  readonly code: "GO_LIKE_WATCHER_OVERFLOW"
  readonly bufferSize: number
}
```

#### `WatcherStoppedError`

接口 · 迁移 · 替代 `@go-like/registry#WatcherStoppedError`

Watcher 已 stop 后再调用 next 时的拒绝原因。

```ts
export interface WatcherStoppedError extends Error {
  readonly name: "WatcherStoppedError"
  readonly code: "GO_LIKE_WATCHER_STOPPED"
}
```

#### `EndpointSelection`

接口 · 新增

一次经过校验的 Selector 选择结果，及其恰好一次的反馈发布；核心客户端与 Connect plug 共用同一份 Selector 契约处理。

```ts
export interface EndpointSelection {
  /** The selected endpoint URL (ServiceEndpoint.url), validated as a non-empty well-formed string. */
  readonly url: string
  /**
   * Publishes the outcome to the Selector's SelectionDone with withoutCancel(ctx). Never throws:
   * returns the feedback failure (a throw, or a thenable completion, which violates the synchronous
   * SelectionDone contract) or null. A second call returns a TypeError and does not call the Selector.
   */
  done(ctx: Context, outcome: SelectionOutcome): Error | null
}
```

#### `selectEndpoint`

函数 · 新增

调用 selector.select(ctx, instances) 并校验其同步元组契约，返回 EndpointSelection。Throws TypeError for a malformed tuple and the Selector's own failure (for example NoAvailableEndpointError) unchanged.

```ts
export declare function selectEndpoint(
  ctx: Context,
  selector: Selector,
  instances: readonly ServiceInstance[]
): EndpointSelection
```

#### `filterLabel`

函数 · 迁移 · 替代 `@go-like/registry#filterLabel`

只保留元数据中 key 等于 value 的实例的快照过滤器。

```ts
export declare function filterLabel(key: string, value: string): Filter
```

#### `filterVersion`

函数 · 迁移 · 替代 `@go-like/registry#filterVersion`

只保留指定版本的实例的快照过滤器。

```ts
export declare function filterVersion(version: string): Filter
```

#### `newEWMASelector`

函数 · 迁移 · 替代 `@go-like/registry#newEWMASelector`

基于延迟指数加权移动平均（EWMA）的选择器，倾向于选出近期响应更快的端点。

```ts
export declare function newEWMASelector(options?: EWMASelectorOptions): Selector
```

#### `newNoAvailableEndpointError`

函数 · 迁移 · 替代 `@go-like/registry#newNoAvailableEndpointError`

创建没有可用端点时抛出的 NoAvailableEndpointError，供自定义 Selector 使用。

```ts
export declare function newNoAvailableEndpointError(): NoAvailableEndpointError
```

#### `newP2CSelector`

函数 · 迁移 · 替代 `@go-like/registry#newP2CSelector`

两选一（power of two choices）选择器：随机取两个端点，选出较空闲者，并对连续失败的端点做冷却。

```ts
export declare function newP2CSelector(options?: P2CSelectorOptions): Selector
```

#### `newRandomSelector`

函数 · 迁移 · 替代 `@go-like/registry#newRandomSelector`

随机选择器；可注入返回 [0, 1) 的随机函数以便测试。

```ts
export declare function newRandomSelector(random?: () => number): Selector
```

#### `newRoundRobinSelector`

函数 · 迁移 · 替代 `@go-like/registry#newRoundRobinSelector`

轮询选择器：按快照顺序依次选出端点，是客户端的默认 Selector。

```ts
export declare function newRoundRobinSelector(): Selector
```

#### `newWeightedRoundRobinSelector`

函数 · 迁移 · 替代 `@go-like/registry#newWeightedRoundRobinSelector`

加权轮询选择器；weight 为每个端点返回其正权重。

```ts
export declare function newWeightedRoundRobinSelector(
  weight: (endpoint: ServiceEndpoint) => number
): Selector
```

#### `snapshotServiceInstance`

函数 · 迁移 · 替代 `@go-like/registry/provider#snapshotServiceInstance`

校验、规范化（元数据与端点排序）并深度冻结一个 ServiceInstance；每个注册中心 plug 返回快照前都应调用它。

```ts
export declare function snapshotServiceInstance(value: ServiceInstance): ServiceInstance
```

#### `snapshotServiceInstances`

函数 · 迁移 · 替代 `@go-like/registry/provider#snapshotServiceInstances`

校验一份完整快照（同名同 id 不得重复）、排序并打上标记；已带标记的快照原样返回。

```ts
export declare function snapshotServiceInstances(
  values: readonly ServiceInstance[]
): readonly ServiceInstance[]
```

#### `newDiscoveryResolver`

函数 · 迁移 · 替代 `@go-like/client/discovery#newDiscoveryResolver`

创建常驻的服务发现缓存（惰性按服务打开 watcher、失败后用常驻循环重建、由所有者统一排空），核心客户端与 Connect plug 共用。

```ts
export declare function newDiscoveryResolver(discovery: Discovery): DiscoveryResolver
```

### `@go-like/core/registry/provider`

角色：插头 SDK；lane：P；18 个导出。

面向 Registry plug 作者的 SDK：错误工厂、共享选项校验、共享替换快照 Watcher、按身份的 FIFO 锁、常驻心跳循环与摘要工具。只供注册中心类 plug 使用，应用代码不应直接导入；它们依赖 @go-like/core/registry 的 socket 声明。

#### `newRegistryStateError`

函数 · 迁移 · 替代 `@go-like/registry/provider#newRegistryStateError`

创建 RegistryStateError：对象当前状态不允许该操作。

```ts
export declare function newRegistryStateError(operation: string, state: string): RegistryStateError
```

#### `newWatcherStoppedError`

函数 · 迁移 · 替代 `@go-like/registry/provider#newWatcherStoppedError`

创建 WatcherStoppedError：Watcher 已停止后仍调用 next。

```ts
export declare function newWatcherStoppedError(): WatcherStoppedError
```

#### `newWatcherOverflowError`

函数 · 迁移 · 替代 `@go-like/registry/provider#newWatcherOverflowError`

创建 WatcherOverflowError：缓冲写满的终止性失败。bufferSize 1..4096, RangeError otherwise.

```ts
export declare function newWatcherOverflowError(bufferSize: number): WatcherOverflowError
```

#### `newRegistryProtocolError`

函数 · 迁移 · 替代 `@go-like/registry/provider#newRegistryProtocolError`

创建 RegistryProtocolError：后端响应违反协议，可携带底层原因。

```ts
export declare function newRegistryProtocolError(
  message: string,
  cause?: Error
): RegistryProtocolError
```

#### `newUnsupportedRegistryCapabilityError`

函数 · 迁移 · 替代 `@go-like/registry/provider#newUnsupportedRegistryCapabilityError`

创建 UnsupportedRegistryCapabilityError：后端不支持某项能力，并说明原因。

```ts
export declare function newUnsupportedRegistryCapabilityError(
  capability: string,
  reason: string
): UnsupportedRegistryCapabilityError
```

#### `providerOptions`

函数 · 迁移 · 替代 `@go-like/registry/provider#providerOptions`

校验并冻结共享控制项；I/O 之前以 TypeError 或 RangeError 拒绝非法值。

```ts
export declare function providerOptions(value: ProviderOptionInput): ProviderOptions
```

#### `notifyRegistrationError`

函数 · 迁移 · 替代 `@go-like/registry/provider#notifyRegistrationError`

以快照调用借用的 onRegistrationError 观察者；其同步抛出或异步拒绝都会被吞掉。

```ts
export declare function notifyRegistrationError(
  handler: RegistrationErrorHandler | null,
  error: Error,
  service: ServiceInstance
): void
```

#### `sha256Base32`

函数 · 新增

通过 crypto.subtle 计算 SHA-256(bytes)，返回小写、无填充的 RFC 4648 base32（52 个字符），用于派生稳定的注册标识。

```ts
export declare function sha256Base32(bytes: Uint8Array): Promise<string>
```

#### `newSnapshotWatcher`

函数 · 新增

创建每个注册中心 plug 都返回的 Watcher。watch 的 ctx 只提供值，watcher 的寿命长于它；提供 poll 时由核心在遥测规则 R4b（enterRoot(detachSpan(withoutCancel(ctx)))）下运行循环。Throws ctx's failure when ctx already ended.

```ts
export declare function newSnapshotWatcher(
  ctx: Context,
  options: SnapshotWatcherOptions
): SnapshotWatcher
```

#### `newIdentityLocks`

函数 · 新增

创建一个 IdentityLocks；每个注册中心实例各建一个，不要放在模块作用域。

```ts
export declare function newIdentityLocks(): IdentityLocks
```

#### `startHeartbeat`

函数 · 新增

启动一个注册世代的续约循环。registerCtx 是传给 Registrar.register 的 ctx：核心保留它用于诊断记录（与 "registry register" 单元做 trace 关联），并在 enterRoot(detachSpan(withoutCancel(registerCtx))) 下运行循环。

```ts
export declare function startHeartbeat(registerCtx: Context, options: HeartbeatOptions): Heartbeat
```

#### `ProviderOptionInput`

接口 · 迁移 · 替代 `@go-like/registry/provider#ProviderOptionInput`

Registry plug 共享的输入选项（今天的选项包去掉了 logger 成员）。

```ts
export interface ProviderOptionInput {
  readonly onRegistrationError?: RegistrationErrorHandler | null
  /** Bounds every non-blocking backend request; integer 1..2147483647, default 5000. */
  readonly timeoutMs?: number
}
```

#### `ProviderOptions`

接口 · 迁移 · 替代 `@go-like/registry/provider#ProviderOptions`

providerOptions 校验并冻结后的共享选项。

```ts
export interface ProviderOptions {
  readonly onRegistrationError: RegistrationErrorHandler | null
  readonly timeoutMs: number
}
```

#### `SnapshotWatcherOptions`

接口 · 新增

共享的替换快照 Watcher 的选项。

```ts
export interface SnapshotWatcherOptions {
  /** Snapshot established at watch admission; queued for the first next only when non-empty. */
  readonly initial: readonly ServiceInstance[]
  /** Queue bound, integer 1..4096. Overflow is terminal WatcherOverflowError. */
  readonly bufferSize: number
  /**
   * One step of the resident loop. Resolves with the next complete snapshot, or null when nothing
   * changed. Rejects to report a failure. Omit for push-only watchers (call publish).
   */
  readonly poll?: (ctx: Context) => Promise<readonly ServiceInstance[] | null>
  /** Delay before the poll after the n-th consecutive failure; any successful poll resets n. Required with poll. */
  readonly backoff?: Backoff
  /** Failures after which the loop backs off and polls again; any other failure is terminal. Default: none. */
  readonly retryable?: (error: unknown) => boolean
  /** Minimum milliseconds between the starts of two polls; wake() ends the wait early. Default 0. */
  readonly intervalMs?: number
  /** Releases plug resources once, inside the first stop, after the loop exited (a terminal failure ends the loop; the owner still calls stop). */
  readonly release?: (ctx: Context) => Promise<void>
}
```

#### `SnapshotWatcher`

接口 · 新增

plug 持有的一个共享 Watcher 的句柄：把 watcher 交给调用方，自己通过 publish、wake、fail 驱动它。

```ts
export interface SnapshotWatcher {
  /** Returned to the caller of Discovery.watch, who owns it. */
  readonly watcher: Watcher
  /** Loop Context: values of the watch ctx without its span; canceled at stop or terminal failure. */
  readonly ctx: Context
  /** Publishes one complete snapshot (validated with snapshotServiceInstances); an equal consecutive snapshot is dropped. */
  publish(snapshot: readonly ServiceInstance[]): void
  /** Ends the current interval wait early (a native change notification arrived). */
  wake(): void
  /** Terminates the watcher: pending and later next calls reject with error. */
  fail(error: Error): void
}
```

#### `IdentityLocks`

接口 · 新增

按注册身份分组的 FIFO 互斥锁。

```ts
export interface IdentityLocks {
  /**
   * Resolves with an idempotent release once every earlier holder of identity released. When ctx
   * ends first it rejects with ctx's cause and the abandoned position is skipped.
   */
  acquire(ctx: Context, identity: string): Promise<() => void>
  /** Identities that currently have a holder or a waiter. */
  size(): number
}
```

#### `HeartbeatOptions`

接口 · 新增

一个注册世代私有续约循环的选项。

```ts
export interface HeartbeatOptions {
  /** The registered instance, passed to onRegistrationError. */
  readonly instance: ServiceInstance
  /** Registration identity whose lock every renewal holds. */
  readonly identity: string
  readonly locks: IdentityLocks
  /** Delay between successful renewals (consul and etcd: Math.floor(ttlMs / 2)). */
  readonly intervalMs: number
  /** After a retryable failure the next delay is min(retryMaximumMs, max(retryInitialMs, floor(previous / 2))). */
  readonly retryInitialMs: number
  readonly retryMaximumMs: number
  readonly retryable: (error: unknown) => boolean
  /** One renewal under ctx (canceled when the heartbeat stops). A non-retryable throw ends the generation. */
  readonly renew: (ctx: Context) => Promise<void>
  /** Called with the lock held when the generation ends by a non-retryable failure, before onRegistrationError. */
  readonly lost: (error: Error) => void
  readonly onRegistrationError: RegistrationErrorHandler | null
  /** Fixed message of the go_like.registry.heartbeat_failed record. Never error text. */
  readonly message: string
}
```

#### `Heartbeat`

接口 · 新增

一个已启动的续约循环的句柄，只能被停止。

```ts
export interface Heartbeat {
  /** Ends the generation: no renewal starts afterwards, an in-flight renewal's ctx is canceled, resolves when the loop exited. ctx bounds only this wait. */
  stop(ctx: Context): Promise<void>
}
```

### `@go-like/core/registry/memory`

角色：参考实现；lane：P；3 个导出。

进程内的参考 Registry 实现，同时也是静态服务发现：用于测试与单进程应用，没有第三方依赖。由应用或测试直接构造，作为 Registrar 与 Discovery 传给 App 内核和客户端。

#### `newMemoryRegistry`

函数 · 新增

创建进程内 Registry；instances 或 watchBufferSize 非法时在返回前抛出 TypeError 或 RangeError。

```ts
export declare function newMemoryRegistry(options?: MemoryRegistryOptions): MemoryRegistry
```

#### `MemoryRegistryOptions`

接口 · 新增

newMemoryRegistry 的选项。

```ts
export interface MemoryRegistryOptions {
  /** Instances visible before any register call (static discovery); snapshotted at construction. */
  readonly instances?: readonly ServiceInstance[]
  /** Per-watcher queue bound, integer 1..4096, default 128. */
  readonly watchBufferSize?: number
}
```

#### `MemoryRegistry`

接口 · 新增

进程内 Registry。状态属于实例：两个 registry 从不共享实例；请把同一个对象同时传给 registrar 与 discovery。

```ts
export interface MemoryRegistry extends Registry {}
```

### `@go-like/core/config`

角色：插座+机制；lane：P；41 个导出。

配置的 socket 与机制：ConfigSource、ConfigDecoder、ConfigResolver、文件能力，以及 newConfig（合并、占位符、校验、重载）、对象/环境变量/文件源与 jsonDecoder。由 consul、etcd、vault、kubernetes、yaml 等 plug 实现源或解码器；应用与 App 内核之外的服务代码消费 Config。同时类型再导出 Standard Schema。

#### `StandardSchemaV1`　[插座]

接口 · 新增

标准 Schema 接口：任何校验库（struct、zod、valibot、arktype）实现它后，都能被 config 等消费者接受。

```ts
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>
}
```

#### `StandardTypedV1`

接口 · 新增

Standard Schema 的基础类型接口：只携带 `~standard` 属性（版本、供应方、输入输出类型），被 StandardSchemaV1 等规范扩展；经 `@go-like/core/config` 作类型再导出。

```ts
export interface StandardTypedV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardTypedV1.Props<Input, Output>
}
```

#### `Config`

接口 · 迁移 · 替代 `@go-like/config#Config`

配置门面：合并多个源、校验、重载并提供点分路径访问。它不是 Server：由应用调用 load 与 close（research/adr/0003 :79-83）。

```ts
export interface Config<T extends ConfigValue = ConfigObject> {
  readonly [configOutput]?: T
  load(ctx: Context): Promise<void>
  scan<Input extends ConfigValue, Output extends ConfigValue>(
    ctx: Context,
    schema: StandardSchemaV1<Input, Output>
  ): Promise<Output>
  value(key: string): Value
  watch(key: string, observer: Observer): void
  close(ctx: Context): Promise<void>
}
```

#### `ConfigAlreadyLoadedError`

接口 · 迁移 · 替代 `@go-like/config#ConfigAlreadyLoadedError`

对已经 load 过的 Config 再次 load 时的拒绝原因。

```ts
export interface ConfigAlreadyLoadedError extends Error {
  readonly name: "ConfigAlreadyLoadedError"
  readonly code: "GO_LIKE_CONFIG_ALREADY_LOADED"
  readonly status: "loading" | "loaded" | "closing" | "closed" | "failed"
}
```

#### `ConfigDecoder`　[插座]

类型 · 改名 · 替代 `@go-like/config/file#FileDecoder`、`@go-like/config-consul#ConsulDecoder`、`@go-like/config-etcd#EtcdDecoder`、`@go-like/config-kubernetes#KubernetesDecoder`

把一份完整文档文本解码为 ConfigObject；origin 在错误信息中指明文档（路径或键）。内置 jsonDecoder，YAML 由

```ts
export type ConfigDecoder = (text: string, origin: string) => ConfigObject
```

#### `ConfigNotFoundError`

接口 · 迁移 · 替代 `@go-like/config#ConfigNotFoundError`

访问不存在的配置键。

```ts
export interface ConfigNotFoundError extends Error {
  readonly name: "ConfigNotFoundError"
  readonly code: "GO_LIKE_CONFIG_NOT_FOUND"
  readonly key: string
}
```

#### `ConfigObject`

接口 · 迁移 · 替代 `@go-like/config#ConfigObject`

配置文档的根：键到 ConfigValue 的只读映射。

```ts
export interface ConfigObject {
  readonly [key: string]: ConfigValue
}
```

#### `ConfigOption`

类型 · 迁移 · 替代 `@go-like/config#ConfigOption`

newConfig 的一个选项（source、schema、resolver、onReloadError、onTerminalError 的结果）；携带 schema 的输出类型。

```ts
export type ConfigOption<T extends ConfigValue = never> = ((settings: ConfigSettings) => void) & {
  readonly [configOptionOutput]?: T
}
```

#### `ConfigReloadErrorHandler`

类型 · 迁移 · 替代 `@go-like/config#ConfigReloadErrorHandler`

观察一次重载失败（Config 保留上一份有效配置继续重试）。

```ts
export type ConfigReloadErrorHandler = (error: Error, current: ConfigValue | null) => void
```

#### `ConfigResolver`　[插座]

类型 · 迁移 · 替代 `@go-like/config#ConfigResolver`

合并之后、校验之前对合并文档的变换（例如占位符展开）。

```ts
export type ConfigResolver = (
  ctx: Context,
  value: ConfigObject
) => ConfigObject | Promise<ConfigObject>
```

#### `ConfigScalar`

类型 · 迁移 · 替代 `@go-like/config#ConfigScalar`

配置值域中的标量：null、布尔、数字或字符串。

```ts
export type ConfigScalar = null | boolean | number | string
```

#### `ConfigSchema`

类型 · 迁移 · 替代 `@go-like/config#ConfigSchema`

配置 schema：任何输入为 ConfigObject、输出为 T 的 Standard Schema（Zod、Valibot、ArkType 或 struct 构建器）。

```ts
export type ConfigSchema<T extends ConfigValue> = StandardSchemaV1<ConfigObject, T>
```

#### `ConfigSource`　[插座]

接口 · 迁移 · 替代 `@go-like/config#ConfigSource`

一份配置文档的来源；由对象、环境变量、文件以及 consul、etcd、vault、kubernetes 等 plug 实现。load 返回完整文档；watch（可选）从 load 返回的修订号起打开 watcher；每一轮重载 Config 都会重新 load 所有源。

```ts
export interface ConfigSource {
  readonly name: string
  load(ctx: Context): Promise<ConfigSourceSnapshot>
  readonly watch?: (ctx: Context, revision: string | null) => Promise<ConfigSourceWatcher>
}
```

#### `ConfigSourceError`

接口 · 迁移 · 替代 `@go-like/config#ConfigSourceError`

某个配置源在 load、watch、next 或 stop 阶段失败；sourceName 与 phase 指明位置。

```ts
export interface ConfigSourceError extends Error {
  readonly name: "ConfigSourceError"
  readonly code: "GO_LIKE_CONFIG_SOURCE"
  readonly sourceName: string
  readonly phase: "load" | "watch" | "next" | "stop"
}
```

#### `ConfigSourceMissingError`

接口 · 新增

配置源的文档不存在（consul 404、etcd 空范围、Kubernetes 404 或缺键、Vault 404）。Config 像对待任何 load 失败一样把它包进 phase 为 load 的 ConfigSourceError。

```ts
export interface ConfigSourceMissingError extends Error {
  readonly name: "ConfigSourceMissingError"
  readonly code: "GO_LIKE_CONFIG_SOURCE_MISSING"
  readonly sourceName: string
}
```

#### `ConfigSourceSnapshot`

接口 · 迁移 · 替代 `@go-like/config#ConfigSourceSnapshot`

ConfigSource.load 返回的完整文档与其后端修订号。

```ts
export interface ConfigSourceSnapshot {
  readonly value: ConfigObject
  /** Opaque backend revision used to open a gap-free watch; null when the source has none. */
  readonly revision: string | null
}
```

#### `ConfigSourceWatcher`　[插座]

接口 · 迁移 · 替代 `@go-like/config#ConfigSourceWatcher`

一个配置源的“有变化”通知流（已合并）；由 ConfigSource.watch 返回，Config 拥有它并在排空时恰好 stop 一次。Terminal: a rejected next (other than after Config's own cancellation) is a terminal Config failure.

```ts
export interface ConfigSourceWatcher {
  next(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}
```

#### `ConfigTerminalErrorHandler`

类型 · 迁移 · 替代 `@go-like/config#ConfigTerminalErrorHandler`

观察 Config 的终止性失败（例如某个 watcher 的 next 拒绝）。

```ts
export type ConfigTerminalErrorHandler = (error: Error) => void | Promise<void>
```

#### `ConfigValidationError`

接口 · 迁移 · 替代 `@go-like/config#ConfigValidationError`

合并后的配置未通过 schema 校验（含 schema 抛出、结果畸形或输出非法）。

```ts
export interface ConfigValidationError extends Error {
  readonly name: "ConfigValidationError"
  readonly code: "GO_LIKE_CONFIG_VALIDATION"
  readonly reason: "issues" | "threw" | "malformed-result" | "invalid-output"
  readonly issues: readonly StandardSchemaV1.Issue[]
}
```

#### `ConfigValue`

类型 · 迁移 · 替代 `@go-like/config#ConfigValue`

配置值域（类 JSON）：标量、对象或值的只读数组。

```ts
export type ConfigValue = ConfigScalar | ConfigObject | readonly ConfigValue[]
```

#### `Observer`

类型 · 迁移 · 替代 `@go-like/config#Observer`

点分路径的值变化观察者。

```ts
export type Observer = (key: string, value: Value) => void
```

#### `Value`

接口 · 迁移 · 替代 `@go-like/config#Value`

以 Kratos 风格的点分路径访问的一个实时配置视图。

```ts
export interface Value {
  load(): ConfigValue | null
  scan<Input extends ConfigValue, Output extends ConfigValue>(
    ctx: Context,
    schema: StandardSchemaV1<Input, Output>
  ): Promise<Output>
}
```

#### `newConfig`

函数 · 迁移 · 替代 `@go-like/config#newConfig`

用一组选项创建 Config；输出类型由 schema(...) 选项推导，没有 schema 时为 ConfigObject。

```ts
export declare function newConfig<const Options extends readonly ConfigOption<ConfigValue>[]>(
  ...options: Options
): Config<ConfigOutput<Options>>
```

#### `objectSource`

函数 · 迁移 · 替代 `@go-like/config#objectSource`

以一个内存对象构造 ConfigSource（无 watch），用于默认值与测试。

```ts
export declare function objectSource(name: string, value: ConfigObject): ConfigSource
```

#### `onReloadError`

函数 · 迁移 · 替代 `@go-like/config#onReloadError`

选项：观察重载失败。

```ts
export declare function onReloadError(handler: ConfigReloadErrorHandler): ConfigOption
```

#### `onTerminalError`

函数 · 迁移 · 替代 `@go-like/config#onTerminalError`

选项：观察 Config 的终止性失败。

```ts
export declare function onTerminalError(handler: ConfigTerminalErrorHandler): ConfigOption
```

#### `placeholderResolver`

函数 · 迁移 · 替代 `@go-like/config#placeholderResolver`

创建展开 ${...} 占位符的 ConfigResolver，用 resolver(...) 选项接入。

```ts
export declare function placeholderResolver(): ConfigResolver
```

#### `resolver`

函数 · 迁移 · 替代 `@go-like/config#resolver`

选项：追加一个在合并之后、校验之前运行的 ConfigResolver。

```ts
export declare function resolver(value: ConfigResolver): ConfigOption
```

#### `schema`

函数 · 迁移 · 替代 `@go-like/config#schema`

选项：设置校验合并结果的 Standard Schema，并决定 Config 的输出类型。

```ts
export declare function schema<T extends ConfigValue>(value: ConfigSchema<T>): ConfigOption<T>
```

#### `source`

函数 · 迁移 · 替代 `@go-like/config#source`

选项：追加一个或多个配置源，按顺序合并，后者覆盖前者。

```ts
export declare function source(...sources: readonly ConfigSource[]): ConfigOption
```

#### `jsonDecoder`

常量 · 改名 · 替代 `@go-like/config/file#jsonFileDecoder`、`@go-like/config-consul#jsonConsulDecoder`、`@go-like/config-etcd#jsonEtcdDecoder`、`@go-like/config-kubernetes#jsonKubernetesDecoder`

严格 JSON 解码器，根必须是安全的 ConfigObject；取代 jsonFileDecoder 与 consul、etcd、kubernetes 三份插件内的副本。

```ts
export declare const jsonDecoder: ConfigDecoder
```

#### `EnvironmentRecord`

类型 · 迁移 · 替代 `@go-like/config/env#EnvironmentRecord`

显式注入的环境变量记录（例如 process.env 或 Bun.env）。

```ts
export type EnvironmentRecord = Readonly<Record<string, string | undefined>>
```

#### `EnvSourceOptions`

接口 · 迁移 · 替代 `@go-like/config/env#EnvSourceOptions`

envSource 的选项。

```ts
export interface EnvSourceOptions {
  /** Default "env". */
  readonly name?: string
  /** Only names starting with prefix are selected; the prefix is stripped. Default "". */
  readonly prefix?: string
  /** Path separator inside a name, default "__". */
  readonly separator?: string
  /** Lowercases path segments, default true. */
  readonly lowercase?: boolean
  /** Default: values stay strings. */
  readonly decode?: EnvValueDecoder
}
```

#### `EnvValueDecoder`

类型 · 迁移 · 替代 `@go-like/config/env#EnvValueDecoder`

解码一个被选中的环境变量字符串。

```ts
export type EnvValueDecoder = (
  value: string,
  environmentName: string,
  path: readonly string[]
) => ConfigValue
```

#### `envSource`

函数 · 迁移 · 替代 `@go-like/config/env#envSource`

以显式注入的环境记录构造 ConfigSource；从不读取运行时全局，在构造时捕获快照。

```ts
export declare function envSource(
  environment: EnvironmentRecord,
  options?: EnvSourceOptions
): ConfigSource
```

#### `FileCapability`　[插座]

接口 · 迁移 · 替代 `@go-like/config/file#FileCapability`

文件系统能力，使 fileSource 与运行时无关；核心在

```ts
export interface FileCapability {
  read(ctx: Context, path: string): Promise<FileReadResult>
  readonly watch?: (ctx: Context, path: string, changed: FileChangeListener) => Promise<FileWatcher>
}
```

#### `FileChangeListener`

类型 · 迁移 · 替代 `@go-like/config/file#FileChangeListener`

接收文件监视器发来的一次“已变脏”通知。

```ts
export type FileChangeListener = () => void
```

#### `FileReadResult`

接口 · 迁移 · 替代 `@go-like/config/file#FileReadResult`

FileCapability.read 的结果：文本与内容修订号。

```ts
export interface FileReadResult {
  readonly text: string
  /** Content revision (the Node host uses a SHA-256 of the bytes); null when unknown. */
  readonly revision: string | null
}
```

#### `FileSourceOptions`

接口 · 迁移 · 替代 `@go-like/config/file#FileSourceOptions`

fileSource 的选项。

```ts
export interface FileSourceOptions {
  /** Default "file". */
  readonly name?: string
  /** Default jsonDecoder; decodeYaml from @go-like/yaml/config also fits. */
  readonly decode?: ConfigDecoder
}
```

#### `FileWatcher`　[插座]

接口 · 迁移 · 替代 `@go-like/config/file#FileWatcher`

一个原生文件订阅；所有权在接纳时转移给 fileSource。

```ts
export interface FileWatcher {
  stop(ctx: Context): Promise<void>
  /** Stable terminal barrier; a rejection or a resolution before stop is a terminal source failure. */
  done(): Promise<void>
}
```

#### `fileSource`

函数 · 迁移 · 替代 `@go-like/config/file#fileSource`

通过注入的 FileCapability 读取并监视一个文件，构造 ConfigSource。

```ts
export declare function fileSource(
  capability: FileCapability,
  path: string,
  options?: FileSourceOptions
): ConfigSource
```

### `@go-like/core/config/provider`

角色：插头 SDK；lane：P；5 个导出。

面向 ConfigSource 与 ConfigDecoder plug 作者的 SDK：共享的源 watcher、缺失文档错误工厂与 JSON 值准入校验。只供配置类 plug（consul、etcd、vault、kubernetes、yaml）使用，依赖 @go-like/core/config 的 socket 声明。

#### `newSourceWatcher`

函数 · 新增

创建每个配置源返回的 watcher。next 是单飞的（并发的第二次 next 会被拒绝）；stop 幂等：取消循环、等待其退出、运行一次 release，ctx 只限制调用方的等待。循环运行在 enterRoot(detachSpan(withoutCancel(ctx))) 之下。Throws ctx's failure when ctx already ended.

```ts
export declare function newSourceWatcher(
  ctx: Context,
  options?: SourceWatcherOptions
): SourceWatcher
```

#### `newConfigSourceMissingError`

函数 · 新增

创建缺失文档错误：源的 load 在文档不存在且 plug 的 optional 标志未设置时抛出它。

```ts
export declare function newConfigSourceMissingError(sourceName: string): ConfigSourceMissingError
```

#### `admitConfigObject`

函数 · 新增

深拷贝并校验一个类 JSON 值作为 ConfigObject 的根（有限数字、普通对象、稠密数组，无访问器、环或 **proto**/prototype/constructor 键）。TypeError names origin. Consumers:

```ts
export declare function admitConfigObject(value: unknown, origin: string): ConfigObject
```

#### `SourceWatcherOptions`

接口 · 新增

newSourceWatcher 的选项。

```ts
export interface SourceWatcherOptions {
  /**
   * One step of the resident loop: resolves true when the document changed since the previous
   * successful step. Omit for push-only watchers (call changed()). A successful step that follows
   * one or more failed steps counts as a change (changes may have been missed while failing).
   */
  readonly poll?: (ctx: Context) => Promise<boolean>
  /** Delay before the step after the n-th consecutive failure; a successful step resets n. Required with poll. */
  readonly backoff?: Backoff
  /** Failures after which the loop backs off and polls again; any other failure is terminal. Default: none. */
  readonly retryable?: (error: unknown) => boolean
  /** Minimum milliseconds between the starts of two steps; wake() ends the wait early. Default 0. */
  readonly intervalMs?: number
  /** True when the source already knows it changed between load and watch (revision mismatch). */
  readonly dirty?: boolean
  /** Releases plug resources once, inside the first stop, after the loop exited (a terminal failure ends the loop; the owner still calls stop). */
  readonly release?: (ctx: Context) => Promise<void>
}
```

#### `SourceWatcher`

接口 · 新增

plug 持有的一个源 watcher 的句柄：把 watcher 交给 Config，自己通过 changed、wake、fail 驱动它。

```ts
export interface SourceWatcher {
  /** Returned from ConfigSource.watch; Config owns it. */
  readonly watcher: ConfigSourceWatcher
  /** Loop Context: values of the watch ctx without its span; canceled at stop or terminal failure. */
  readonly ctx: Context
  /** Records one change; coalesced until the next next(). No-op after stop. */
  changed(): void
  /** Ends the current interval wait early. */
  wake(): void
  /** Terminal failure: the pending and every later next() reject with error. */
  fail(error: Error): void
}
```

### `@go-like/core/config/node`

角色：运行时绑定；lane：N；1 个导出。

Node 运行时绑定：基于 node:fs、node:fs/promises、node:path 与 node:crypto 的 FileCapability。只属于 Node 车道（Bun 亦可运行）；公开声明不引用 Node 类型，应用把它传给 fileSource。

#### `newNodeFileCapability`

函数 · 迁移 · 替代 `@go-like/config/node#newNodeFileCapability`

创建 Node 文件能力：用 readFile 读取，修订号是内容哈希，监视父目录以便看见 rename 式替换。

```ts
export declare function newNodeFileCapability(): FileCapability
```

### `@go-like/core/fetch`

角色：插座+机制；lane：P；14 个导出。

标准 Fetch 能力 socket，以及基于它的后端协议客户端机制（JSON、文本、换行分隔帧、源与请求头校验、可重试状态码）。由应用注入 Fetch，consul、etcd、vault、kubernetes 等 HTTP 后端 plug 消费并构造自己的共享客户端；核心不自己发起网络调用。

#### `Fetch`　[插座]

类型 · 新增

一次标准 Fetch 调用，是每个 HTTP 后端 plug 注入的能力。全局 fetch 即满足它；应用可传入包装函数来添加 mTLS、代理或集群 CA。Ownership: borrowed; plugs never close it.

```ts
export type Fetch = (request: Request) => Promise<Response>
```

#### `FetchClient`

接口 · 新增

基于注入 Fetch 的后端协议客户端机制：每个方法都用 redirect "error" 和 ctx.done() 作为 signal 发请求；ctx 先结束时 promise 以 ctx 的原始失败（cause(ctx) ?? ctx.err()）拒绝，不会被包装。

```ts
export interface FetchClient<Operation extends string> {
  /** Resolves for 2xx and allowed statuses with the body unread. */
  send(ctx: Context, request: FetchRequest<Operation>): Promise<Response>
  text(ctx: Context, request: FetchRequest<Operation>): Promise<FetchText>
  json(ctx: Context, request: FetchRequest<Operation>): Promise<FetchJson>
  frames(
    ctx: Context,
    request: FetchRequest<Operation>,
    options?: FrameOptions
  ): Promise<FrameReader>
}
```

#### `FetchClientOptions`

接口 · 新增

newFetchClient 的选项：注入的 Fetch、源、鉴权与错误构造器。

```ts
export interface FetchClientOptions<Operation extends string> {
  readonly fetch: Fetch
  /** From parseOrigin. */
  readonly origin: URL
  /** Sets credential headers on each Request immediately before fetch. */
  readonly authorize?: (headers: Headers) => void
  /** True when authorize adds a secret: transport causes are replaced by fixed secret-safe Errors. */
  readonly secret: boolean
  readonly errors: FetchErrors<Operation>
  /** Bytes of a failed body read for errors.http, integer 0..65536, default 0 (discarded unread). */
  readonly errorBodyBytes?: number
}
```

#### `FetchErrors`

接口 · 新增

由后端自有的错误构造器：每个 plug 保留自己的错误名与 GO_LIKE_<BACKEND>_* 代码。

```ts
export interface FetchErrors<Operation extends string> {
  /** Non-2xx status that is not allowed. body: the first errorBodyBytes of the body, null when not read. */
  http(operation: Operation, status: number, body: string | null): Error
  /** Fetch or body-read rejection while ctx is active. cause is the original Error, or a fixed Error when secret. */
  transport(operation: Operation, cause: Error): Error
  /** Malformed response: not a Response, invalid JSON, invalid UTF-8, frame above the bound. */
  protocol(operation: Operation): Error
}
```

#### `FetchJson`

接口 · 新增

FetchClient.json 的结果。

```ts
export interface FetchJson {
  readonly status: number
  readonly headers: Headers
  /** null for an allowed non-2xx status. */
  readonly value: unknown
}
```

#### `FetchMethod`

类型 · 新增

FetchClient 支持的 HTTP 方法。

```ts
export type FetchMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
```

#### `FetchRequest`

接口 · 新增

一次后端请求的描述；Operation 是该后端的有界操作名，会复制进每个错误。

```ts
export interface FetchRequest<Operation extends string> {
  /** Bounded operation name, copied into every error. */
  readonly operation: Operation
  readonly method: FetchMethod
  /** Absolute path with already percent-encoded segments, resolved against the client origin. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  /** Accept header, default "application/json". */
  readonly accept?: string
  /** Serialized with JSON.stringify and sent as application/json. Mutually exclusive with body. */
  readonly json?: unknown
  /** Sent as is with contentType. */
  readonly body?: string
  readonly contentType?: string
  /** Non-2xx statuses returned to the caller instead of becoming errors.http (absence 404, CAS 409, expired 410). */
  readonly allow?: readonly number[]
}
```

#### `FetchText`

接口 · 新增

FetchClient.text 的结果。

```ts
export interface FetchText {
  readonly status: number
  readonly headers: Headers
  /** "" for an allowed non-2xx status (its body is cancelled unread). */
  readonly text: string
}
```

#### `FrameOptions`

接口 · 新增

FetchClient.frames 的选项。

```ts
export interface FrameOptions {
  /** Bound of one newline-delimited frame in bytes, default 1048576. */
  readonly maxFrameBytes?: number
}
```

#### `FrameReader`

接口 · 新增

按换行分隔的 JSON 帧流（etcd /v3/watch、Kubernetes ?watch=true）。请求 ctx 限制整个流。

```ts
export interface FrameReader {
  readonly status: number
  readonly headers: Headers
  /** Next frame without its newline; null at the clean end of the body. ctx bounds only this read. */
  next(ctx: Context): Promise<string | null>
  /** Cancels the body; idempotent. */
  close(): void
}
```

#### `headerValue`

函数 · 新增

校验请求头值：非空、不含 CR 或 LF、能被 Headers.set(header, value) 接受；TypeError 指明 label，从不回显值。

```ts
export declare function headerValue(value: string, header: string, label: string): string
```

#### `isRetryableStatus`

函数 · 新增

对 408、425、429 与 500..599 返回 true：今天每个后端 plug 都会重试的可用性状态码。

```ts
export declare function isRetryableStatus(status: number): boolean
```

#### `newFetchClient`

函数 · 新增

创建 FetchClient；fetch 不可调用或 errors 不完整时，在任何 I/O 之前抛出 TypeError。

```ts
export declare function newFetchClient<Operation extends string>(
  options: FetchClientOptions<Operation>
): FetchClient<Operation>
```

#### `parseOrigin`

函数 · 新增

解析 http: 或 https: 源（origin）：不得含凭据、路径、查询或片段；TypeError 指明 label，从不回显输入。

```ts
export declare function parseOrigin(address: string, label: string): URL
```

### `@go-like/core/cache`

角色：插座；lane：P；5 个导出。

字节缓存的 socket 与用户 API：`Cache` 接口、`put` 选项与 `putOptions` 解析器。由 `@go-like/core/cache/memory` 与 `@go-like/redis/cache` 等插件实现，由应用和其他核心机制消费；持有连接的提供者另外实现内核 `Server` 形状并加入 `resources(...)` 资源层，socket 本身没有生命周期。

#### `expiresIn`

函数 · 迁移 · 替代 `@go-like/cache#expiresIn`

设置缓存值的存活时长，单位为正安全整数毫秒；否则抛出 RangeError。

```ts
export declare function expiresIn(valueMs: number): PutOption
```

#### `putOptions`

函数 · 迁移 · 替代 `@go-like/cache/provider#putOptions`

插件作者用：从冻结的“无过期”默认值出发，按顺序归约 put 选项；I/O 之前抛出 TypeError/RangeError。

```ts
export declare function putOptions(options?: readonly PutOption[]): PutOptions
```

#### `PutOptions`

接口 · 迁移 · 替代 `@go-like/cache#PutOptions`

一次 put 调用生效选项的不可变快照。

```ts
export interface PutOptions {
  readonly expiresInMs: number | null
}
```

#### `PutOption`

类型 · 迁移 · 替代 `@go-like/cache#PutOption`

把一份不可变 put 选项快照归约为下一份候选快照的函数。

```ts
export type PutOption = (options: PutOptions) => PutOptions
```

#### `Cache`　[插座]

接口 · 迁移 · 替代 `@go-like/cache#Cache`

与提供者无关的可丢弃字节缓存；插件实现它，应用按键读写。socket 不含生命周期：持有连接的提供者另行实现内核 `Server` 形状，并通过 `resources(...)` 注册，`start` 在可用时即 resolve。

```ts
export interface Cache {
  /** Reads one exact key or returns null when no unexpired value exists. Returned bytes belong to the caller. */
  get(ctx: Context, key: string): Promise<Uint8Array | null>
  /** Creates or replaces one exact key; the provider copies the caller's bytes. */
  put(ctx: Context, key: string, value: Uint8Array, ...options: readonly PutOption[]): Promise<void>
  /** Deletes one exact key; a missing key is a successful no-op. */
  delete(ctx: Context, key: string): Promise<void>
  /** Returns one stable provider diagnostic name. */
  string(): string
}
```

### `@go-like/core/cache/memory`

角色：参考实现；lane：P；6 个导出。

`Cache` 的进程内参考实现：每实例一个 Map、惰性过期、无定时器、无生命周期。无需任何外部系统，供测试与单进程应用使用，也是 `cacheConformance` 的基准提供者。

#### `newMemoryCache`

函数 · 迁移 · 替代 `@go-like/cache-memory#newMemoryCache`

创建一个立即可用、不占常驻资源的进程内 `Cache`。

```ts
export declare function newMemoryCache(...options: readonly MemoryCacheOption[]): MemoryCache
```

#### `clock`

函数 · 迁移 · 替代 `@go-like/cache-memory#clock`

为本内存缓存实例选择确定性的毫秒时钟。

```ts
export declare function clock(value: MemoryCacheClock): MemoryCacheOption
```

#### `MemoryCacheClock`

类型 · 迁移 · 替代 `@go-like/cache-memory#MemoryCacheClock`

返回毫秒时间戳的时钟，用于确定性的过期判断。

```ts
export type MemoryCacheClock = () => number
```

#### `MemoryCacheOptions`

接口 · 迁移 · 替代 `@go-like/cache-memory#MemoryCacheOptions`

内存缓存构造选项的不可变快照。

```ts
export interface MemoryCacheOptions {
  readonly clock: MemoryCacheClock
}
```

#### `MemoryCacheOption`

类型 · 迁移 · 替代 `@go-like/cache-memory#MemoryCacheOption`

把一份内存缓存选项快照归约为下一份候选快照的函数。

```ts
export type MemoryCacheOption = (options: MemoryCacheOptions) => MemoryCacheOptions
```

#### `MemoryCache`

接口 · 迁移 · 替代 `@go-like/cache-memory#MemoryCache`

进程内 `Cache`：无定时器、无生命周期，`string()` 恒为 "memory"。

```ts
export interface MemoryCache extends Cache {
  string(): "memory"
}
```

### `@go-like/core/store`

角色：插座；lane：P；17 个导出。

键值记录存储的 socket 与用户 API：`Store` CRUD 接口、写/删/列选项函数与 `StoreConflictError`。由 `@go-like/core/store/memory`、`@go-like/file/store` 以及 consul/etcd/vault 的存储插件实现，由应用消费；socket 没有生命周期、watch、事务或能力协商，持有资源的提供者另行实现内核 `Server` 形状。

#### `expiresIn`

函数 · 迁移 · 替代 `@go-like/store#expiresIn`

设置记录存活时长，单位为正安全整数毫秒。

```ts
export declare function expiresIn(valueMs: number): WriteOption
```

#### `ifAbsent`

函数 · 迁移 · 替代 `@go-like/store#ifAbsent`

仅当记录不存在时写入；同时清除 `ifRevision`。

```ts
export declare function ifAbsent(): WriteOption
```

#### `ifRevision`

函数 · 迁移 · 替代 `@go-like/store#ifRevision`

以不透明修订号作为 CAS 令牌，同时适用于写入与删除。

```ts
export declare function ifRevision(revision: string): WriteOption & DeleteOption
```

#### `prefix`

函数 · 迁移 · 替代 `@go-like/store#prefix`

列表过滤：只返回键以该前缀开头的记录。

```ts
export declare function prefix(value: string): ListOption
```

#### `limit`

函数 · 迁移 · 替代 `@go-like/store#limit`

列表分页大小上限。

```ts
export declare function limit(count: number): ListOption
```

#### `cursor`

函数 · 迁移 · 替代 `@go-like/store#cursor`

列表续读：传入上一页返回的不透明游标。

```ts
export declare function cursor(value: string): ListOption
```

#### `StoreRecord`

接口 · 迁移 · 替代 `@go-like/store#StoreRecord`

一条已存储记录：值字节、元数据、不透明修订号与可选过期时刻。

```ts
export interface StoreRecord {
  readonly key: string
  readonly value: Uint8Array
  readonly metadata: Readonly<Record<string, string>>
  /** Opaque compare-and-swap token. */
  readonly revision: string
  readonly expiresAt: number | null
}
```

#### `StoreRecordInput`

接口 · 迁移 · 替代 `@go-like/store#StoreRecordInput`

写入一条记录时的输入：键、值字节与可选元数据。

```ts
export interface StoreRecordInput {
  readonly key: string
  readonly value: Uint8Array
  readonly metadata?: Readonly<Record<string, string>>
}
```

#### `StorePage`

接口 · 迁移 · 替代 `@go-like/store#StorePage`

一页列表结果；`cursor` 为 null 表示没有后续页。

```ts
export interface StorePage {
  readonly records: readonly StoreRecord[]
  readonly cursor: string | null
}
```

#### `WriteOptions`

接口 · 迁移 · 替代 `@go-like/store#WriteOptions`

一次写入生效选项的不可变快照。

```ts
export interface WriteOptions {
  readonly expiresInMs: number | null
  /** When true, admits the write only while no visible record exists. Omitted means false. */
  readonly ifAbsent?: boolean
  readonly ifRevision: string | null
}
```

#### `DeleteOptions`

接口 · 迁移 · 替代 `@go-like/store#DeleteOptions`

一次删除生效选项的不可变快照。

```ts
export interface DeleteOptions {
  readonly ifRevision: string | null
}
```

#### `ListOptions`

接口 · 迁移 · 替代 `@go-like/store#ListOptions`

一次列表调用生效选项的不可变快照。

```ts
export interface ListOptions {
  readonly prefix: string
  readonly limit: number | null
  readonly cursor: string | null
}
```

#### `WriteOption`

类型 · 迁移 · 替代 `@go-like/store#WriteOption`

把一份写入选项快照归约为下一份候选快照的函数。

```ts
export type WriteOption = (options: WriteOptions) => WriteOptions
```

#### `DeleteOption`

类型 · 迁移 · 替代 `@go-like/store#DeleteOption`

把一份删除选项快照归约为下一份候选快照的函数。

```ts
export type DeleteOption = (options: DeleteOptions) => DeleteOptions
```

#### `ListOption`

类型 · 迁移 · 替代 `@go-like/store#ListOption`

把一份列表选项快照归约为下一份候选快照的函数。

```ts
export type ListOption = (options: ListOptions) => ListOptions
```

#### `StoreConflictError`

接口 · 迁移 · 替代 `@go-like/store#StoreConflictError`

乐观并发冲突：期望的修订号与实际不符，或 `ifAbsent` 写入时记录已存在。

```ts
export interface StoreConflictError extends Error {
  readonly name: "StoreConflictError"
  readonly code: "GO_LIKE_STORE_CONFLICT"
  readonly key: string
  /** Null means the caller expected the key to be absent. */
  readonly expectedRevision: string | null
  readonly actualRevision: string | null
}
```

#### `Store`　[插座]

接口 · 迁移 · 替代 `@go-like/store#Store`

键值记录的 CRUD 加诊断名；插件实现它，应用读写记录。不含生命周期、watch、事务与能力协商。

```ts
export interface Store {
  /** Reads one record or returns null when absent or expired. */
  read(ctx: Context, key: string): Promise<StoreRecord | null>
  /** Creates or replaces one record; resolves with the stored record and its new revision. */
  write(
    ctx: Context,
    record: StoreRecordInput,
    ...options: readonly WriteOption[]
  ): Promise<StoreRecord>
  /** Deletes one record; resolves true when a record was removed. */
  delete(ctx: Context, key: string, ...options: readonly DeleteOption[]): Promise<boolean>
  /** Lists records in Unicode code-point key order, one page at a time. */
  list(ctx: Context, ...options: readonly ListOption[]): Promise<StorePage>
  /** Returns one stable provider diagnostic name. */
  string(): string
}
```

### `@go-like/core/store/provider`

角色：插头 SDK；lane：P；8 个导出。

`Store` 插件作者 SDK：选项解析器、冲突错误工厂、键排序与记录快照。由 `@go-like/core/store/memory`、`@go-like/file/store` 与 consul/etcd/vault 存储插件调用，应用代码一般不需要它。

#### `writeOptions`

函数 · 迁移 · 替代 `@go-like/store/provider#writeOptions`

从冻结默认值出发按序归约写入选项；I/O 之前抛出 TypeError/RangeError。

```ts
export declare function writeOptions(...options: readonly WriteOption[]): WriteOptions
```

#### `deleteOptions`

函数 · 迁移 · 替代 `@go-like/store/provider#deleteOptions`

从冻结默认值出发按序归约删除选项；I/O 之前抛出 TypeError/RangeError。

```ts
export declare function deleteOptions(...options: readonly DeleteOption[]): DeleteOptions
```

#### `listOptions`

函数 · 迁移 · 替代 `@go-like/store/provider#listOptions`

从冻结默认值出发按序归约列表选项；I/O 之前抛出 TypeError/RangeError。

```ts
export declare function listOptions(...options: readonly ListOption[]): ListOptions
```

#### `newStoreConflictError`

函数 · 迁移 · 替代 `@go-like/store/provider#newStoreConflictError`

创建冻结的 `StoreConflictError`，修订号保持不透明。

```ts
export declare function newStoreConflictError(
  key: string,
  expectedRevision: string | null,
  actualRevision: string | null
): StoreConflictError
```

#### `compareStoreKeys`

函数 · 迁移 · 替代 `@go-like/store/provider#compareStoreKeys`

按 Unicode 码点顺序比较两个存储键，用于所有提供者共同的列表排序。

```ts
export declare function compareStoreKeys(left: string, right: string): number
```

#### `snapshotStoreRecord`

函数 · 迁移 · 替代 `@go-like/store/provider#snapshotStoreRecord`

返回经校验的 `StoreRecord` 防御性副本。

```ts
export declare function snapshotStoreRecord(value: StoreRecord): StoreRecord
```

#### `snapshotStoreRecordInput`

函数 · 迁移 · 替代 `@go-like/store/provider#snapshotStoreRecordInput`

返回经校验的 `StoreRecordInput` 防御性副本。

```ts
export declare function snapshotStoreRecordInput(value: StoreRecordInput): StoreRecordInput
```

#### `snapshotStorePage`

函数 · 迁移 · 替代 `@go-like/store/provider#snapshotStorePage`

返回经校验的 `StorePage` 防御性副本。

```ts
export declare function snapshotStorePage(value: StorePage): StorePage
```

### `@go-like/core/store/memory`

角色：参考实现；lane：P；6 个导出。

`Store` 的进程内参考实现：每实例一个 Map、惰性过期、无定时器、无生命周期。无需任何外部系统，供测试与单进程应用使用，也是 `storeConformance` 的基准提供者。

#### `newMemoryStore`

函数 · 迁移 · 替代 `@go-like/store-memory#newMemoryStore`

创建一个立即可用、无常驻资源的进程内 `Store`。

```ts
export declare function newMemoryStore(...options: readonly MemoryStoreOption[]): MemoryStore
```

#### `clock`

函数 · 迁移 · 替代 `@go-like/store-memory#clock`

为本内存存储实例选择确定性的毫秒时钟。

```ts
export declare function clock(value: MemoryStoreClock): MemoryStoreOption
```

#### `MemoryStoreClock`

类型 · 迁移 · 替代 `@go-like/store-memory#MemoryStoreClock`

返回毫秒时间戳的时钟，用于确定性的过期判断。

```ts
export type MemoryStoreClock = () => number
```

#### `MemoryStoreOptions`

接口 · 迁移 · 替代 `@go-like/store-memory#MemoryStoreOptions`

内存存储构造选项的不可变快照。

```ts
export interface MemoryStoreOptions {
  readonly clock: MemoryStoreClock
}
```

#### `MemoryStoreOption`

类型 · 迁移 · 替代 `@go-like/store-memory#MemoryStoreOption`

把一份内存存储选项快照归约为下一份候选快照的函数。

```ts
export type MemoryStoreOption = (options: MemoryStoreOptions) => MemoryStoreOptions
```

#### `MemoryStore`

接口 · 迁移 · 替代 `@go-like/store-memory#MemoryStore`

进程内 `Store`，`string()` 恒为 "memory"。

```ts
export interface MemoryStore extends Store {
  string(): "memory"
}
```

### `@go-like/core/broker`

角色：插座+机制；lane：P；11 个导出。

消息代理的 socket 与机制：字节层 `Broker`/`Subscriber`、类型化 `Codec`，以及把一个订阅当作一次性 `Server` 的 `newBrokerServer`和给 `Broker` 套上编解码器的 `eventBroker`。由 `@go-like/core/broker/memory`、`@go-like/nats`、`@go-like/rabbitmq` 实现，由应用和 `@go-like/core/broker/provider` 的遥测 kit 消费；结算（ack/nak/term）保持在 `event.native` 上，不进入 socket。

#### `newBrokerServer`

函数 · 迁移 · 替代 `@go-like/broker#newBrokerServer`

机制：把一个 `Broker`（或 `EventBroker`）的单个订阅变成一次性 `Server`；start 在订阅存活期间保持 pending，提供者终止事件会令 start reject，stop 只取消订阅一次。

```ts
export declare function newBrokerServer<Event, Options>(
  broker: {
    subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: Event) => void | Promise<void>,
      options?: Options
    ): Promise<Subscriber>
  },
  topic: string,
  handler: (ctx: Context, event: Event) => void | Promise<void>,
  options?: Options
): Server
```

#### `eventBroker`

函数 · 迁移 · 替代 `@go-like/event#eventBroker`

机制：包装一个字节 `Broker`；发布时写入 content-type，解码时要求恰好是该 content-type。

```ts
export declare function eventBroker<T, PublishOptions, PublishResult, SubscribeOptions, Native>(
  broker: Broker<PublishOptions, PublishResult, SubscribeOptions, Native>,
  codec: Codec<T>
): EventBroker<T, PublishOptions, PublishResult, SubscribeOptions, Native>
```

#### `BrokerMessage`

接口 · 迁移 · 替代 `@go-like/broker#BrokerMessage`

可移植字节边界上的一条不可变载荷：头与正文。

```ts
export interface BrokerMessage {
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}
```

#### `BrokerEvent`

接口 · 迁移 · 替代 `@go-like/broker#BrokerEvent`

一次投递：`native` 是提供者自己的投递对象，是结算（ack/nak/term）的唯一权威。

```ts
export interface BrokerEvent<Native> {
  readonly topic: string
  readonly message: BrokerMessage
  readonly native: Native
}
```

#### `BrokerHandler`

类型 · 新增

投递处理函数；`ctx` 是每次投递新建的 Context，处理函数 settle 后即被取消，不要保留它去做超出处理函数生命周期的工作。

```ts
export type BrokerHandler<Native> = (
  ctx: Context,
  event: BrokerEvent<Native>
) => void | Promise<void>
```

#### `Subscriber`　[插座]

接口 · 迁移 · 替代 `@go-like/broker#Subscriber`

go-micro 风格的订阅句柄：一个订阅的所有者，而不是连接。

```ts
export interface Subscriber {
  readonly topic: string
  /** Stops admission, waits for admitted handlers; ctx bounds only this caller's wait. */
  unsubscribe(ctx: Context): Promise<void>
}
```

#### `Broker`　[插座]

接口 · 语义变化 · 替代 `@go-like/broker#Broker`

以 Context 为首参的“字节 + 主题”契约，选项、结果与原生事件均由提供者定型；插件实现它，应用发布与订阅。投递语义：每个订阅串行投递；处理函数失败会以同一个 Error 终止该订阅。

```ts
export interface Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent> {
  publish(
    ctx: Context,
    topic: string,
    message: BrokerMessage,
    options?: PublishOptions
  ): Promise<PublishResult>
  subscribe(
    ctx: Context,
    topic: string,
    handler: BrokerHandler<NativeEvent>,
    options?: SubscribeOptions
  ): Promise<Subscriber>
  /** Returns one stable provider diagnostic name. */
  string(): string
}
```

#### `Codec`　[插座]

接口 · 迁移 · 替代 `@go-like/event#Codec`

显式的类型化编解码器，没有注册表。参考实现是 `@go-like/core/struct` 的 `jsonCodec(struct)`。

```ts
export interface Codec<T> {
  readonly mediaType: string
  encode(value: T): Uint8Array
  decode(bytes: Uint8Array): T
}
```

#### `EventPublisher`

接口 · 迁移 · 替代 `@go-like/event#EventPublisher`

类型化发布端：把值编码后发布到主题。

```ts
export interface EventPublisher<T, Options, Result> {
  publish(ctx: Context, topic: string, value: T, options?: Options): Promise<Result>
}
```

#### `EventMessage`

接口 · 迁移 · 替代 `@go-like/event#EventMessage`

类型化投递：保留原生对象身份；`decode()` 惰性解码并每次返回新的防御性副本。

```ts
export interface EventMessage<T, Native> {
  readonly topic: string
  readonly native: Native
  decode(): T
}
```

#### `EventBroker`

接口 · 迁移 · 替代 `@go-like/event#EventBroker`

类型化代理：`publish` 编码值，`subscribe` 的处理函数收到 `EventMessage`。

```ts
export interface EventBroker<
  T,
  PublishOptions,
  PublishResult,
  SubscribeOptions,
  Native
> extends EventPublisher<T, PublishOptions, PublishResult> {
  subscribe(
    ctx: Context,
    topic: string,
    handler: (ctx: Context, event: EventMessage<T, Native>) => void | Promise<void>,
    options?: SubscribeOptions
  ): Promise<Subscriber>
}
```

### `@go-like/core/broker/provider`

角色：插头 SDK；lane：P；7 个导出。

`Broker` 插件作者 SDK：终止信号旁路、遥测 kit（`deliver`、`publish`）与共享的校验/快照/事件构造助手。由 `@go-like/core/broker/memory`、`@go-like/nats`、`@go-like/rabbitmq` 以及自写代理的插件调用；每个一方代理插件都必须调用 kit，并把 `brokerConformance` 与 `brokerTelemetryConformance` 作为必跑 CI 任务。

#### `registerSubscriberTerminal`

函数 · 迁移 · 替代 `@go-like/broker/provider#registerSubscriberTerminal`

在不扩宽 `Subscriber` 契约的前提下，把提供者的终止 Promise 关联到一个订阅句柄上并返回该句柄。

```ts
export declare function registerSubscriberTerminal(
  subscriber: Subscriber,
  terminal: Promise<void>
): Subscriber
```

#### `subscriberTerminal`

函数 · 迁移 · 替代 `@go-like/broker/provider#subscriberTerminal`

返回已登记的终止 Promise，没有则返回 null；`newBrokerServer` 据此感知提供者终止。

```ts
export declare function subscriberTerminal(subscriber: Subscriber): Promise<void> | null
```

#### `deliver`

函数 · 新增

遥测 kit：每个投递循环调用它，替代 `handler(subscribeCtx, event)`。派生每次投递的 Context 并开始 `process {subscription}` 单元，处理函数 settle 后释放该 Context，失败原样重抛。

```ts
export declare function deliver<Native>(
  subscriptionCtx: Context,
  system: string,
  subscription: string,
  event: BrokerEvent<Native>,
  handler: BrokerHandler<Native>
): Promise<void>
```

#### `publish`

函数 · 新增

遥测 kit：每个 `Broker.publish` 的函数体。开始 `publish {topic}` 单元，并让 `send` 收到带 traceparent 的分离消息副本。

```ts
export declare function publish<Result>(
  ctx: Context,
  system: string,
  topic: string,
  message: BrokerMessage,
  send: (ctx: Context, message: BrokerMessage) => Promise<Result>
): Promise<Result>
```

#### `brokerTopic`

函数 · 新增

校验一个可移植主题（非空、合法 UTF-16），并原样返回；否则抛出 TypeError。

```ts
export declare function brokerTopic(topic: string): string
```

#### `snapshotBrokerMessage`

函数 · 新增

校验并分离一条消息：冻结的自有头副本（名称非空合法、值为合法字符串、无原型键）与复制的正文。

```ts
export declare function snapshotBrokerMessage(message: BrokerMessage): BrokerMessage
```

#### `newBrokerEvent`

函数 · 新增

构造一个冻结的投递事件：已校验主题、冻结的头副本、每次读取返回新副本的 body getter，`native` 按身份保留。

```ts
export declare function newBrokerEvent<Native>(
  topic: string,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
  native: Native
): BrokerEvent<Native>
```

### `@go-like/core/broker/memory`

角色：参考实现；lane：P；2 个导出。

`Broker` 的进程内参考实现：精确主题匹配、每订阅 FIFO、`native` 恒为 null，publish 在所有已接纳投递 settle 后才 resolve。无需任何外部系统，供测试与单进程应用使用，也是 `brokerConformance` 的基准提供者。

#### `newMemoryBroker`

函数 · 迁移 · 替代 `@go-like/broker-memory#newMemoryBroker`

创建一个立即可用的进程内 `Broker`。

```ts
export declare function newMemoryBroker(): MemoryBroker
```

#### `MemoryBroker`

接口 · 迁移 · 替代 `@go-like/broker-memory#MemoryBroker`

进程内 `Broker`：无选项、无结果、无原生事件，`string()` 恒为 "memory"。

```ts
export interface MemoryBroker extends Broker<void, void, void, null> {
  string(): "memory"
}
```

### `@go-like/core/job`

角色：插座+机制；lane：P；21 个导出。

后台作业概念：时间触发的 `Schedule` socket、持久队列的 `JobQueue` socket，以及拥有定时器、运行、不重叠与诚实排空的 `newScheduleServer` 机制，另含参考时刻表 `newIntervalSchedule` 与作业错误。由 `@go-like/croner`（Schedule）与 `@go-like/bullmq`（JobQueue）实现，由应用消费；作业体的执行由 go-like 调用，因此每次运行都经 `@go-like/core/job/provider` 的 kit 成为可观测的单元。

#### `newScheduleServer`

函数 · 改名 · 替代 `@go-like/croner#newCronerServer`

机制：创建拥有定时器链、运行、不重叠（到期时刻遇到活动运行即跳过，不补跑）、`trigger` 与诚实排空的调度 Server；每次运行经 kit `runJob` 成为根 `run {name}` 单元。

```ts
export declare function newScheduleServer(
  schedule: Schedule,
  name: string,
  handler: TickHandler,
  options?: ScheduleServerOptions
): ScheduleServer
```

#### `newIntervalSchedule`

函数 · 新增

参考时刻表：每个对齐到 epoch 的 `intervalMs` 整数倍都是到期时刻（10000 即 :00、:10、:20 ...），`string()` 为 "interval"；`intervalMs` 必须是正安全整数，否则抛出 RangeError。纯函数，无定时器。

```ts
export declare function newIntervalSchedule(intervalMs: number): Schedule
```

#### `newPermanentJobError`

函数 · 新增

创建一个永久失败错误：处理函数抛出它即表示“失败且不重试”（BullMQ 映射为 UnrecoverableError，内存队列不再重试）。

```ts
export declare function newPermanentJobError(cause: unknown): JobPermanentError
```

#### `Schedule`　[插座]

接口 · 新增

纯时刻表：只计算到期时刻，没有定时器、I/O、生命周期或回调。由 croner 等插件实现；定时器、运行、重叠与排空都归核心的 `newScheduleServer`。

```ts
export interface Schedule {
  /** First due time strictly after afterMs (epoch ms, integer), or null when the timetable is exhausted. Pure and synchronous. */
  next(afterMs: number): number | null
  /** Stable diagnostic name; becomes go_like.job.system of schedule runs ("interval", "croner"). */
  string(): string
}
```

#### `Tick`

接口 · 新增

一次调度运行的描述：作业名、对应的到期时刻与是否手动触发。

```ts
export interface Tick {
  /** The code-defined job name given to newScheduleServer (go_like.job.name). */
  readonly name: string
  /** The due time this run serves (epoch ms); for trigger(ctx), the time of the call. */
  readonly scheduledAt: number
  /** True when the run came from trigger(ctx). */
  readonly manual: boolean
}
```

#### `TickHandler`

类型 · 新增

每次到期运行一次的处理函数；抛出表示本次运行失败，但调度会继续。

```ts
export type TickHandler = (ctx: Context, tick: Tick) => void | Promise<void>
```

#### `ScheduleServerOptions`

接口 · 新增

`newScheduleServer` 的选项。

```ts
export interface ScheduleServerOptions {
  /** Graceful wait for the active run at stop before its ctx is canceled; integer 0..2147483647; default 25000. */
  readonly drainTimeoutMs?: number
}
```

#### `ScheduleServer`

接口 · 改名 · 替代 `@go-like/croner#CronerServer`

在一个 `Schedule` 上运行一个处理函数的一次性 `Server`，运行永不与自身重叠。

```ts
export interface ScheduleServer extends Server {
  /** Runs the handler once now, after any active run settles; settles with that run's outcome. */
  trigger(ctx: Context): Promise<void>
}
```

#### `JobBackoff`

接口 · 新增

重试退避，按行为描述：第 k 次尝试（k >= 2）之前的延迟，fixed 为 delayMs，exponential 为 delayMs * 2^(k-2)。

```ts
export interface JobBackoff {
  readonly type: "fixed" | "exponential"
  readonly delayMs: number
}
```

#### `EnqueueOptions`

接口 · 新增

入队选项；重试策略随每个作业一起保存。

```ts
export interface EnqueueOptions {
  /** Idempotency key: an enqueue whose id matches an unfinished job of this queue creates no second job. */
  readonly id?: string
  /** Total attempts including the first; positive safe integer; default 1 (no retry). */
  readonly attempts?: number
  /** Delay between attempts; default { type: "fixed", delayMs: 0 }. */
  readonly backoff?: JobBackoff
}
```

#### `EnqueuedJob`

接口 · 新增

入队结果。

```ts
export interface EnqueuedJob {
  /** The caller's id when given (also for a deduplicated enqueue), else the provider-assigned id. */
  readonly id: string
}
```

#### `Job`

接口 · 新增

一个排队作业的一次运行。

```ts
export interface Job<T> {
  readonly queue: string
  readonly name: string
  readonly id: string
  /** 1-based attempt number of this run. */
  readonly attempt: number
  /** The payload after the provider's JSON round trip. */
  readonly payload: T
}
```

#### `JobHandler`

类型 · 新增

作业处理函数：返回表示本次尝试成功（保存结果的提供者会保留返回值），抛出表示失败；抛出 `newPermanentJobError(cause)` 的结果表示不再重试。

```ts
export type JobHandler<T> = (ctx: Context, job: Job<T>) => unknown
```

#### `JobHandlers`

类型 · 新增

按代码中定义的作业名索引的处理函数表；名称没有处理函数的作业不重试直接失败。

```ts
export type JobHandlers<T> = Readonly<Record<string, JobHandler<T>>>
```

#### `JobWorkerOptions`

接口 · 新增

`JobQueue.worker` 的选项。

```ts
export interface JobWorkerOptions {
  /** Maximum concurrent runs of this worker; positive safe integer; default 1. */
  readonly concurrency?: number
  /** Graceful wait for active runs at stop before their ctx is canceled; default 25000. */
  readonly drainTimeoutMs?: number
}
```

#### `JobQueue`　[插座]

接口 · 新增

具名工作队列：生产者（`enqueue`）加 worker 工厂；至少一次投递，重试策略随每个作业走。由 `@go-like/bullmq` 等插件实现；持有连接的提供者另外实现内核 `Server` 形状，并通过 `resources(...)` 注册。

```ts
export interface JobQueue<T> {
  /** Code-defined queue name (go_like.job.queue). */
  readonly name: string
  /** Enqueues one job; validates before I/O and deduplicates by id while an unfinished job holds it. */
  enqueue(ctx: Context, name: string, payload: T, options?: EnqueueOptions): Promise<EnqueuedJob>
  /** A one-shot Server that runs handlers for this queue's jobs while it runs. */
  worker(handlers: JobHandlers<T>, options?: JobWorkerOptions): Server
  /** Stable provider diagnostic name; becomes go_like.job.system ("memory", "bullmq"). */
  string(): string
}
```

#### `JobRunnerState`

类型 · 新增

作业运行器（调度 Server、队列、worker）的状态。

```ts
export type JobRunnerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"
```

#### `JobStateError`

接口 · 改名 · 替代 `@go-like/bullmq#BullMqAlreadyStartedError`

当前状态不允许的操作：二次 start、已停止队列上的入队、start 之前的 trigger。

```ts
export interface JobStateError extends Error {
  readonly name: "JobStateError"
  readonly code: "GO_LIKE_JOB_STATE"
  readonly operation: string
  readonly state: JobRunnerState
}
```

#### `JobDrainTimeoutError`

接口 · 改名 · 替代 `@go-like/bullmq#BullMqWorkerShutdownTimeoutError`

stop 时的所有者等待超过 drainTimeoutMs：活动运行已通过各自 ctx 被取消，仍会被等待到真正 settle。

```ts
export interface JobDrainTimeoutError extends Error {
  readonly name: "JobDrainTimeoutError"
  readonly code: "GO_LIKE_JOB_DRAIN_TIMEOUT"
  /** Queue name or schedule job name. */
  readonly runner: string
  readonly timeoutMs: number
}
```

#### `JobUnknownNameError`

接口 · 新增

投递来的作业名在 worker 的处理函数表中不存在：该作业不重试直接失败。

```ts
export interface JobUnknownNameError extends Error {
  readonly name: "JobUnknownNameError"
  readonly code: "GO_LIKE_JOB_UNKNOWN_NAME"
  readonly queue: string
  readonly jobName: string
}
```

#### `JobPermanentError`

接口 · 新增

处理函数声明的永久失败：作业失败且不再重试，尽管还有剩余尝试次数。

```ts
export interface JobPermanentError extends Error {
  readonly name: "JobPermanentError"
  readonly code: "GO_LIKE_JOB_PERMANENT"
  readonly cause: unknown
}
```

### `@go-like/core/job/provider`

角色：插头 SDK；lane：P；12 个导出。

作业插件作者 SDK：遥测 kit（`runJob`、`enqueue`、`dispatchJob`）、入队/worker 选项与处理函数表的校验解析器、作业错误工厂。由核心 `newScheduleServer`、内部内存队列与 `@go-like/bullmq` 调用；每个一方队列插件必须调用 kit，并把 `jobQueueConformance` 与 `jobTelemetryConformance` 作为必跑 CI 任务。

#### `runJob`

函数 · 新增

遥测 kit：在每次运行独立的 `withCancel(runnerCtx)` 中、`job.run` 单元内执行一个作业体，失败原样重抛。

```ts
export declare function runJob<T>(
  runnerCtx: Context,
  info: JobRunInfo,
  body: (ctx: Context) => Promise<T>
): Promise<T>
```

#### `enqueue`

函数 · 新增

遥测 kit：`send` 在 `job.enqueue` 单元内运行，`metadata` 是带 traceparent/tracestate 的冻结传播载体，需随作业保存。

```ts
export declare function enqueue<Result>(
  ctx: Context,
  info: JobEnqueueInfo,
  send: (ctx: Context, metadata: Readonly<Record<string, string>>) => Promise<Result>
): Promise<Result>
```

#### `enqueueOptions`

函数 · 新增

I/O 之前校验并冻结入队选项（TypeError / RangeError），默认 attempts 为 1、退避为 fixed 0。

```ts
export declare function enqueueOptions(options?: EnqueueOptions): ResolvedEnqueueOptions
```

#### `jobWorkerOptions`

函数 · 新增

I/O 之前校验并冻结 worker 选项（RangeError），默认 concurrency 为 1、drainTimeoutMs 为 25000。

```ts
export declare function jobWorkerOptions(options?: JobWorkerOptions): ResolvedJobWorkerOptions
```

#### `jobHandlers`

函数 · 新增

校验并快照处理函数表：至少一项自有条目、名称非空合法且不超过 256 UTF-8 字节、值为函数；只按自有属性查找。

```ts
export declare function jobHandlers<T>(handlers: JobHandlers<T>): JobHandlers<T>
```

#### `dispatchJob`

函数 · 新增

运行一个已投递的作业：用 `handlers[job.name]` 经 `runJob`（trigger 为 "queue"）执行；名称未知时作为 "_OTHER" 单元运行并以`JobUnknownNameError` reject；处理函数失败原样重抛。

```ts
export declare function dispatchJob<T>(
  runnerCtx: Context,
  system: string,
  handlers: JobHandlers<T>,
  job: Job<T>,
  metadata: Readonly<Record<string, string>> | null
): Promise<unknown>
```

#### `newJobStateError`

函数 · 新增

创建 `JobStateError`，错误码为 GO_LIKE_JOB_STATE。

```ts
export declare function newJobStateError(operation: string, state: JobRunnerState): JobStateError
```

#### `newJobDrainTimeoutError`

函数 · 新增

创建 `JobDrainTimeoutError`，错误码为 GO_LIKE_JOB_DRAIN_TIMEOUT。

```ts
export declare function newJobDrainTimeoutError(
  runner: string,
  timeoutMs: number
): JobDrainTimeoutError
```

#### `JobRunInfo`

接口 · 新增

`runJob` 的运行描述：系统名、作业名、触发方式、作业 id、尝试序号与存储的传播载体。

```ts
export interface JobRunInfo {
  readonly system: string
  readonly name: string
  readonly trigger: "schedule" | "queue"
  readonly id: string | null
  readonly attempt: number
  readonly metadata: Readonly<Record<string, string>> | null
}
```

#### `JobEnqueueInfo`

接口 · 新增

`enqueue` kit 的入队描述：系统名、作业名与队列名。

```ts
export interface JobEnqueueInfo {
  readonly system: string
  readonly name: string
  readonly queue: string
}
```

#### `ResolvedEnqueueOptions`

接口 · 新增

解析并补全默认值后的入队选项。

```ts
export interface ResolvedEnqueueOptions {
  readonly id: string | null
  readonly attempts: number
  readonly backoff: JobBackoff
}
```

#### `ResolvedJobWorkerOptions`

接口 · 新增

解析并补全默认值后的 worker 选项。

```ts
export interface ResolvedJobWorkerOptions {
  readonly concurrency: number
  readonly drainTimeoutMs: number
}
```

## `@go-like/otel`

### `@go-like/otel`

角色：插头；15 个导出。

OpenTelemetry 插件（单一根入口，可移植通道 P）：把应用自建的 OTel SDK provider 适配成 core 的 trace、metric、log 与 propagation 插槽，并让每个适配器自带 `lifecycle`。本入口只依赖 `@opentelemetry/api`（peer）；由 `newTelemetry(...)` 收纳适配器并在 App 的遥测层启动与停止，应用自行注册 AsyncLocalStorage 上下文管理器。实现者是本插件，消费者是应用的装配代码（`telemetry(tel)`）和 `@go-like/core/testing` 的一致性套件。

#### `newOtelTracerProvider`

函数 · 改名 · 替代 `@go-like/otel#newOtelServer` · 实现 `@go-like/core/trace#TracerProvider`、`@go-like/core/trace#Span`、`@go-like/core/telemetry#TelemetryLifecycle`

适配应用自建的 SDK TracerProvider。校验 `getTracer`/`shutdown`（TypeError）与 `shutdownTimeoutMs`（RangeError）；`startSpan` 遵守 `root`、`links`、`kind`，`enter` 即 `context.with(...)`，使 `context.active()` 在 go-like 单元内正确。

```ts
export declare function newOtelTracerProvider(
  provider: ApiTracerProvider & Shutdownable,
  options?: OtelTracingOptions
): OtelTracerProvider
```

#### `newOtelMeterProvider`

函数 · 改名 · 替代 `@go-like/otel#newOtelServer` · 实现 `@go-like/core/metric#MeterProvider`、`@go-like/core/metric#Instrument`、`@go-like/core/telemetry#TelemetryLifecycle`

适配应用自建的 SDK MeterProvider：每个 descriptor 对应一个原生 instrument，仅当 ctx 的 span 由本插件创建时才附带 exemplar 上下文。

```ts
export declare function newOtelMeterProvider(
  provider: ApiMeterProvider & Shutdownable,
  options?: OtelMetricsOptions
): OtelMeterProvider
```

#### `newOtelLogHandler`

函数 · 新增 · 实现 `@go-like/core/log#LogHandler`、`@go-like/core/telemetry#TelemetryLifecycle`

适配应用自建的 SDK LoggerProvider（`@opentelemetry/api` 的 Logs API）：`enabled` 调 `logger.enabled`，`handle` 调 `logger.emit`。

```ts
export declare function newOtelLogHandler(
  provider: ApiLoggerProvider & Shutdownable,
  options?: OtelLogsOptions
): OtelLogHandler
```

#### `newOtelPropagator`

函数 · 新增 · 实现 `@go-like/core/trace#Propagator`

把任意 OTel `TextMapPropagator`（W3C 加 baggage 组合、B3、Jaeger）适配成 core `Propagator`。`extract` 在载体没有有效 span context 时原样返回 ctx；仅含 baggage 的载体不会进入隐式上下文。

```ts
export declare function newOtelPropagator(propagator: TextMapPropagator): Propagator
```

#### `defaultOtelShutdownTimeoutMs`

常量 · 语义变化 · 替代 `@go-like/otel#defaultOtelShutdownTimeoutMs` · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

单个 provider `shutdown()` 的默认属主等待时长（毫秒）。超时只让属主等待失败，原生关闭继续进行。

```ts
export declare const defaultOtelShutdownTimeoutMs: 25000
```

#### `Shutdownable`

接口 · 新增 · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

适配器需要的唯一原生生命周期成员：SDK 的各类 provider 都有 `shutdown()`，`@opentelemetry/api` 的接口没有。

```ts
export interface Shutdownable {
  shutdown(): Promise<void>
}
```

#### `OtelTracingOptions`

接口 · 改名 · 替代 `@go-like/otel#otelShutdownTimeout` · 实现 `@go-like/core/trace#TracerProvider`

`newOtelTracerProvider` 的选项；取代旧的 `otelShutdownTimeout` 选项函数。

```ts
export interface OtelTracingOptions {
  /**
   * 整数 0..2147483647 毫秒，否则抛 RangeError；默认 25000。保持旧语义：`shutdown()` 开始后立即检查截止时间，
   * 因此 0 表示立刻让属主等待失败，原生关闭仍继续进行。
   */
  readonly shutdownTimeoutMs?: number
  /** ctx 没有 go-like span 且该单元不是 root 时，是否挂到 `context.active()` 之下。默认 false。 */
  readonly implicitParent?: boolean
  /** 为 true 时，构造期若 `context.with` 未被遵守（没有注册上下文管理器）就抛 `OtelContextManagerMissingError`；默认 false（start 时只写一条 WARN）。 */
  readonly requireContextManager?: boolean
}
```

#### `OtelMetricsOptions`

接口 · 改名 · 替代 `@go-like/otel#otelShutdownTimeout` · 实现 `@go-like/core/metric#MeterProvider`

`newOtelMeterProvider` 的选项（内联选项对象的具名形式）。

```ts
export interface OtelMetricsOptions {
  /** 整数 0..2147483647 毫秒，默认 25000，语义同 `OtelTracingOptions.shutdownTimeoutMs`。 */
  readonly shutdownTimeoutMs?: number
}
```

#### `OtelLogsOptions`

接口 · 改名 · 替代 `@go-like/otel#otelShutdownTimeout` · 实现 `@go-like/core/log#LogHandler`

`newOtelLogHandler` 的选项（内联选项对象的具名形式）。

```ts
export interface OtelLogsOptions {
  /** OTel Logger 的 instrumentation scope，默认 `{ name: "go-like" }`。 */
  readonly scope?: Scope
  /** 整数 0..2147483647 毫秒，默认 25000，语义同 `OtelTracingOptions.shutdownTimeoutMs`。 */
  readonly shutdownTimeoutMs?: number
}
```

#### `OtelTracerProvider`

接口 · 新增 · 实现 `@go-like/core/trace#TracerProvider`、`@go-like/core/trace#Span`、`@go-like/core/telemetry#TelemetryLifecycle`

带 `enter` 桥的 core `TracerProvider`；它的 `lifecycle` 在遥测层接纳后拥有应用自建的那个 SDK TracerProvider。

```ts
export interface OtelTracerProvider extends TracerProvider {
  readonly lifecycle: TelemetryLifecycle
}
```

#### `OtelMeterProvider`

接口 · 新增 · 实现 `@go-like/core/metric#MeterProvider`、`@go-like/core/metric#Instrument`、`@go-like/core/telemetry#TelemetryLifecycle`

core `MeterProvider`；它的 `lifecycle` 在遥测层接纳后拥有应用自建的那个 SDK MeterProvider。

```ts
export interface OtelMeterProvider extends MeterProvider {
  readonly lifecycle: TelemetryLifecycle
}
```

#### `OtelLogHandler`

接口 · 新增 · 实现 `@go-like/core/log#LogHandler`、`@go-like/core/telemetry#TelemetryLifecycle`

core `LogHandler`（没有 `withAttrs`，绑定属性由 core 合并）；它的 `lifecycle` 在遥测层接纳后拥有应用自建的那个 SDK LoggerProvider。

```ts
export interface OtelLogHandler extends LogHandler {
  readonly lifecycle: TelemetryLifecycle
}
```

#### `OtelAlreadyStartedError`

接口 · 原位保留 · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

provider 已经启动（或已进入终态）后再次 start 时的错误。

```ts
export interface OtelAlreadyStartedError extends Error {
  readonly name: "OtelAlreadyStartedError"
  readonly code: "GO_LIKE_OTEL_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}
```

#### `OtelShutdownTimeoutError`

接口 · 原位保留 · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

`shutdown()` 超过 `shutdownTimeoutMs` 时属主等待的失败；`start` 返回的 Promise 仍等待原生终态。

```ts
export interface OtelShutdownTimeoutError extends Error {
  readonly name: "OtelShutdownTimeoutError"
  readonly code: "GO_LIKE_OTEL_SHUTDOWN_TIMEOUT"
  readonly timeoutMs: number
}
```

#### `OtelContextManagerMissingError`

接口 · 新增 · 实现 `@go-like/core/trace#TracerProvider`

`requireContextManager: true` 且构造期探测发现没有注册 OTel ContextManager 时抛出。

```ts
export interface OtelContextManagerMissingError extends Error {
  readonly name: "OtelContextManagerMissingError"
  readonly code: "GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING"
}
```

## `@go-like/pino`

### `@go-like/pino/log`

角色：插头；7 个导出。

pino 插件的 `log` 入口（Node 与 Bun 通道）：把应用自建的 pino Logger 适配成 core 的 `LogHandler`，并让 handler 的 `lifecycle` 拥有移交过来的 destination。`pino` 是 peer 依赖，因为生命周期要校验 `logger[streamSym] === destination`，两份 pino 会让接纳失败。实现者是本插件，消费者是应用装配代码（`newTelemetry({ log: [handler] })`）和 `logHandlerConformance`。

#### `newPinoHandler`

函数 · 改名 · 替代 `@go-like/pino#newPinoServer` · 实现 `@go-like/core/log#LogHandler`、`@go-like/core/telemetry#TelemetryLifecycle`

校验 `logger.isLevelEnabled/child/flush` 以及 `logger[streamSym] === destination`（任何 I/O 之前抛 TypeError）后，返回一个 `PinoHandler`。`enabled` 即 `isLevelEnabled(level)`；`handle` 写出 attrs（异常映射到 `err`）、`logCorrelation(ctx)` 与 `event.name`，原生失败被吞掉。

```ts
export declare function newPinoHandler(
  logger: Logger,
  destination: OfficialPinoDestination,
  ...options: readonly PinoHandlerOption[]
): PinoHandler
```

#### `pinoDrainTimeout`

函数 · 迁移 · 替代 `@go-like/pino#pinoDrainTimeout` · 实现 `@go-like/core/log#LogHandler`

destination 排空的属主等待时长选项，整数 0..2147483647 毫秒，否则抛 RangeError；默认 25000。超时失败为 `PinoDrainTimeoutError`。

```ts
export declare function pinoDrainTimeout(timeoutMs: number): PinoHandlerOption
```

#### `PinoHandlerOption`

类型 · 改名 · 替代 `@go-like/pino#PinoServerOption` · 实现 `@go-like/core/log#LogHandler`

`newPinoHandler` 的函数式选项，由 `pinoDrainTimeout` 产生。

```ts
export type PinoHandlerOption = (config: PinoHandlerConfig) => void
```

#### `PinoHandler`

接口 · 改名 · 替代 `@go-like/pino#PinoServer` · 实现 `@go-like/core/log#LogHandler`、`@go-like/core/telemetry#TelemetryLifecycle`

带 `withAttrs`（pino child logger）的 core `LogHandler`；它的 `lifecycle` 拥有移交的 destination：接纳时把根 logger 绑定为带 `service.*` 的 child，停止时 flush、end 并等待 close。

```ts
export interface PinoHandler extends LogHandler {
  readonly lifecycle: TelemetryLifecycle
}
```

#### `PinoAlreadyStartedError`

接口 · 迁移 · 替代 `@go-like/pino#PinoAlreadyStartedError` · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

handler 已经启动（或已进入终态）后再次 start 时的错误。

```ts
export interface PinoAlreadyStartedError extends Error {
  readonly name: "PinoAlreadyStartedError"
  readonly code: "GO_LIKE_PINO_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}
```

#### `PinoDrainTimeoutError`

接口 · 迁移 · 替代 `@go-like/pino#PinoDrainTimeoutError` · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

destination 在排空时限内没有关闭；`forceSupported` 表示该 destination 是否有强制销毁原语（仅文件 destination 会 `destroy()`）。

```ts
export interface PinoDrainTimeoutError extends Error {
  readonly name: "PinoDrainTimeoutError"
  readonly code: "GO_LIKE_PINO_DRAIN_TIMEOUT"
  readonly timeoutMs: number
  readonly forceSupported: boolean
}
```

#### `PinoDestinationClosedError`

接口 · 迁移 · 替代 `@go-like/pino#PinoDestinationClosedError` · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

destination 在运行期间意外 `error` 或 `close`；App 把它当作遥测服务失败处理。

```ts
export interface PinoDestinationClosedError extends Error {
  readonly name: "PinoDestinationClosedError"
  readonly code: "GO_LIKE_PINO_DESTINATION_CLOSED"
}
```

## `@go-like/winston`

### `@go-like/winston/log`

角色：插头；5 个导出。

winston 插件的 `log` 入口（Node 与 Bun 通道）：把应用自建的 winston Logger 适配成 core 的 `LogHandler`，并让 handler 的 `lifecycle` 结束这个借来的 logger。`winston` 是可选 peer：运行时只做类型导入，Logger 由应用构造并传入。实现者是本插件，消费者是应用装配代码（`newTelemetry({ log: [handler] })`）和 `logHandlerConformance`。

#### `newWinstonHandler`

函数 · 改名 · 替代 `@go-like/winston#newWinstonServer` · 实现 `@go-like/core/log#LogHandler`、`@go-like/core/telemetry#TelemetryLifecycle`

校验 `logger.log/child/end/once/isLevelEnabled` 后返回 `WinstonHandler`，构造时不安装任何监听。`enabled` 即 `isLevelEnabled(level)`；`handle` 调 `logger.log`（异常映射到 `error`，附带 `logCorrelation(ctx)` 与 `event.name`）；`withAttrs` 即 `logger.child(...)`。

```ts
export declare function newWinstonHandler(logger: Logger): WinstonHandler
```

#### `WinstonHandler`

接口 · 改名 · 替代 `@go-like/winston#WinstonServer` · 实现 `@go-like/core/log#LogHandler`、`@go-like/core/telemetry#TelemetryLifecycle`

带 `withAttrs`（winston child logger）的 core `LogHandler`；它的 `lifecycle` 在接纳时把根 logger 绑定为带 `service.*` 的 child，停止时 `logger.end()` 并等待 `finish`。

```ts
export interface WinstonHandler extends LogHandler {
  readonly lifecycle: TelemetryLifecycle
}
```

#### `WinstonAlreadyStartedError`

接口 · 迁移 · 替代 `@go-like/winston#WinstonAlreadyStartedError` · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

handler 已经启动（或已进入终态）后再次 start 时的错误。

```ts
export interface WinstonAlreadyStartedError extends Error {
  readonly name: "WinstonAlreadyStartedError"
  readonly code: "GO_LIKE_WINSTON_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}
```

#### `WinstonLoggerFinishedError`

接口 · 迁移 · 替代 `@go-like/winston#WinstonLoggerFinishedError` · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

接纳时 logger 已经 `finish`（可写端已结束）。

```ts
export interface WinstonLoggerFinishedError extends Error {
  readonly name: "WinstonLoggerFinishedError"
  readonly code: "GO_LIKE_WINSTON_LOGGER_FINISHED"
}
```

#### `WinstonLoggerClosedError`

接口 · 迁移 · 替代 `@go-like/winston#WinstonLoggerClosedError` · 实现 `@go-like/core/telemetry#TelemetryLifecycle`

接纳时 logger 已经 `close`。

```ts
export interface WinstonLoggerClosedError extends Error {
  readonly name: "WinstonLoggerClosedError"
  readonly code: "GO_LIKE_WINSTON_LOGGER_CLOSED"
}
```

## `@go-like/prometheus`

### `@go-like/prometheus/metric`

角色：插头；4 个导出。

Prometheus 插件的 `metric` 入口（Node 与 Bun 通道）：把应用自建的 prom-client Registry 适配成 core 的 `MeterProvider`，并附带该 registry 的抓取 `Handler`。抓取 `Handler` 是文档化的例外（D39）：它只服务这个 meter provider 的 registry，单独拆 `./web` 入口只为一个函数不值得。实现者是本插件，消费者是应用装配代码（`newTelemetry({ meters: [...] })` 与挂到 core web host 的 `/metrics` 路由）和 `meterProviderConformance`。

#### `newPrometheusMeterProvider`

函数 · 改名 · 替代 `@go-like/prometheus#newRequestMetrics` · 实现 `@go-like/core/metric#MeterProvider`、`@go-like/core/metric#Instrument`、`@go-like/core/telemetry#TelemetryLifecycle`

校验 registry（TypeError）后返回 `PrometheusMeterProvider`，从不触碰全局 registry。descriptor 映射为 `Counter`（加 `_total`）、`Gauge`（up-down 计数器与 gauge）或 `Histogram`；非 `[a-zA-Z0-9_]` 字符变为 `_`，并追加单位后缀；同名不同类型会抛错，由 core 转为 no-op 加 `go_like.telemetry.instrument_failed`。

```ts
export declare function newPrometheusMeterProvider(
  registry: Registry<RegistryContentType>
): PrometheusMeterProvider
```

#### `createPrometheusHandler`

函数 · 迁移 · 替代 `@go-like/prometheus#createPrometheusHandler` · 实现 `@go-like/core/web#Handler`

抓取端点：GET/HEAD 返回 registry 的文本暴露格式，`Cache-Control: no-store`，404/405/500 为纯文本。应挂在 `server(...)` 登记的 core web host 上，因此在服务层先于遥测层停止；用 `ignoreRequest` 把抓取排除在请求遥测之外。

```ts
export declare function createPrometheusHandler(
  registry: Registry<RegistryContentType>,
  options?: PrometheusHandlerOptions
): Handler
```

#### `PrometheusMeterProvider`

接口 · 新增 · 实现 `@go-like/core/metric#MeterProvider`、`@go-like/core/metric#Instrument`、`@go-like/core/telemetry#TelemetryLifecycle`

基于应用自有 prom-client Registry 的 core `MeterProvider`；非常驻生命周期：`start` 只登记一次 `target_info` 并立即返回，`stop` 立即返回。

```ts
export interface PrometheusMeterProvider extends MeterProvider {
  readonly lifecycle: TelemetryLifecycle
}
```

#### `PrometheusHandlerOptions`

接口 · 迁移 · 替代 `@go-like/prometheus#PrometheusHandlerOptions` · 实现 `@go-like/core/web#Handler`

`createPrometheusHandler` 的选项。

```ts
export interface PrometheusHandlerOptions {
  /** 抓取路径，默认 "/metrics"。 */
  readonly path?: string
}
```

## `@go-like/consul`

### `@go-like/consul`

角色：插头；7 个导出。

Consul 的共享 HTTP 协议客户端与统一错误族：一个 ConsulClient 同时供 ./registry、./config、./store 使用，自己不填充任何核心 socket。由应用构造一次并传给各 socket 构造器；底层消费核心 @go-like/core/fetch 的 Fetch。

#### `newConsulClient`

函数 · 新增

创建共享 Consul 客户端；地址、令牌或作用域非法时在任何 I/O 之前抛出 TypeError。

```ts
export declare function newConsulClient(options: ConsulClientOptions): ConsulClient
```

#### `ConsulClientOptions`

接口 · 新增

newConsulClient 的连接选项（原先分散在 registry、config、store 三份选项里）。

```ts
export interface ConsulClientOptions {
  readonly fetch: Fetch
  /** HTTP(S) origin of the Consul agent, for example "http://127.0.0.1:8500". */
  readonly address: string
  /** ACL token, sent as X-Consul-Token. */
  readonly token?: string
  /** dc query parameter on catalog, health and KV endpoints (never on agent endpoints). */
  readonly datacenter?: string
  /** ns query parameter (Consul Enterprise). */
  readonly namespace?: string
}
```

#### `ConsulClient`

接口 · 新增

不透明、不可变、无状态（没有生命周期）的 Consul 客户端句柄：在 registry、config 与 store 之间共享同一个。

```ts
export interface ConsulClient {
  readonly [consulClientBrand]: true
}
```

#### `ConsulOperation`

类型 · 语义变化 · 替代 `@go-like/registry-consul#ConsulOperation`、`@go-like/store-consul#ConsulStoreOperation`

Consul 错误中的操作名，按 socket 子路径加前缀，使同一个错误码不再对应两种形状。

```ts
export type ConsulOperation =
  | "registry.register"
  | "registry.heartbeat"
  | "registry.deregister"
  | "registry.readback"
  | "registry.get"
  | "registry.watch"
  | "config.load"
  | "config.watch"
  | "store.read"
  | "store.write"
  | "store.delete"
  | "store.list"
  | "store.session-create"
  | "store.session-readback"
  | "store.session-destroy"
```

#### `ConsulHttpError`

接口 · 语义变化 · 替代 `@go-like/registry-consul#ConsulHttpError`、`@go-like/config-consul#ConsulHttpError`、`@go-like/store-consul#ConsulStoreHttpError`

Consul 返回了不被允许的非 2xx 状态；registry、config、store 共用这一种形状。

```ts
export interface ConsulHttpError extends Error {
  readonly name: "ConsulHttpError"
  readonly code: "GO_LIKE_CONSUL_HTTP"
  readonly operation: ConsulOperation
  readonly status: number
}
```

#### `ConsulTransportError`

接口 · 语义变化 · 替代 `@go-like/registry-consul#ConsulTransportError`、`@go-like/store-consul#ConsulStoreTransportError`

与 Consul 的请求或响应体读取在 ctx 仍有效时失败；cause 为原始错误（携带令牌时为固定的保密错误）。

```ts
export interface ConsulTransportError extends Error {
  readonly name: "ConsulTransportError"
  readonly code: "GO_LIKE_CONSUL_TRANSPORT"
  readonly operation: ConsulOperation
  readonly cause: Error
}
```

#### `ConsulProtocolError`

接口 · 改名 · 替代 `@go-like/store-consul#ConsulStoreProtocolError`

Consul 响应畸形或违反协议。

```ts
export interface ConsulProtocolError extends Error {
  readonly name: "ConsulProtocolError"
  readonly code: "GO_LIKE_CONSUL_PROTOCOL"
  readonly operation: ConsulOperation
}
```

### `@go-like/consul/registry`

角色：插头；3 个导出。

基于 Consul agent 的 Registry：TTL 检查加心跳续约，通过健康阻塞查询发现与监视服务。填充核心 @go-like/core/registry 的 Registry 与 Watcher socket；由应用构造并传给 App 的 registrar(...) 选项与客户端的发现。

#### `newConsulRegistry`

函数 · 语义变化 · 替代 `@go-like/registry-consul#newConsulRegistry` · 实现 `@go-like/core/registry#Registry`、`@go-like/core/registry#Watcher`

在共享 Consul 客户端之上创建 Registry。

```ts
export declare function newConsulRegistry(
  client: ConsulClient,
  options?: ConsulRegistryOptions
): ConsulRegistry
```

#### `ConsulRegistryOptions`

接口 · 语义变化 · 替代 `@go-like/registry-consul#ConsulRegistryOptions`

newConsulRegistry 的选项；连接字段已移到 ConsulClientOptions。

```ts
export interface ConsulRegistryOptions {
  /** Blocking-query wait, integer 1..600000, default 300000. */
  readonly waitMs?: number
  /** Minimum time between two health queries of one watcher, 1..60000, default 1000. */
  readonly minimumQueryIntervalMs?: number
  /** Watch and heartbeat retry delays: initial 1..60000 (default 250), maximum initial..600000 (default 30000). */
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** DeregisterCriticalServiceAfter of the TTL check, 60000..86400000, default 60000. */
  readonly deregisterCriticalServiceAfterMs?: number
  /** Watcher queue bound 1..4096, default 128. */
  readonly watchBufferSize?: number
  /** TTL check, 2000..86400000, default 120000; heartbeat every ttlMs / 2. */
  readonly ttlMs?: number
  /** Non-blocking request bound, default 5000. */
  readonly timeoutMs?: number
  readonly onRegistrationError?: RegistrationErrorHandler | null
}
```

#### `ConsulRegistry`

接口 · 迁移 · 替代 `@go-like/registry-consul#ConsulRegistry` · 实现 `@go-like/core/registry#Registry`

Consul 注册中心：同一个对象既是 Registrar 也是 Discovery。

```ts
export interface ConsulRegistry extends Registry {}
```

### `@go-like/consul/config`

角色：插头；3 个导出。

基于一个 Consul KV 键的 ConfigSource，使用阻塞查询监视变化。填充核心 @go-like/core/config 的 ConfigSource 与 ConfigSourceWatcher socket；由应用传给 newConfig 的 source(...) 选项。

#### `consulSource`

函数 · 语义变化 · 替代 `@go-like/config-consul#consulSource` · 实现 `@go-like/core/config#ConfigSource`、`@go-like/core/config#ConfigSourceWatcher`

在共享 Consul 客户端之上创建一个键的 ConfigSource；键不存在时默认以 ConfigSourceMissingError 拒绝。

```ts
export declare function consulSource(
  client: ConsulClient,
  options: ConsulSourceOptions
): ConfigSource
```

#### `ConsulConsistency`

类型 · 迁移 · 替代 `@go-like/config-consul#ConsulConsistency`

Consul KV 读取的一致性模式。

```ts
export type ConsulConsistency = "default" | "consistent" | "stale"
```

#### `ConsulSourceOptions`

接口 · 语义变化 · 替代 `@go-like/config-consul#ConsulSourceOptions`

consulSource 的选项；连接字段已移到 ConsulClientOptions，新增 optional。

```ts
export interface ConsulSourceOptions {
  /** Exact KV key; "." and ".." segments are rejected. */
  readonly key: string
  /** Source name, default "consul". */
  readonly name?: string
  readonly consistency?: ConsulConsistency
  /** Blocking-query wait 1..600000, default 300000. */
  readonly waitMs?: number
  /** Minimum time between two KV queries 1..60000, default 1000. */
  readonly minimumQueryIntervalMs?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** Default jsonDecoder. */
  readonly decode?: ConfigDecoder
  /** NEW. When true an absent key loads as {}; default false: load rejects with ConfigSourceMissingError. */
  readonly optional?: boolean
}
```

### `@go-like/consul/store`

角色：插头；6 个导出。

基于 Consul KV 的 Store：用 CAS 实现条件写，用会话实现 TTL。填充核心 @go-like/core/store 的 Store socket（ADR 0006）；由应用构造并作为 Store 传给消费它的服务代码。

#### `newConsulStore`

函数 · 语义变化 · 替代 `@go-like/store-consul#newConsulStore` · 实现 `@go-like/core/store#Store`

在共享 Consul 客户端之上创建 Store。

```ts
export declare function newConsulStore(
  client: ConsulClient,
  options?: ConsulStoreOptions
): ConsulStore
```

#### `ConsulStoreOptions`

接口 · 语义变化 · 替代 `@go-like/store-consul#ConsulStoreOptions`

newConsulStore 的选项；连接字段已移到 ConsulClientOptions，只保留 root。

```ts
export interface ConsulStoreOptions {
  /** Key root that isolates the store, default "go-like/store". */
  readonly root?: string
}
```

#### `ConsulStoreUnsupportedCombination`

类型 · 迁移 · 替代 `@go-like/store-consul#ConsulStoreUnsupportedCombination`

Consul 不支持的 TTL 与 CAS 组合。

```ts
export type ConsulStoreUnsupportedCombination = "ttl-cas" | "cas-existing-ttl"
```

#### `ConsulStoreUncertainError`

接口 · 迁移 · 替代 `@go-like/store-consul#ConsulStoreUncertainError`

写入、删除或会话操作的结果不确定（请求可能已生效）。

```ts
export interface ConsulStoreUncertainError extends Error {
  readonly name: "ConsulStoreUncertainError"
  readonly code: "GO_LIKE_CONSUL_STORE_UNCERTAIN"
  readonly operation: "write" | "delete" | "session-create" | "session-destroy"
  readonly cause: Error
}
```

#### `ConsulStoreUnsupportedCombinationError`

接口 · 迁移 · 替代 `@go-like/store-consul#ConsulStoreUnsupportedCombinationError`

请求了 Consul 不支持的 TTL 与 CAS 组合。

```ts
export interface ConsulStoreUnsupportedCombinationError extends Error {
  readonly name: "ConsulStoreUnsupportedCombinationError"
  readonly code: "GO_LIKE_CONSUL_STORE_UNSUPPORTED_COMBINATION"
  readonly combination: ConsulStoreUnsupportedCombination
}
```

#### `ConsulStore`

接口 · 迁移 · 替代 `@go-like/store-consul#ConsulStore` · 实现 `@go-like/core/store#Store`

Consul Store 类型。

```ts
export interface ConsulStore extends Store {}
```

## `@go-like/etcd`

### `@go-like/etcd`

角色：插头；7 个导出。

etcd v3 JSON 网关的共享协议客户端与统一错误族：一个 EtcdClient 同时供 ./registry、./config、./store 使用，自己不填充任何核心 socket。由应用构造一次并传给各 socket 构造器；底层消费核心 @go-like/core/fetch 的 Fetch。

#### `newEtcdClient`

函数 · 新增

创建共享 etcd 客户端；地址或令牌非法时在任何 I/O 之前抛出 TypeError。

```ts
export declare function newEtcdClient(options: EtcdClientOptions): EtcdClient
```

#### `EtcdClientOptions`

接口 · 新增

newEtcdClient 的连接选项（原先分散在 registry、config、store 三份选项里）。

```ts
export interface EtcdClientOptions {
  readonly fetch: Fetch
  /** HTTP(S) origin of the gateway, for example "http://127.0.0.1:2379". */
  readonly address: string
  /** Token from /v3/auth/authenticate, sent unchanged as the Authorization header value (no "Bearer"). */
  readonly token?: string
}
```

#### `EtcdClient`

接口 · 新增

不透明的 etcd 客户端句柄：在 registry、config 与 store 之间共享同一个。

```ts
export interface EtcdClient {
  readonly [etcdClientBrand]: true
}
```

#### `EtcdOperation`

类型 · 语义变化 · 替代 `@go-like/registry-etcd#EtcdOperation`、`@go-like/store-etcd#EtcdStoreOperation`

etcd 错误中的操作名，按 socket 子路径加前缀。

```ts
export type EtcdOperation =
  | "registry.lease-grant"
  | "registry.lease-keepalive"
  | "registry.lease-revoke"
  | "registry.txn"
  | "registry.range"
  | "registry.watch"
  | "config.range"
  | "config.watch"
  | "store.read"
  | "store.write"
  | "store.write-readback"
  | "store.delete"
  | "store.delete-readback"
  | "store.list"
  | "store.lease-grant"
  | "store.lease-revoke"
```

#### `EtcdHttpError`

接口 · 语义变化 · 替代 `@go-like/registry-etcd#EtcdHttpError`、`@go-like/config-etcd#EtcdHttpError`、`@go-like/store-etcd#EtcdStoreHttpError`

etcd 网关返回了不被允许的非 2xx 状态；registry、config、store 共用这一种形状。

```ts
export interface EtcdHttpError extends Error {
  readonly name: "EtcdHttpError"
  readonly code: "GO_LIKE_ETCD_HTTP"
  readonly operation: EtcdOperation
  readonly status: number
  /** Numeric gRPC code from the gateway error body, null when absent (read from at most 64 KiB). */
  readonly grpcCode: number | null
}
```

#### `EtcdTransportError`

接口 · 语义变化 · 替代 `@go-like/registry-etcd#EtcdTransportError`、`@go-like/config-etcd#EtcdTransportError`、`@go-like/store-etcd#EtcdStoreTransportError`

与 etcd 的请求或响应体读取在 ctx 仍有效时失败；cause 为原始错误。

```ts
export interface EtcdTransportError extends Error {
  readonly name: "EtcdTransportError"
  readonly code: "GO_LIKE_ETCD_TRANSPORT"
  readonly operation: EtcdOperation
  readonly cause: Error
}
```

#### `EtcdProtocolError`

接口 · 语义变化 · 替代 `@go-like/config-etcd#EtcdProtocolError`、`@go-like/store-etcd#EtcdStoreProtocolError`

etcd 响应畸形或违反协议。

```ts
export interface EtcdProtocolError extends Error {
  readonly name: "EtcdProtocolError"
  readonly code: "GO_LIKE_ETCD_PROTOCOL"
  readonly operation: EtcdOperation
}
```

### `@go-like/etcd/registry`

角色：插头；3 个导出。

基于 etcd 的 Registry：租约支撑的记录、keepalive 心跳，以及从 revision + 1 开始的 /v3/watch 监视。填充核心 @go-like/core/registry 的 Registry 与 Watcher socket；由应用构造并传给 App 的 registrar(...) 选项与客户端的发现。

#### `newEtcdRegistry`

函数 · 语义变化 · 替代 `@go-like/registry-etcd#newEtcdRegistry` · 实现 `@go-like/core/registry#Registry`、`@go-like/core/registry#Watcher`

在共享 etcd 客户端之上创建 Registry。

```ts
export declare function newEtcdRegistry(
  client: EtcdClient,
  options?: EtcdRegistryOptions
): EtcdRegistry
```

#### `EtcdRegistryOptions`

接口 · 语义变化 · 替代 `@go-like/registry-etcd#EtcdRegistryOptions`

newEtcdRegistry 的选项；连接字段已移到 EtcdClientOptions。

```ts
export interface EtcdRegistryOptions {
  /** Absolute key prefix ending in "/", default "/go-like/registry/v1/". */
  readonly prefix?: string
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  readonly watchBufferSize?: number
  /** Lease TTL 2000..86400000, default 120000; keepalive every ttlMs / 2. */
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly onRegistrationError?: RegistrationErrorHandler | null
}
```

#### `EtcdRegistry`

接口 · 迁移 · 替代 `@go-like/registry-etcd#EtcdRegistry` · 实现 `@go-like/core/registry#Registry`

etcd 注册中心：同一个对象既是 Registrar 也是 Discovery。

```ts
export interface EtcdRegistry extends Registry {}
```

### `@go-like/etcd/config`

角色：插头；2 个导出。

基于一个 etcd 键的 ConfigSource：流式 watch，压缩（compaction）后重新 list。填充核心 @go-like/core/config 的 ConfigSource 与 ConfigSourceWatcher socket；由应用传给 newConfig 的 source(...) 选项。

#### `etcdSource`

函数 · 语义变化 · 替代 `@go-like/config-etcd#etcdSource` · 实现 `@go-like/core/config#ConfigSource`、`@go-like/core/config#ConfigSourceWatcher`

在共享 etcd 客户端之上创建一个键的 ConfigSource；键不存在时默认以 ConfigSourceMissingError 拒绝。

```ts
export declare function etcdSource(client: EtcdClient, options: EtcdSourceOptions): ConfigSource
```

#### `EtcdSourceOptions`

接口 · 语义变化 · 替代 `@go-like/config-etcd#EtcdSourceOptions`

etcdSource 的选项；连接字段已移到 EtcdClientOptions，新增 optional。

```ts
export interface EtcdSourceOptions {
  readonly key: string
  /** Default "etcd". */
  readonly name?: string
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  readonly decode?: ConfigDecoder
  /** NEW. When true an absent key loads as {} (today's only behaviour); default false: ConfigSourceMissingError. */
  readonly optional?: boolean
}
```

### `@go-like/etcd/store`

角色：插头；6 个导出。

基于 etcd KV 的 Store：用 revision 实现 CAS，用租约实现 TTL。填充核心 @go-like/core/store 的 Store socket；由应用构造并作为 Store 传给消费它的服务代码。

#### `newEtcdStore`

函数 · 语义变化 · 替代 `@go-like/store-etcd#newEtcdStore` · 实现 `@go-like/core/store#Store`

在共享 etcd 客户端之上创建 Store；原先的连接选项已移到 EtcdClientOptions。

```ts
export declare function newEtcdStore(client: EtcdClient): EtcdStore
```

#### `EtcdStoreCompactedError`

接口 · 迁移 · 替代 `@go-like/store-etcd#EtcdStoreCompactedError`

读取已被 etcd 压缩（compacted）的 revision。

```ts
export interface EtcdStoreCompactedError extends Error {
  readonly name: "EtcdStoreCompactedError"
  readonly code: "GO_LIKE_ETCD_STORE_COMPACTED"
  readonly revision: string
}
```

#### `EtcdStoreLeaseLostError`

接口 · 迁移 · 替代 `@go-like/store-etcd#EtcdStoreLeaseLostError`

写入所依赖的租约已丢失。

```ts
export interface EtcdStoreLeaseLostError extends Error {
  readonly name: "EtcdStoreLeaseLostError"
  readonly code: "GO_LIKE_ETCD_STORE_LEASE_LOST"
  readonly operation: "write"
}
```

#### `EtcdStoreUncertainError`

接口 · 迁移 · 替代 `@go-like/store-etcd#EtcdStoreUncertainError`

写入或删除的结果不确定（请求可能已生效）。

```ts
export interface EtcdStoreUncertainError extends Error {
  readonly name: "EtcdStoreUncertainError"
  readonly code: "GO_LIKE_ETCD_STORE_UNCERTAIN"
  readonly operation: "write" | "delete"
  readonly cause: Error
}
```

#### `EtcdStoreCleanupError`

接口 · 迁移 · 替代 `@go-like/store-etcd#EtcdStoreCleanupError`

写入或删除已提交，但随后的租约清理失败。

```ts
export interface EtcdStoreCleanupError extends Error {
  readonly name: "EtcdStoreCleanupError"
  readonly code: "GO_LIKE_ETCD_STORE_CLEANUP"
  readonly operation: "write" | "delete"
  readonly committed: true
  readonly cause: Error
}
```

#### `EtcdStore`

接口 · 迁移 · 替代 `@go-like/store-etcd#EtcdStore` · 实现 `@go-like/core/store#Store`

etcd Store 类型。

```ts
export interface EtcdStore extends Store {}
```

## `@go-like/vault`

### `@go-like/vault`

角色：插头；7 个导出。

Vault KV v2 的共享协议客户端与统一错误族：一个 VaultClient 同时供 ./config 与 ./store 使用，自己不填充任何核心 socket。由应用构造一次并传给各 socket 构造器；底层消费核心 @go-like/core/fetch 的 Fetch。

#### `newVaultClient`

函数 · 新增

创建共享 Vault 客户端；地址、令牌或命名空间非法时在任何 I/O 之前抛出 TypeError。

```ts
export declare function newVaultClient(options: VaultClientOptions): VaultClient
```

#### `VaultClientOptions`

接口 · 新增

newVaultClient 的连接选项（原先分散在 config 与 store 两份选项里）。

```ts
export interface VaultClientOptions {
  readonly fetch: Fetch
  readonly address: string
  /** Sent as X-Vault-Token. */
  readonly token?: string
  /** Sent as X-Vault-Namespace (Vault Enterprise). */
  readonly namespace?: string
}
```

#### `VaultClient`

接口 · 新增

不透明的 Vault 客户端句柄：在 config 与 store 之间共享同一个。

```ts
export interface VaultClient {
  readonly [vaultClientBrand]: true
}
```

#### `VaultOperation`

类型 · 改名 · 替代 `@go-like/store-vault#VaultStoreOperation`

Vault 错误中的操作名，按 socket 子路径加前缀。

```ts
export type VaultOperation =
  | "config.read"
  | "store.read"
  | "store.write"
  | "store.delete"
  | "store.list"
```

#### `VaultHttpError`

接口 · 语义变化 · 替代 `@go-like/config-vault#VaultHttpError`、`@go-like/store-vault#VaultStoreHttpError`

Vault 返回了不被允许的非 2xx 状态；config 与 store 共用这一种形状。

```ts
export interface VaultHttpError extends Error {
  readonly name: "VaultHttpError"
  readonly code: "GO_LIKE_VAULT_HTTP"
  readonly operation: VaultOperation
  readonly status: number
}
```

#### `VaultTransportError`

接口 · 语义变化 · 替代 `@go-like/config-vault#VaultTransportError`、`@go-like/store-vault#VaultStoreTransportError`

与 Vault 的请求或响应体读取在 ctx 仍有效时失败；cause 为原始错误（令牌存在时为固定的保密错误）。

```ts
export interface VaultTransportError extends Error {
  readonly name: "VaultTransportError"
  readonly code: "GO_LIKE_VAULT_TRANSPORT"
  readonly operation: VaultOperation
  readonly cause: Error
}
```

#### `VaultProtocolError`

接口 · 语义变化 · 替代 `@go-like/config-vault#VaultProtocolError`、`@go-like/store-vault#VaultStoreProtocolError`

Vault 响应畸形或违反协议。

```ts
export interface VaultProtocolError extends Error {
  readonly name: "VaultProtocolError"
  readonly code: "GO_LIKE_VAULT_PROTOCOL"
  readonly operation: VaultOperation
}
```

### `@go-like/vault/config`

角色：插头；2 个导出。

基于一个 Vault KV v2 密钥的 ConfigSource，按元数据 version 轮询变化。填充核心 @go-like/core/config 的 ConfigSource 与 ConfigSourceWatcher socket；由应用传给 newConfig 的 source(...) 选项。

#### `vaultSource`

函数 · 语义变化 · 替代 `@go-like/config-vault#vaultSource` · 实现 `@go-like/core/config#ConfigSource`、`@go-like/core/config#ConfigSourceWatcher`

在共享 Vault 客户端之上创建一个密钥的 ConfigSource；密钥不存在时默认以 ConfigSourceMissingError 拒绝。

```ts
export declare function vaultSource(client: VaultClient, options: VaultSourceOptions): ConfigSource
```

#### `VaultSourceOptions`

接口 · 语义变化 · 替代 `@go-like/config-vault#VaultSourceOptions`

vaultSource 的选项；连接字段已移到 VaultClientOptions，新增 optional。

```ts
export interface VaultSourceOptions {
  /** KV v2 mount, for example "secret". */
  readonly mount: string
  /** Secret path under the mount. */
  readonly path: string
  /** Default "vault". */
  readonly name?: string
  /** 1..600000, default 5000. */
  readonly pollIntervalMs?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** NEW. When true an absent secret loads as {}; default false: ConfigSourceMissingError. */
  readonly optional?: boolean
}
```

### `@go-like/vault/store`

角色：插头；5 个导出。

基于 Vault KV v2 的 Store：用 check-and-set 版本实现 CAS，列表游标为进程内快照。填充核心 @go-like/core/store 的 Store socket；由应用构造并作为 Store 传给消费它的服务代码。

#### `newVaultStore`

函数 · 语义变化 · 替代 `@go-like/store-vault#newVaultStore` · 实现 `@go-like/core/store#Store`

在共享 Vault 客户端之上创建 Store。

```ts
export declare function newVaultStore(client: VaultClient, options: VaultStoreOptions): VaultStore
```

#### `VaultStoreOptions`

接口 · 语义变化 · 替代 `@go-like/store-vault#VaultStoreOptions`

newVaultStore 的选项；连接字段已移到 VaultClientOptions。

```ts
export interface VaultStoreOptions {
  readonly mount: string
  /** Default "go-like/store". */
  readonly root?: string
  /** Lifetime of a list cursor snapshot, default 60000. */
  readonly cursorTtlMs?: number
}
```

#### `VaultStoreUncertainError`

接口 · 迁移 · 替代 `@go-like/store-vault#VaultStoreUncertainError`

写入或删除的结果不确定（请求可能已生效）。

```ts
export interface VaultStoreUncertainError extends Error {
  readonly name: "VaultStoreUncertainError"
  readonly code: "GO_LIKE_VAULT_STORE_UNCERTAIN"
  readonly operation: "write" | "delete"
  readonly cause: Error
}
```

#### `VaultStoreSnapshotError`

接口 · 迁移 · 替代 `@go-like/store-vault#VaultStoreSnapshotError`

列表游标快照无效、已过期或容量超限。

```ts
export interface VaultStoreSnapshotError extends Error {
  readonly name: "VaultStoreSnapshotError"
  readonly code: "GO_LIKE_VAULT_STORE_SNAPSHOT"
  readonly reason: "invalid-cursor" | "expired-cursor" | "capacity"
}
```

#### `VaultStore`

接口 · 迁移 · 替代 `@go-like/store-vault#VaultStore` · 实现 `@go-like/core/store#Store`

Vault Store 类型。

```ts
export interface VaultStore extends Store {}
```

## `@go-like/kubernetes`

### `@go-like/kubernetes`

角色：插头；7 个导出。

Kubernetes API server 的共享协议客户端与统一错误族：一个 KubernetesClient 同时供 ./registry 与 ./config 使用，自己不填充任何核心 socket。由应用构造一次并传给各 socket 构造器；底层消费核心 @go-like/core/fetch 的 Fetch。

#### `newKubernetesClient`

函数 · 新增

创建共享 Kubernetes 客户端；地址或令牌非法时在任何 I/O 之前抛出 TypeError。

```ts
export declare function newKubernetesClient(options: KubernetesClientOptions): KubernetesClient
```

#### `KubernetesClientOptions`

接口 · 新增

newKubernetesClient 的连接选项（原先分散在 registry 与 config 两份选项里）。

```ts
export interface KubernetesClientOptions {
  /** Must trust the cluster CA (for example an undici Agent or Bun tls option inside the wrapper). */
  readonly fetch: Fetch
  /** API server origin, for example "https://kubernetes.default.svc". */
  readonly address: string
  /** ServiceAccount token, sent as "Authorization: Bearer <token>". */
  readonly token?: string
}
```

#### `KubernetesClient`

接口 · 新增

不透明的 Kubernetes 客户端句柄：在 registry 与 config 之间共享同一个。

```ts
export interface KubernetesClient {
  readonly [kubernetesClientBrand]: true
}
```

#### `KubernetesOperation`

类型 · 迁移 · 替代 `@go-like/registry-kubernetes#KubernetesOperation`

Kubernetes 错误中的操作名，按 socket 子路径加前缀。

```ts
export type KubernetesOperation =
  | "registry.create"
  | "registry.delete"
  | "registry.get"
  | "registry.list"
  | "registry.update"
  | "registry.watch"
  | "config.get"
  | "config.list"
  | "config.watch"
```

#### `KubernetesHttpError`

接口 · 语义变化 · 替代 `@go-like/registry-kubernetes#KubernetesHttpError`、`@go-like/config-kubernetes#KubernetesConfigHttpError`

API server 返回了不被允许的非 2xx 状态；registry 与 config 共用这一种形状（错误码由 GO_LIKE_KUBERNETES_CONFIG_HTTP 改为 GO_LIKE_KUBERNETES_HTTP）。

```ts
export interface KubernetesHttpError extends Error {
  readonly name: "KubernetesHttpError"
  readonly code: "GO_LIKE_KUBERNETES_HTTP"
  readonly operation: KubernetesOperation
  readonly status: number
}
```

#### `KubernetesTransportError`

接口 · 语义变化 · 替代 `@go-like/registry-kubernetes#KubernetesTransportError`、`@go-like/config-kubernetes#KubernetesConfigTransportError`

与 API server 的请求或响应体读取在 ctx 仍有效时失败；cause 为原始错误（令牌存在时为固定的保密错误）。

```ts
export interface KubernetesTransportError extends Error {
  readonly name: "KubernetesTransportError"
  readonly code: "GO_LIKE_KUBERNETES_TRANSPORT"
  readonly operation: KubernetesOperation
  readonly cause: Error
}
```

#### `KubernetesProtocolError`

接口 · 改名 · 替代 `@go-like/config-kubernetes#KubernetesConfigProtocolError`

API server 响应畸形或违反协议。

```ts
export interface KubernetesProtocolError extends Error {
  readonly name: "KubernetesProtocolError"
  readonly code: "GO_LIKE_KUBERNETES_PROTOCOL"
  readonly operation: KubernetesOperation
}
```

### `@go-like/kubernetes/registry`

角色：插头；4 个导出。

基于 Kubernetes EndpointSlice 的 Registry：确定性命名的切片，list 加 watch，遇到 410 时重新 list。填充核心 @go-like/core/registry 的 Registry 与 Watcher socket；由应用构造并传给 App 的 registrar(...) 选项与客户端的发现。

#### `newKubernetesRegistry`

函数 · 语义变化 · 替代 `@go-like/registry-kubernetes#newKubernetesRegistry` · 实现 `@go-like/core/registry#Registry`、`@go-like/core/registry#Watcher`

在共享 Kubernetes 客户端之上创建 Registry。

```ts
export declare function newKubernetesRegistry(
  client: KubernetesClient,
  options: KubernetesRegistryOptions
): KubernetesRegistry
```

#### `KubernetesPodOwner`

接口 · 迁移 · 替代 `@go-like/registry-kubernetes#KubernetesPodOwner`

拥有切片的同命名空间 Pod，用于 ownerReference。

```ts
export interface KubernetesPodOwner {
  readonly name: string
  readonly uid: string
}
```

#### `KubernetesRegistryOptions`

接口 · 语义变化 · 替代 `@go-like/registry-kubernetes#KubernetesRegistryOptions`

newKubernetesRegistry 的选项；连接字段已移到 KubernetesClientOptions。

```ts
export interface KubernetesRegistryOptions {
  /** DNS-label namespace of the EndpointSlices. */
  readonly namespace: string
  /** Same-namespace Pod that owns the slices (ownerReference, garbage-collected with the Pod). */
  readonly owner?: KubernetesPodOwner
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** Server-side watch timeout, default 30. */
  readonly watchTimeoutSeconds?: number
  readonly watchBufferSize?: number
  readonly timeoutMs?: number
  readonly onRegistrationError?: RegistrationErrorHandler | null
}
```

#### `KubernetesRegistry`

接口 · 迁移 · 替代 `@go-like/registry-kubernetes#KubernetesRegistry` · 实现 `@go-like/core/registry#Registry`

Kubernetes 注册中心：同一个对象既是 Registrar 也是 Discovery。

```ts
export interface KubernetesRegistry extends Registry {}
```

### `@go-like/kubernetes/config`

角色：插头；3 个导出。

基于 ConfigMap 或 Secret 中一个键的 ConfigSource：支持 watch，遇到 410 时重新 list。填充核心 @go-like/core/config 的 ConfigSource 与 ConfigSourceWatcher socket；由应用传给 newConfig 的 source(...) 选项。

#### `kubernetesSource`

函数 · 语义变化 · 替代 `@go-like/config-kubernetes#kubernetesSource` · 实现 `@go-like/core/config#ConfigSource`、`@go-like/core/config#ConfigSourceWatcher`

在共享 Kubernetes 客户端之上创建一个键的 ConfigSource；对象或键不存在时默认以 ConfigSourceMissingError 拒绝。

```ts
export declare function kubernetesSource(
  client: KubernetesClient,
  options: KubernetesSourceOptions
): ConfigSource
```

#### `KubernetesSourceObject`

类型 · 改名 · 替代 `@go-like/config-kubernetes#KubernetesConfigKind`

恰好指明 ConfigMap 或 Secret 之一（取代 kind 加 name）。

```ts
export type KubernetesSourceObject =
  | { readonly configMap: string; readonly secret?: never }
  | { readonly secret: string; readonly configMap?: never }
```

#### `KubernetesSourceOptions`

类型 · 语义变化 · 替代 `@go-like/config-kubernetes#KubernetesSourceOptions`

kubernetesSource 的选项；连接字段已移到 KubernetesClientOptions，sourceName 改为 name，新增 optional。

```ts
export type KubernetesSourceOptions = KubernetesSourceObject & {
  readonly namespace: string
  /** Key inside data (Secret values are base64-decoded). */
  readonly key: string
  /** Source name, default "kubernetes" (was sourceName). */
  readonly name?: string
  /** Bound of get and list requests, default 10000. */
  readonly timeoutMs?: number
  /** Server-side watch timeout, default 300. */
  readonly watchTimeoutSeconds?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  readonly decode?: ConfigDecoder
  /** NEW. When true an absent object or key loads as {}; default false: ConfigSourceMissingError. */
  readonly optional?: boolean
}
```

## `@go-like/zookeeper`

### `@go-like/zookeeper/registry`

角色：插头；14 个导出。

基于 ZooKeeper 的 Registry：可移植的状态机，运行在注入的 ZookeeperClientFactory 之上，从不导入原生库。填充核心 @go-like/core/registry 的 Registry 与 Watcher socket，并定义 ZookeeperClient、ZookeeperClientFactory 两个 plug 自有 socket；原生工厂见 ./registry/node。

#### `newZookeeperRegistry`

函数 · 语义变化 · 替代 `@go-like/registry-zookeeper#newZookeeperRegistry` · 实现 `@go-like/core/registry#Registry`、`@go-like/core/registry#Watcher`

在注入的 ZookeeperClientFactory 之上创建 Registry。

```ts
export declare function newZookeeperRegistry(options: ZookeeperRegistryOptions): ZookeeperRegistry
```

#### `ZookeeperAcl`

类型 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperAcl`

创建的节点使用的 ACL：open 为完全开放，creator 为仅创建者。

```ts
export type ZookeeperAcl = "open" | "creator"
```

#### `ZookeeperAuth`

接口 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperAuth`

会话认证方案与凭据。

```ts
export interface ZookeeperAuth {
  readonly scheme: string
  readonly credential: string | Uint8Array
}
```

#### `ZookeeperClientState`

类型 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperClientState`

ZooKeeper 会话的连接状态。

```ts
export type ZookeeperClientState =
  | "connected"
  | "disconnected"
  | "expired"
  | "authentication-failed"
```

#### `ZookeeperChildren`

接口 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperChildren`

一个节点的子节点名列表。

```ts
export interface ZookeeperChildren {
  readonly names: readonly string[]
}
```

#### `ZookeeperMutation`

类型 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperMutation`

原子多操作 mutate 的一项：创建临时节点或删除节点。

```ts
export type ZookeeperMutation =
  | { readonly kind: "create-ephemeral"; readonly path: string; readonly data: Uint8Array }
  | { readonly kind: "delete"; readonly path: string }
```

#### `ZookeeperClient`　[插座]

接口 · 语义变化 · 替代 `@go-like/registry-zookeeper#ZookeeperClient`

一个原生会话之上的 Promise 边界，由 ./registry/node 的原生绑定或测试替身实现。Changed: every operation takes ctx first (was AbortSignal last). Ownership: the registry owns each client it creates and closes it.

```ts
export interface ZookeeperClient {
  connect(ctx: Context): Promise<void>
  close(ctx: Context): Promise<void>
  /** Returns the unsubscribe function. */
  onState(listener: (state: ZookeeperClientState) => void): () => void
  mkdirp(ctx: Context, path: string): Promise<void>
  children(ctx: Context, path: string): Promise<ZookeeperChildren>
  /** Installs one one-shot watch; listener fires at most once. */
  watchChildren(ctx: Context, path: string, listener: () => void): Promise<ZookeeperChildren>
  data(ctx: Context, path: string): Promise<Uint8Array>
  /** Atomic multi-op; ctx gates submission only. */
  mutate(ctx: Context, mutations: readonly ZookeeperMutation[]): Promise<void>
  /** false when already absent. */
  remove(ctx: Context, path: string): Promise<boolean>
}
```

#### `ZookeeperClientFactoryOptions`

接口 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperClientFactoryOptions`

传给 ZookeeperClientFactory 的连接选项。

```ts
export interface ZookeeperClientFactoryOptions {
  readonly connectionString: string
  readonly sessionTimeoutMs: number
  readonly spinDelayMs: number
  readonly retries: number
  readonly auth: { readonly scheme: string; readonly credential: Uint8Array } | null
  readonly acl: ZookeeperAcl
}
```

#### `ZookeeperClientFactory`　[插座]

类型 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperClientFactory`

为每个注册会话或 watcher 创建一个尚未连接的 ZookeeperClient 的工厂。

```ts
export type ZookeeperClientFactory = (options: ZookeeperClientFactoryOptions) => ZookeeperClient
```

#### `ZookeeperRegistryOptions`

接口 · 语义变化 · 替代 `@go-like/registry-zookeeper#ZookeeperRegistryOptions`

newZookeeperRegistry 的选项；client 现为必填，原先的 clientFactory 与 logger 已移除。

```ts
export interface ZookeeperRegistryOptions {
  /** REQUIRED now: newNodeZookeeperClientFactory() from @go-like/zookeeper/registry/node, or a test double. */
  readonly client: ZookeeperClientFactory
  /** Connection string "host:port[,host:port]". */
  readonly address: string
  /** Default "/go-like/registry/v1". */
  readonly root?: string
  readonly auth?: ZookeeperAuth
  /** Default "open". */
  readonly acl?: ZookeeperAcl
  /** Default 30000. */
  readonly sessionTimeoutMs?: number
  /** Default 1000. */
  readonly spinDelayMs?: number
  /** Default 0. */
  readonly retries?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** Periodic full reconcile of a watcher, default 5000. */
  readonly reconcileIntervalMs?: number
  readonly watchBufferSize?: number
  readonly timeoutMs?: number
  readonly onRegistrationError?: RegistrationErrorHandler | null
}
```

#### `ZookeeperOperation`

类型 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperOperation`

ZookeeperOperationError 中标识失败所在的操作名。

```ts
export type ZookeeperOperation =
  | "connect"
  | "close"
  | "mkdirp"
  | "children"
  | "watch-children"
  | "data"
  | "mutate"
  | "remove"
```

#### `ZookeeperOperationError`

接口 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperOperationError`

一个 ZooKeeper 操作失败；nativeCode 为原生错误码，retryable 指明是否可重试。

```ts
export interface ZookeeperOperationError extends Error {
  readonly name: "ZookeeperOperationError"
  readonly code: "GO_LIKE_ZOOKEEPER_OPERATION"
  readonly operation: ZookeeperOperation
  readonly nativeCode: number | null
  readonly retryable: boolean
}
```

#### `ZookeeperAuthenticationError`

接口 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperAuthenticationError`

ZooKeeper 会话认证失败。

```ts
export interface ZookeeperAuthenticationError extends Error {
  readonly name: "ZookeeperAuthenticationError"
  readonly code: "GO_LIKE_ZOOKEEPER_AUTHENTICATION"
}
```

#### `ZookeeperRegistry`

接口 · 迁移 · 替代 `@go-like/registry-zookeeper#ZookeeperRegistry` · 实现 `@go-like/core/registry#Registry`

ZooKeeper 注册中心：同一个对象既是 Registrar 也是 Discovery。

```ts
export interface ZookeeperRegistry extends Registry {}
```

### `@go-like/zookeeper/registry/node`

角色：插头；1 个导出。

Node 运行时绑定：基于 node-zookeeper-client 1.2.1 的 ZookeeperClientFactory，是本 plug 唯一导入第三方库的入口。只属于 Node 车道（Bun 亦可运行）；应用把它的结果作为 ZookeeperRegistryOptions.client 传给 newZookeeperRegistry。

#### `newNodeZookeeperClientFactory`

函数 · 新增 · 实现 `@go-like/zookeeper/registry#ZookeeperClientFactory`

创建基于 node-zookeeper-client 的原生客户端工厂，每次调用返回一个尚未连接的 ZookeeperClient。

```ts
export declare function newNodeZookeeperClientFactory(): ZookeeperClientFactory
```

## `@go-like/mdns`

### `@go-like/mdns/registry`

角色：插头；22 个导出。

基于 mDNS 的 Registry：可移植的实现，运行在注入的 MDNSHost 之上，不导入任何 Node 模块。填充核心 @go-like/core/registry 的 Registry 与 Watcher socket，并定义 MDNSHost、MDNSDatagramSocket、MDNSMembership 三个 plug 自有 socket；Node 主机见 ./registry/node。

#### `domain`

函数 · 迁移 · 替代 `@go-like/registry-mdns#domain`

选项：mDNS 域名。

```ts
export declare function domain(value: string): MDNSOption
```

#### `families`

函数 · 迁移 · 替代 `@go-like/registry-mdns#families`

选项：使用的 IP 地址族。

```ts
export declare function families(...values: readonly MDNSFamily[]): MDNSOption
```

#### `interfaces`

函数 · 迁移 · 替代 `@go-like/registry-mdns#interfaces`

选项：使用的网络接口 id。

```ts
export declare function interfaces(...ids: readonly (string | number)[]): MDNSOption
```

#### `maxDecodedPayloadBytes`

函数 · 迁移 · 替代 `@go-like/registry-mdns#maxDecodedPayloadBytes`

选项：解码后负载的字节上限。

```ts
export declare function maxDecodedPayloadBytes(value: number): MDNSOption
```

#### `maxPacketBytes`

函数 · 迁移 · 替代 `@go-like/registry-mdns#maxPacketBytes`

选项：单个数据包的字节上限。

```ts
export declare function maxPacketBytes(value: number): MDNSOption
```

#### `onRegistrationError`

函数 · 迁移 · 替代 `@go-like/registry-mdns#onRegistrationError`

选项：观察注册丢失的回调。

```ts
export declare function onRegistrationError(handler: RegistrationErrorHandler): MDNSOption
```

#### `port`

函数 · 迁移 · 替代 `@go-like/registry-mdns#port`

选项：UDP 端口。

```ts
export declare function port(value: number): MDNSOption
```

#### `queryTimeout`

函数 · 迁移 · 替代 `@go-like/registry-mdns#queryTimeout`

选项：一次查询的超时（毫秒）。

```ts
export declare function queryTimeout(valueMs: number): MDNSOption
```

#### `ttl`

函数 · 迁移 · 替代 `@go-like/registry-mdns#ttl`

选项：记录的生存时间（毫秒）。

```ts
export declare function ttl(valueMs: number): MDNSOption
```

#### `watchBufferSize`

函数 · 迁移 · 替代 `@go-like/registry-mdns#watchBufferSize`

选项：每个 watcher 的队列上限。

```ts
export declare function watchBufferSize(value: number): MDNSOption
```

#### `newMDNSRegistry`

函数 · 迁移 · 替代 `@go-like/registry-mdns#newMDNSRegistry` · 实现 `@go-like/core/registry#Registry`、`@go-like/core/registry#Watcher`

在注入的 MDNSHost 之上创建 Registry；选项名沿用已批准的名称，建议用命名空间导入以避免与其他模块冲突。

```ts
export declare function newMDNSRegistry(
  host: MDNSHost,
  ...options: readonly MDNSOption[]
): MDNSRegistry
```

#### `MDNSHost`　[插座]

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSHost`

运行时的数据报与网络接口能力；由 ./registry/node 的 Node 主机或测试内存网络实现。

```ts
export interface MDNSHost {
  networkInterfaces(ctx: Context): Promise<readonly MDNSNetworkInterface[]>
  bindDatagram(ctx: Context, options: MDNSBindOptions): Promise<MDNSDatagramSocket>
}
```

#### `MDNSDatagramSocket`　[插座]

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSDatagramSocket`

由注册中心拥有的一个已绑定数据报套接字。

```ts
export interface MDNSDatagramSocket {
  settled(): Promise<void>
  joinMulticast(ctx: Context, group: string, interfaceId: string | number): Promise<MDNSMembership>
  setMulticastLoopback(ctx: Context, enabled: boolean): Promise<void>
  setMulticastInterface(ctx: Context, interfaceId: string | number): Promise<void>
  send(ctx: Context, data: Uint8Array, target: MDNSAddress): Promise<void>
  receive(ctx: Context): Promise<MDNSDatagram>
  close(ctx: Context): Promise<void>
}
```

#### `MDNSMembership`　[插座]

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSMembership`

一个多播组成员关系，离开时调用 leave。

```ts
export interface MDNSMembership {
  leave(ctx: Context): Promise<void>
}
```

#### `MDNSFamily`

类型 · 迁移 · 替代 `@go-like/registry-mdns#MDNSFamily`

mDNS 使用的 IP 地址族。

```ts
export type MDNSFamily = "ipv4" | "ipv6"
```

#### `MDNSNetworkInterface`

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSNetworkInterface`

主机的一个网络接口。

```ts
export interface MDNSNetworkInterface {
  readonly id: string | number
  readonly name: string
  readonly family: MDNSFamily
  readonly address: string
  readonly internal: boolean
}
```

#### `MDNSBindOptions`

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSBindOptions`

绑定数据报套接字的参数。

```ts
export interface MDNSBindOptions {
  readonly family: MDNSFamily
  readonly bindAddress: string
  readonly port: number
  readonly interfaceId: string | number
  readonly interfaceAddress: string
  readonly reuseAddress: boolean
  readonly multicastTTL: number
}
```

#### `MDNSAddress`

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSAddress`

一个数据报端点地址。

```ts
export interface MDNSAddress {
  readonly family: MDNSFamily
  readonly address: string
  readonly port: number
}
```

#### `MDNSDatagram`

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSDatagram`

一个收到的数据报及其来源。

```ts
export interface MDNSDatagram {
  readonly data: Uint8Array
  readonly remote: MDNSAddress
  readonly interfaceId?: string | number
}
```

#### `MDNSOptions`

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSOptions`

newMDNSRegistry 解析后的完整选项集合。

```ts
export interface MDNSOptions {
  readonly domain: string
  readonly interfaceIds: readonly (string | number)[]
  readonly families: readonly MDNSFamily[]
  readonly queryTimeoutMs: number
  readonly port: number
  readonly maxPacketBytes: number
  readonly maxDecodedPayloadBytes: number
  readonly watchBufferSize: number
  readonly ttlMs: number
  readonly onRegistrationError: RegistrationErrorHandler | null
}
```

#### `MDNSOption`

类型 · 迁移 · 替代 `@go-like/registry-mdns#MDNSOption`

newMDNSRegistry 的一个选项函数，把选项集合变换为新的选项集合。

```ts
export type MDNSOption = (options: MDNSOptions) => MDNSOptions
```

#### `MDNSRegistry`

接口 · 迁移 · 替代 `@go-like/registry-mdns#MDNSRegistry` · 实现 `@go-like/core/registry#Registry`

mDNS 注册中心：同一个对象既是 Registrar 也是 Discovery。

```ts
export interface MDNSRegistry extends Registry {}
```

### `@go-like/mdns/registry/node`

角色：插头；1 个导出。

Node 运行时绑定：基于 node:dgram 与 node:os 的 MDNSHost。只属于 Node 车道（Bun 亦可运行）；应用把它的结果作为 newMDNSRegistry 的 host 参数。

#### `newNodeMDNSHost`

函数 · 迁移 · 替代 `@go-like/registry-mdns/node#newNodeMDNSHost` · 实现 `@go-like/mdns/registry#MDNSHost`

创建基于 node:dgram 与 node:os 的 mDNS 主机，提供网络接口枚举与数据报套接字。

```ts
export declare function newNodeMDNSHost(): MDNSHost
```

## `@go-like/yaml`

### `@go-like/yaml/config`

角色：插头；1 个导出。

基于 js-yaml 5.5.0 的 ConfigDecoder：严格的 YAML 1.2 核心 schema，不允许别名，只接受一个文档。填充核心 @go-like/core/config 的 ConfigDecoder socket；由应用作为 decode 选项传给 fileSource、consulSource、etcdSource 或 kubernetesSource。

#### `decodeYaml`

函数 · 语义变化 · 替代 `@go-like/config/yaml#decodeYaml` · 实现 `@go-like/core/config#ConfigDecoder`

把 YAML 文本解码为 ConfigObject；签名即 ConfigDecoder，origin 在错误信息中指明文档来源。

```ts
export declare function decodeYaml(text: string, origin: string): ConfigObject
```

## `@go-like/nats`

### `@go-like/nats/broker`

角色：插头；8 个导出。

NATS core 的 `Broker` 插件：借用应用已建立的 `NatsConnection`，发布与每次投递都经核心 kit（`publish`、`deliver`）成为可观测单元。实现 `@go-like/core/broker` 的 `Broker` 与 `Subscriber`，由应用消费；连接由应用拥有（用 `newResourceServer` 纳入资源层），本入口没有生命周期 Server。

#### `natsCoreDrainTimeout`

函数 · 语义变化 · 替代 `@go-like/nats#natsCoreDrainTimeout`

每个订阅在原生取消订阅之前的排空边界，整数 0..2147483647 毫秒，默认 25000。

```ts
export declare function natsCoreDrainTimeout(timeoutMs: number): NatsCoreOption
```

#### `newNatsCoreBroker`

函数 · 语义变化 · 替代 `@go-like/nats/broker#newNatsCoreBroker`、`@go-like/nats#newNatsCoreServer` · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

在应用的 `NatsConnection` 上创建 NATS core 代理；用 `newBrokerServer(newNatsCoreBroker(connection), subject, handler)` 得到订阅 Server。

```ts
export declare function newNatsCoreBroker(
  connection: NatsConnection,
  ...options: readonly NatsCoreOption[]
): NatsCoreBroker
```

#### `NatsCoreBrokerPublishOptions`

类型 · 原位保留

NATS core 发布选项：原生 `PublishOptions` 去掉 `headers`（头由 `BrokerMessage.headers` 承载）。

```ts
export type NatsCoreBrokerPublishOptions = Omit<PublishOptions, "headers">
```

#### `NatsCoreBrokerSubscribeOptions`

类型 · 原位保留

NATS core 订阅选项：原生 `SubscriptionOptions` 去掉 `callback`（投递由代理接管）。

```ts
export type NatsCoreBrokerSubscribeOptions = Omit<SubscriptionOptions, "callback">
```

#### `NatsCoreBroker`

类型 · 新增 · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

`newNatsCoreBroker` 返回的 `Broker` 的具名类型，原生事件为 `Msg`。

```ts
export type NatsCoreBroker = Broker<
  NatsCoreBrokerPublishOptions,
  void,
  NatsCoreBrokerSubscribeOptions,
  Msg
>
```

#### `NatsCoreOption`

类型 · 新增

`newNatsCoreBroker` 的构造期选项（由已移除的 `newNatsCoreServer` 迁来）。

```ts
export type NatsCoreOption = (config: { drainTimeoutMs: number }) => void
```

#### `NatsCoreDrainTimeoutError`

接口 · 迁移 · 替代 `@go-like/nats#NatsCoreDrainTimeoutError`

订阅排空超过边界：已强制取消订阅。

```ts
export interface NatsCoreDrainTimeoutError extends Error {
  readonly name: "NatsCoreDrainTimeoutError"
  readonly code: "GO_LIKE_NATS_CORE_DRAIN_TIMEOUT"
  readonly timeoutMs: number
  readonly forced: true
}
```

#### `NatsCoreUnexpectedExitError`

接口 · 迁移 · 替代 `@go-like/nats#NatsCoreUnexpectedExitError`

订阅在没有被请求停止时意外结束；`cause` 为原生错误或 null。

```ts
export interface NatsCoreUnexpectedExitError extends Error {
  readonly name: "NatsCoreUnexpectedExitError"
  readonly code: "GO_LIKE_NATS_CORE_UNEXPECTED_EXIT"
  readonly cause: Error | null
}
```

### `@go-like/nats/jetstream`

角色：插头；8 个导出。

NATS JetStream 的 `Broker` 插件：借用应用的 `JetStreamClient`，由代码定义的消息工厂提供 `ConsumerMessages`，发布与每次投递都经核心 kit（`publish`、`deliver`）成为可观测单元。实现 `@go-like/core/broker` 的 `Broker` 与 `Subscriber`，由应用消费；结算（ack/nak/term）留在 `event.native`（`JsMsg`）上，本入口没有生命周期 Server。

#### `natsJetStreamCloseTimeout`

函数 · 语义变化 · 替代 `@go-like/nats/jetstream#natsJetStreamCloseTimeout`

关闭订阅消息流前的超时边界（毫秒）。

```ts
export declare function natsJetStreamCloseTimeout(timeoutMs: number): NatsJetStreamOption
```

#### `newNatsJetStreamBroker`

函数 · 语义变化 · 替代 `@go-like/nats/jetstream/broker#newNatsJetStreamBroker`、`@go-like/nats/jetstream#newNatsJetStreamServer` · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

在应用的 `JetStreamClient` 上创建 JetStream 代理；用 `newBrokerServer(newNatsJetStreamBroker(client, factory), subject, handler)` 得到订阅 Server。

```ts
export declare function newNatsJetStreamBroker<SubscribeOptions = void>(
  client: JetStreamClient,
  messagesFactory: NatsJetStreamBrokerMessagesFactory<SubscribeOptions>,
  ...options: readonly NatsJetStreamOption[]
): NatsJetStreamBroker<SubscribeOptions>
```

#### `NatsJetStreamBrokerPublishOptions`

类型 · 迁移 · 替代 `@go-like/nats/jetstream/broker#NatsJetStreamBrokerPublishOptions`

JetStream 发布选项：原生 `JetStreamPublishOptions` 的部分集合，去掉 `headers`。

```ts
export type NatsJetStreamBrokerPublishOptions = Omit<Partial<JetStreamPublishOptions>, "headers">
```

#### `NatsJetStreamBrokerMessagesFactory`

类型 · 迁移 · 替代 `@go-like/nats/jetstream/broker#NatsJetStreamBrokerMessagesFactory`、`@go-like/nats/jetstream#NatsJetStreamMessagesFactory`

为一次订阅取得 `ConsumerMessages` 的工厂。`subscribe` 的 `topic` 只是代码定义的订阅标签（用于 `process {subscription}`），请传入消费者的 filter subject；真正选择消息的是这个工厂。

```ts
export type NatsJetStreamBrokerMessagesFactory<Options> = (
  ctx: Context,
  topic: string,
  options?: Options
) => ConsumerMessages | Promise<ConsumerMessages>
```

#### `NatsJetStreamBroker`

类型 · 新增 · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

`newNatsJetStreamBroker` 返回的 `Broker` 的具名类型，发布结果为 `PubAck`，原生事件为 `JsMsg`。

```ts
export type NatsJetStreamBroker<SubscribeOptions = void> = Broker<
  NatsJetStreamBrokerPublishOptions,
  PubAck,
  SubscribeOptions,
  JsMsg
>
```

#### `NatsJetStreamOption`

类型 · 新增

`newNatsJetStreamBroker` 的构造期选项（由已移除的 `newNatsJetStreamServer` 迁来）。

```ts
export type NatsJetStreamOption = (config: { closeTimeoutMs: number }) => void
```

#### `NatsJetStreamCloseTimeoutError`

接口 · 原位保留

关闭订阅超过边界：已强制关闭。

```ts
export interface NatsJetStreamCloseTimeoutError extends Error {
  readonly name: "NatsJetStreamCloseTimeoutError"
  readonly code: "GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT"
  readonly timeoutMs: number
  readonly forced: true
}
```

#### `NatsJetStreamUnexpectedExitError`

接口 · 原位保留

消息流在没有被请求停止时意外结束；`cause` 为原生错误或 null。

```ts
export interface NatsJetStreamUnexpectedExitError extends Error {
  readonly name: "NatsJetStreamUnexpectedExitError"
  readonly code: "GO_LIKE_NATS_JETSTREAM_UNEXPECTED_EXIT"
  readonly cause: Error | null
}
```

## `@go-like/rabbitmq`

### `@go-like/rabbitmq/broker`

角色：插头；14 个导出。

基于 amqplib 通道的 RabbitMQ `Broker` 插件：借用应用已有的通道或可恢复连接，发布与每次投递都经核心 kit（`publish`、`deliver`）成为可观测单元。实现 `@go-like/core/broker` 的 `Broker` 与 `Subscriber`，由应用消费；结算（ack/nack/reject）留在 `RabbitMqBroker` 上，`amqplib` 在运行时仅用于类型。

#### `newRabbitMqBroker`

函数 · 迁移 · 替代 `@go-like/broker-rabbitmq#newRabbitMqBroker` · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

基于一个借用的普通通道创建代理；publish 以 amqplib 的流控布尔值 resolve。

```ts
export declare function newRabbitMqBroker(channel: Channel): RabbitMqBroker
```

#### `newConfirmRabbitMqBroker`

函数 · 迁移 · 替代 `@go-like/broker-rabbitmq#newConfirmRabbitMqBroker` · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

基于一个借用的确认通道创建代理；publish 等待确认回调。

```ts
export declare function newConfirmRabbitMqBroker(channel: ConfirmChannel): RabbitMqBroker
```

#### `startRecoveringRabbitMqBroker`

函数 · 迁移 · 替代 `@go-like/broker-rabbitmq#startRecoveringRabbitMqBroker` · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

在后台启动恢复设置并立即返回句柄（连接器 resolve 之前）。

```ts
export declare function startRecoveringRabbitMqBroker(
  ctx: Context,
  connector: RabbitMqRecoveryConnector
): RecoveringRabbitMqHandle
```

#### `newRecoveringRabbitMqBroker`

函数 · 迁移 · 替代 `@go-like/broker-rabbitmq#newRecoveringRabbitMqBroker` · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

等同于 `startRecoveringRabbitMqBroker` 的 `ready(ctx)`：等待可恢复代理就绪。

```ts
export declare function newRecoveringRabbitMqBroker(
  ctx: Context,
  connector: RabbitMqRecoveryConnector
): Promise<RecoveringRabbitMqBroker>
```

#### `RabbitMqPublishProperties`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RabbitMqPublishProperties`

AMQP 消息属性的可发布子集。

```ts
export interface RabbitMqPublishProperties {
  readonly expiration?: string | number
  readonly userId?: string
  readonly CC?: string | readonly string[]
  readonly mandatory?: boolean
  readonly persistent?: boolean
  readonly deliveryMode?: boolean | number
  readonly BCC?: string | readonly string[]
  readonly contentType?: string
  readonly contentEncoding?: string
  readonly priority?: number
  readonly correlationId?: string
  readonly replyTo?: string
  readonly messageId?: string
  readonly timestamp?: number
  readonly type?: string
  readonly appId?: string
}
```

#### `RabbitMqPublishOptions`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RabbitMqPublishOptions`

一次发布的选项：交换机、路由键与消息属性。

```ts
export interface RabbitMqPublishOptions {
  readonly exchange?: string
  readonly routingKey?: string
  readonly properties?: RabbitMqPublishProperties
}
```

#### `RabbitMqExchange`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RabbitMqExchange`

订阅时断言并绑定的交换机描述。

```ts
export interface RabbitMqExchange {
  readonly name: string
  readonly type: string
  readonly options?: Options.AssertExchange
  readonly bindingArguments?: unknown
}
```

#### `RabbitMqQueue`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RabbitMqQueue`

订阅时断言的队列描述。

```ts
export interface RabbitMqQueue {
  readonly name?: string
  readonly options?: Options.AssertQueue
}
```

#### `RabbitMqPrefetch`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RabbitMqPrefetch`

消费者预取设置。

```ts
export interface RabbitMqPrefetch {
  readonly count: number
  readonly global?: boolean
}
```

#### `RabbitMqSubscribeOptions`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RabbitMqSubscribeOptions`

一次订阅的选项：交换机、队列、路由键、预取与原生 consume 选项。

```ts
export interface RabbitMqSubscribeOptions {
  readonly exchange?: RabbitMqExchange
  readonly queue?: RabbitMqQueue
  readonly routingKey?: string
  readonly prefetch?: RabbitMqPrefetch
  readonly consume?: Options.Consume
}
```

#### `RabbitMqBroker`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RabbitMqBroker` · 实现 `@go-like/core/broker#Broker`、`@go-like/core/broker#Subscriber`

RabbitMQ 的 `Broker`：原生结算（ack/nack/reject）留在代理对象上，`native` 是 amqplib 的 `ConsumeMessage`。

```ts
export interface RabbitMqBroker extends Broker<
  RabbitMqPublishOptions,
  boolean,
  RabbitMqSubscribeOptions,
  ConsumeMessage
> {
  ack(native: ConsumeMessage, allUpTo?: boolean): void
  nack(native: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void
  reject(native: ConsumeMessage, requeue?: boolean): void
  string(): "rabbitmq"
}
```

#### `RabbitMqRecoveryConnector`

类型 · 迁移 · 替代 `@go-like/broker-rabbitmq#RabbitMqRecoveryConnector`

可恢复连接的连接器：每次（重）连接后调用 `setup` 重建拓扑。

```ts
export type RabbitMqRecoveryConnector = (
  setup: (model: ChannelModel) => Promise<void>
) => Promise<RecoveringChannelModel>
```

#### `RecoveringRabbitMqBroker`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RecoveringRabbitMqBroker`

可恢复代理就绪后的结果：代理与底层可恢复连接。

```ts
export interface RecoveringRabbitMqBroker {
  readonly broker: RabbitMqBroker
  readonly connection: RecoveringChannelModel
}
```

#### `RecoveringRabbitMqHandle`

接口 · 迁移 · 替代 `@go-like/broker-rabbitmq#RecoveringRabbitMqHandle`

可恢复代理的句柄：连接器 resolve 之前即可取得代理；`ready` 等待就绪，`stop` 停止恢复。

```ts
export interface RecoveringRabbitMqHandle {
  readonly broker: RabbitMqBroker
  ready(ctx: Context): Promise<RecoveringRabbitMqBroker>
  stop(ctx: Context): Promise<void>
}
```

## `@go-like/redis`

### `@go-like/redis/cache`

角色：插头；12 个导出。

基于 Redis 的 `Cache` 插件，同时是资源层的 `Server`：`start` 在连接成功（可用）时 resolve，`stop` 先排空已接纳操作再关闭客户端。实现 `@go-like/core/cache` 的 `Cache` 与 `@go-like/core/lifecycle` 的 `Server`，由应用通过 `resources(...)` 注册后消费；第三方库 `@redis/client` 由本插件构造并封装。

#### `newRedisCache`

函数 · 语义变化 · 替代 `@go-like/cache-redis#newRedisCache` · 实现 `@go-like/core/cache#Cache`、`@go-like/core/lifecycle#Server`

创建一个 Redis 缓存资源；选项在 I/O 之前校验，连接在 `start` 时建立。

```ts
export declare function newRedisCache(options: RedisCacheOptions): RedisCache
```

#### `RedisCacheErrorHandler`

类型 · 迁移 · 替代 `@go-like/cache-redis#RedisCacheErrorHandler`

客户端 `error` 事件的回调。

```ts
export type RedisCacheErrorHandler = (error: Error) => void
```

#### `RedisCacheCommandClient`

接口 · 迁移 · 替代 `@go-like/cache-redis#RedisCacheCommandClient`

缓存使用的 Redis 命令面：get/set/del。

```ts
export interface RedisCacheCommandClient {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    options?: Readonly<{ expiration: Readonly<{ type: "PX"; value: number }> }>
  ): Promise<string | null>
  del(key: string): Promise<number>
}
```

#### `RedisCacheClient`

接口 · 迁移 · 替代 `@go-like/cache-redis#RedisCacheClient`

插件需要的 Redis 客户端结构（与 `@redis/client` 兼容的最小形状），便于注入测试替身。

```ts
export interface RedisCacheClient {
  readonly isOpen: boolean
  on(event: "error", listener: (value: unknown) => void): unknown
  off(event: "error", listener: (value: unknown) => void): unknown
  withCommandOptions(
    options: Readonly<{ abortSignal?: AbortSignal; timeout: number }>
  ): RedisCacheCommandClient
  connect(): Promise<unknown>
  close(): Promise<unknown>
  destroy(): unknown
}
```

#### `RedisCacheClientFactory`

类型 · 迁移 · 替代 `@go-like/cache-redis#RedisCacheClientFactory`

创建 Redis 客户端的工厂，用于 `client` 选项。

```ts
export type RedisCacheClientFactory = () => RedisCacheClient
```

#### `RedisCacheOptions`

类型 · 迁移 · 替代 `@go-like/cache-redis#RedisCacheOptions`

`newRedisCache` 的选项：`url` 与 `client` 工厂二选一，另有键前缀、命令超时与错误回调。

```ts
export type RedisCacheOptions = RedisCacheCommonOptions &
  (
    | { readonly url: string; readonly client?: never; readonly connectTimeoutMs?: number }
    | {
        readonly url?: never
        readonly client: RedisCacheClientFactory
        readonly connectTimeoutMs?: never
      }
  )
```

#### `RedisCacheOperation`

类型 · 迁移 · 替代 `@go-like/cache-redis#RedisCacheOperation`

可能失败的 Redis 缓存操作名。

```ts
export type RedisCacheOperation = "connect" | "get" | "put" | "delete" | "close"
```

#### `RedisCacheState`

类型 · 新增

Redis 缓存资源的生命周期状态。

```ts
export type RedisCacheState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"
```

#### `RedisCacheOperationError`

接口 · 迁移 · 替代 `@go-like/cache-redis#RedisCacheOperationError`

Redis 操作失败，`cause` 为原始错误。

```ts
export interface RedisCacheOperationError extends Error {
  readonly name: "RedisCacheOperationError"
  readonly code: "GO_LIKE_CACHE_REDIS_OPERATION"
  readonly operation: RedisCacheOperation
  readonly cause: Error
}
```

#### `RedisCacheProtocolError`

接口 · 迁移 · 替代 `@go-like/cache-redis#RedisCacheProtocolError`

Redis 返回的值不符合缓存携带格式。

```ts
export interface RedisCacheProtocolError extends Error {
  readonly name: "RedisCacheProtocolError"
  readonly code: "GO_LIKE_CACHE_REDIS_PROTOCOL"
  readonly operation: "get"
}
```

#### `RedisCacheStateError`

接口 · 新增

当前状态不允许的操作（例如 start 之前读写）；运行时早已存在的错误，现在有了导出类型。

```ts
export interface RedisCacheStateError extends Error {
  readonly name: "RedisCacheStateError"
  readonly code: "GO_LIKE_CACHE_REDIS_STATE"
  readonly operation: string
  readonly state: RedisCacheState
}
```

#### `RedisCache`

接口 · 新增 · 实现 `@go-like/core/cache#Cache`、`@go-like/core/lifecycle#Server`

`Cache` 加资源生命周期：`start` 在连接成功后 resolve（准入即可用，不会为运行期保持 pending），`stop` 先排空已接纳操作再关闭。通过 `resources(...)` 注册以保证先于使用它的 server 启动。

```ts
export interface RedisCache extends Cache, Server {
  string(): "redis"
}
```

## `@go-like/bullmq`

### `@go-like/bullmq/job`

角色：插头；5 个导出。

基于 BullMQ 的 `JobQueue` 插件，同时是资源层的 `Server`：它收养应用构造的原生 `Queue`，`start` 在 `waitUntilReady` 完成后 resolve，`stop` 关闭队列一次。实现 `@go-like/core/job` 的 `JobQueue` 与 `@go-like/core/lifecycle` 的 `Server`；入队与每次运行都经核心 kit（`enqueue`、`dispatchJob`）成为可观测单元，`worker(...)` 返回的 Server 由插件构造原生 Worker。`bullmq` 是 peer 依赖，因为应用的 Queue 与插件的 Worker 共享同一份 Redis 键与 Lua 脚本。

#### `newBullMqJobQueue`

函数 · 新增 · 实现 `@go-like/core/job#JobQueue`、`@go-like/core/lifecycle#Server`

收养应用构造的原生 `Queue`，得到 `JobQueue`。构造期会校验 Queue 的结构，并拒绝 `telemetry`、`autorun`、`concurrency`、`connection` 与 `prefix`；处理函数抛出 `newPermanentJobError(cause)` 或名称未知时，作业以 UnrecoverableError 终止而不再重试。

```ts
export declare function newBullMqJobQueue<T>(
  queue: Queue<T, unknown, string, T, unknown, string>,
  options?: BullMqJobQueueOptions
): BullMqJobQueue<T>
```

#### `BullMqWorkerOptions`

类型 · 新增

每个 `worker()` 创建的原生 Worker 所接收的选项：autorun、concurrency、telemetry、connection 与 prefix 由 go-like 拥有（后两者取自 Queue），不可覆盖。

```ts
export type BullMqWorkerOptions = Omit<
  WorkerOptions,
  "autorun" | "concurrency" | "telemetry" | "connection" | "prefix"
>
```

#### `BullMqJobQueueOptions`

接口 · 新增

`newBullMqJobQueue` 的选项。

```ts
export interface BullMqJobQueueOptions {
  readonly worker?: BullMqWorkerOptions
}
```

#### `BullMqJobQueue`

接口 · 新增 · 实现 `@go-like/core/job#JobQueue`、`@go-like/core/lifecycle#Server`

`JobQueue` 加应用所构造 Queue 的资源生命周期：`start` 在 `waitUntilReady` 之后 resolve（准入即可用，不会为运行期保持 pending），`stop` 关闭队列。通过 `resources(...)` 注册以保证先于 `worker()` 的 Server 启动。

```ts
export interface BullMqJobQueue<T> extends JobQueue<T>, Server {
  string(): "bullmq"
}
```

#### `BullMqUnexpectedExitError`

接口 · 迁移 · 替代 `@go-like/bullmq#BullMqUnexpectedExitError`

原生 Worker 在没有被请求停止时意外退出。

```ts
export interface BullMqUnexpectedExitError extends Error {
  readonly name: "BullMqUnexpectedExitError"
  readonly code: "GO_LIKE_BULLMQ_UNEXPECTED_EXIT"
  readonly queueName: string
  readonly cause: Error | null
}
```

## `@go-like/croner`

### `@go-like/croner/job`

角色：插头；2 个导出。

基于 Croner 的 `Schedule` 插件：只计算 cron 表达式的到期时刻，不启动原生定时器、不拥有运行。实现 `@go-like/core/job` 的 `Schedule`，由应用传给核心 `newScheduleServer`；定时器、重叠、`trigger` 与排空都归核心。这是完整实现而非声明，因为插件体量只有这一个纯函数；`croner` 是插件自行构造并封装的常规依赖。

#### `newCronerSchedule`

函数 · 新增 · 实现 `@go-like/core/job#Schedule`

基于 Croner 表达式创建一个纯 `Schedule`，`string()` 为 "croner"；从不启动原生定时器。表达式、时区与夏令时语义保持 Croner 的原样。

```ts
export declare function newCronerSchedule(
  pattern: string,
  options?: CronerScheduleOptions
): Schedule
```

#### `CronerScheduleOptions`

类型 · 新增

影响时刻表形状的 Croner 选项子集；运行期选项（paused、catch、protect、maxRuns、context 等）归核心拥有，传入会抛出 TypeError。

```ts
export type CronerScheduleOptions = Pick<
  CronOptions,
  "timezone" | "utcOffset" | "domAndDow" | "dayOffset" | "mode" | "startAt" | "stopAt"
>
```

## `@go-like/file`

### `@go-like/file/store`

角色：插头；9 个导出。

本地文件系统的 `Store` 插件，同时是资源层的 `Server`：`start` 在持有目录锁并加载快照后 resolve，`stop` 排空串行队列、清理临时文件并释放锁。引擎可移植，经插件自有的 `FileStoreHost` 访问文件系统；Node 宿主在 `@go-like/file/store/node`。实现 `@go-like/core/store` 的 `Store` 与 `@go-like/core/lifecycle` 的 `Server`，由应用通过 `resources(...)` 注册后消费。

#### `newFileStore`

函数 · 语义变化 · 替代 `@go-like/store-file#newFileStore` · 实现 `@go-like/core/store#Store`、`@go-like/core/lifecycle#Server`

在宿主提供的目录上创建文件存储资源；构造不做 I/O，锁与快照在 `start` 时获取。

```ts
export declare function newFileStore(host: FileStoreHost, directory: string): FileStore
```

#### `FileStoreState`

类型 · 迁移 · 替代 `@go-like/store-file#FileStoreState`

文件存储资源的生命周期状态。

```ts
export type FileStoreState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"
```

#### `FileStoreStateError`

接口 · 迁移 · 替代 `@go-like/store-file#FileStoreStateError`

当前状态不允许的操作（例如 start 之前读写）。

```ts
export interface FileStoreStateError extends Error {
  readonly name: "FileStoreStateError"
  readonly code: "GO_LIKE_FILE_STORE_STATE"
  readonly operation: string
  readonly state: FileStoreState
}
```

#### `FileStore`

接口 · 语义变化 · 替代 `@go-like/store-file#FileStore` · 实现 `@go-like/core/store#Store`、`@go-like/core/lifecycle#Server`

`Store` 加资源生命周期：`start` 在持有锁并加载快照后 resolve（准入即可用，不会为运行期保持 pending），`stop` 释放锁。通过 `resources(...)` 注册以保证先于使用它的 server 启动。

```ts
export interface FileStore extends Store, Server {
  string(): "file"
}
```

#### `FileStoreDirectory`　[插座]

接口 · 迁移 · 替代 `@go-like/store-file#FileStoreDirectory`

插件自有：一个已获取目录的文件操作面（读、写、重命名、删除与关闭）；由 `FileStoreHost` 返回，由宿主实现。

```ts
export interface FileStoreDirectory {
  close(ctx: Context): Promise<void>
  read(ctx: Context, name: string): Promise<Uint8Array | null>
  write(ctx: Context, name: string, bytes: Uint8Array): Promise<void>
  rename(ctx: Context, source: string, target: string): Promise<void>
  remove(ctx: Context, name: string): Promise<boolean>
}
```

#### `FileStoreHost`　[插座]

接口 · 迁移 · 替代 `@go-like/store-file#FileStoreHost`

插件自有：文件系统宿主，独占获取一个目录；Node 实现是 `@go-like/file/store/node` 的 `newNodeFileStoreHost`。

```ts
export interface FileStoreHost {
  acquire(ctx: Context, directory: string): Promise<FileStoreDirectory>
}
```

#### `FileStoreCorruptionReason`

类型 · 迁移 · 替代 `@go-like/store-file#FileStoreCorruptionReason`

文件存储损坏的原因分类。

```ts
export type FileStoreCorruptionReason = "encoding" | "json" | "schema" | "checksum" | "record"
```

#### `FileStoreCorruptionError`

接口 · 迁移 · 替代 `@go-like/store-file#FileStoreCorruptionError`

磁盘上的快照损坏，`reason` 给出分类。

```ts
export interface FileStoreCorruptionError extends Error {
  readonly name: "FileStoreCorruptionError"
  readonly code: "GO_LIKE_FILE_STORE_CORRUPTION"
  readonly reason: FileStoreCorruptionReason
}
```

#### `FileStoreLockedError`

接口 · 迁移 · 替代 `@go-like/store-file#FileStoreLockedError`

目录锁已被其他持有者占用。

```ts
export interface FileStoreLockedError extends Error {
  readonly name: "FileStoreLockedError"
  readonly code: "GO_LIKE_FILE_STORE_LOCKED"
}
```

### `@go-like/file/store/node`

角色：插头；1 个导出。

`FileStoreHost` 的 Node 绑定：基于 `node:fs` 的目录获取、独占锁文件、fsync 与原子重命名。实现 `@go-like/file/store` 的 `FileStoreHost`，由 Node 应用传给 `newFileStore`；公共声明不引用 Node 类型。

#### `newNodeFileStoreHost`

函数 · 迁移 · 替代 `@go-like/store-file/node#newNodeFileStoreHost` · 实现 `@go-like/file/store#FileStoreHost`

创建 Node 文件系统宿主；构造时不做任何 I/O。

```ts
export declare function newNodeFileStoreHost(): FileStoreHost
```

## `@go-like/connectrpc`

### `@go-like/connectrpc`

角色：插头；6 个导出。

Connect 与 gRPC-Web 的可移植集成：newHandler 产出可挂到 core web 宿主上的 Handler，fromHandlerContext/callOptions 衔接生成代码与 go-like Context，telemetryInterceptor 为应用自建的 Connect 传输补齐 rpc.client 单元与 traceparent 注入。本入口的依赖图不含 node:*；托管的标准 gRPC 服务端与客户端在 ./node。它不实现 core 的 Transport 套接字，核心中间件与 ServiceError 映射不作用于 Connect 处理器。

#### `newHandler`

函数 · 语义变化 · 替代 `@go-like/transport-grpc-buf#newHandler` · 实现 `@go-like/core/web#Handler`

可移植的 Connect 与 gRPC-Web Fetch 处理器，挂到 core web 宿主上；未知路径返回空的 404，并安装 rpc.server 遥测拦截器。

```ts
export declare function newHandler(routes: Routes): Handler
```

#### `fromHandlerContext`

函数 · 语义变化 · 替代 `@go-like/transport-grpc-buf#fromHandlerContext`

生成的处理器调用它取得 Context：单元 Context 加服务端元数据、TransportInfo、Connect 截止时间与取消；不再是 value() 恒为 null 的手写 Context，因此保留 AppInfo 与全部 Context 值。

```ts
export declare function fromHandlerContext(rpc: HandlerContext): Context
```

#### `callOptions`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf#callOptions`

把 go-like Context 映射为 Connect CallOptions：Context 写入 contextValues，客户端元数据成为请求头，并带上取消信号与剩余截止时间。

```ts
export declare function callOptions(ctx: Context, overrides?: CallOptions): CallOptions
```

#### `telemetryInterceptor`

函数 · 新增

面向应用自建 Connect 传输（createConnectTransport/createGrpcWebTransport）的客户端拦截器：每次调用一个 rpc.client 单元，并把 traceparent 注入请求头；/node 客户端在选择实例的外围内部做同样的事。

```ts
export declare function telemetryInterceptor(system?: "connectrpc" | "grpc"): Interceptor
```

#### `ServiceRegistrar`

类型 · 迁移 · 替代 `@go-like/transport-grpc-buf#ServiceRegistrar`

生成代码注册 Connect 服务所用的最小注册器（`ConnectRouter` 的 `service` 成员）。

```ts
export type ServiceRegistrar = Pick<ConnectRouter, "service">
```

#### `Routes`

类型 · 迁移 · 替代 `@go-like/transport-grpc-buf#Routes`

向注册器注册一组 Connect 服务的函数，由 newHandler 调用。

```ts
export type Routes = (server: ServiceRegistrar) => void
```

### `@go-like/connectrpc/node`

角色：插头；17 个导出。

基于 node:http2（@connectrpc/connect-node）的托管标准 gRPC：newServer 返回同时满足生命周期 Server、Endpointer（协议 "grpc"）与服务注册器的服务端；newClient 返回一个标准 Connect Transport，通过 core 的 Discovery/Selector 选择实例并拥有明确的 close(ctx)。两侧各自拥有 rpc.server/rpc.client 遥测单元；公开声明不引用 Node 类型。

#### `withEndpoint`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#withEndpoint`

指定固定的服务端地址（一个或多个）。

```ts
export declare function withEndpoint(endpoint: string | readonly string[]): ClientOption
```

#### `withDiscovery`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#withDiscovery`

通过 core 的 Discovery 解析服务实例。

```ts
export declare function withDiscovery(discovery: Discovery): ClientOption
```

#### `withSelector`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#withSelector`

指定实例选择器；缺省为 newRoundRobinSelector()。

```ts
export declare function withSelector(selector: Selector): ClientOption
```

#### `withBlock`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#withBlock`

发现结果为空时阻塞等待而不是立即失败。

```ts
export declare function withBlock(): ClientOption
```

#### `withTLSConfig`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#withTLSConfig`

设置客户端的 TLS 身份与信任材料；传 null 清除。

```ts
export declare function withTLSConfig(config: TLSConfig | null): ClientOption
```

#### `newClient`

函数 · 语义变化 · 替代 `@go-like/transport-grpc-buf/native#newClient`

创建托管 gRPC 客户端：围绕选择与委托产生 rpc.client 单元，解析器来自

```ts
export declare function newClient(...options: readonly ClientOption[]): Client
```

#### `address`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#address`

设置监听地址。

```ts
export declare function address(value: string): ServerOption
```

#### `advertise`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#advertise`

设置对外宣告的地址（注册到服务发现的地址）。

```ts
export declare function advertise(value: string): ServerOption
```

#### `tlsConfig`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#tlsConfig`

设置服务端的 TLS 身份与信任材料；传 null 清除。

```ts
export declare function tlsConfig(value: TLSConfig | null): ServerOption
```

#### `clientAuth`

函数 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#clientAuth`

设置客户端证书校验模式：none 不校验，require 要求并校验。

```ts
export declare function clientAuth(value: "none" | "require"): ServerOption
```

#### `newServer`

函数 · 语义变化 · 替代 `@go-like/transport-grpc-buf/native#newServer` · 实现 `@go-like/core/lifecycle#Server`、`@go-like/core/lifecycle#Endpointer`

创建托管的标准 gRPC 服务端：安装 rpc.server 遥测拦截器，宿主 ctx 来自绑定调用（endpoint 或 start）。

```ts
export declare function newServer(...options: readonly ServerOption[]): Server
```

#### `ClientOptions`

接口 · 新增

托管 gRPC 客户端的不可变配置，由 ClientOption 归约得到。

```ts
export interface ClientOptions {
  readonly addresses: readonly string[]
  readonly service: string | null
  readonly discovery: Discovery | null
  readonly selector: Selector | null
  readonly block: boolean
  readonly tlsConfig: TLSConfig | null
}
```

#### `ClientOption`

类型 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#ClientOption`

作用于 ClientOptions 的选项函数。

```ts
export type ClientOption = (options: ClientOptions) => ClientOptions
```

#### `Client`

接口 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#Client`

标准的 Connect Transport，并带有一个明确的 go-like 清理所有者 close(ctx)。

```ts
export interface Client extends ConnectTransport {
  close(ctx: Context): Promise<void>
}
```

#### `ServerOptions`

接口 · 新增

托管 gRPC 服务端的不可变配置，由 ServerOption 归约得到。

```ts
export interface ServerOptions {
  readonly address: string
  readonly advertise: string | null
  readonly tlsConfig: TLSConfig | null
  readonly clientAuth: "none" | "require"
}
```

#### `ServerOption`

类型 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#ServerOption`

作用于 ServerOptions 的选项函数。

```ts
export type ServerOption = (options: ServerOptions) => ServerOptions
```

#### `Server`

接口 · 迁移 · 替代 `@go-like/transport-grpc-buf/native#Server` · 实现 `@go-like/core/lifecycle#Server`、`@go-like/core/lifecycle#Endpointer`

一个托管的标准 gRPC 服务端：生命周期 Server、Endpointer（协议 "grpc"）与服务注册器。

```ts
export interface Server extends CoreServer, Endpointer, ServiceRegistrar {}
```

## `@go-like/protoc-gen-like`

### `@go-like/protoc-gen-like`

角色：构建工具；1 个导出。

Buf/protoc 插件，为每个 protobuf 服务生成 go-like 的 Handler/Client 接口、registerXHandler 与 newXClient；它是构建期工具而非运行时插件，不依赖 core。生成代码从 @go-like/core/context 取得 Context，从 @go-like/connectrpc 取得 ServiceRegistrar、callOptions 与 fromHandlerContext，不调用任何遥测 API。

#### `protocGenLike`

常量 · 语义变化 · 替代 `@go-like/protoc-gen-like#protocGenLike`

公开的 protoc 插件对象（`createEcmaScriptPlugin` 的产物，函数 API 不变）：`run` 接收一个 CodeGeneratorRequest 并返回 CodeGeneratorResponse。只有生成代码的导入说明符变化：`@go-like/context` 变为 `@go-like/core/context`，`@go-like/transport-grpc-buf` 变为 `@go-like/connectrpc`。

```ts
export declare const protocGenLike: {
  /** Name of this code generator plugin: "protoc-gen-like". */
  name: string
  /** Version of this code generator plugin. */
  version: string
  /** Runs the plugin for one request: one `<proto>_like.ts` per file that declares services. */
  run(request: CodeGeneratorRequest): CodeGeneratorResponse
}
```

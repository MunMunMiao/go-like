# ADR 0001：内核公共 API

日期：2026-07-19

状态：已被替代

> 本 ADR 记录早期 `ServerHandle/AppHandle` 方案，不再是当前公共契约。当前生命周期与用户体验基线见
> [`../developer-experience-alignment.md`](../developer-experience-alignment.md)。

## 背景

第一阶段必须在编写实现前消除临时原型（spike）与研究报告之间的导出差异。用户要求 Go 风格的
Context、任意结构化 Server、标准 Web Handler、内部 Transport 和可组合 App；旧原型中的 `readonly Done`、`Shutdown`、
Context 类以及 Health 的双参数顺序都不能成为兼容性包袱。

## 决策

### `@likego/context`

- `Context`、`ContextError`、`TimeoutContextError`、`CancelFunc`、`CancelCauseFunc`、`StopFunc` 是类型导出。
- `ContextError` 与 `TimeoutContextError` 不导出运行时构造函数；调用方只依赖稳定的哨兵对象标识。
- 运行时导出：`canceled`、`deadlineExceeded`、`background`、`todo`、`withCancel`、
  `withCancelCause`、`withDeadline`、`withDeadlineCause`、`withTimeout`、`withTimeoutCause`、
  `withValue`、`withoutCancel`、`cause`、`afterFunc`；不提供 PascalCase 的可调用别名或值别名。
- 生产实现优先使用闭包、普通对象与工厂函数；不为 Context、哨兵或包装器引入自定义类。内建
  `Error`、`Date`、`AbortController` 不受此约束。

#### Context 计时与 `afterFunc` 最终契约

机器可审计的契约标记：`LIKEGO_CONTEXT_TIMING_AFTERFUNC_V2`。

1. 在读取时间或分配资源前，先拒绝 nullish parent，并验证 parent 的结构形态：`deadline`、
   `done`、`err`、`value` 都必须可调用。
2. `withCancel*` 与 `withValue` 像 Go 的嵌入 Context 一样动态委托 `parent.deadline()`，构造时不得提前读取；
   只有拥有自身 timer 的 Context 保存 deadline。`withDeadline*` 与 `withTimeout*` 为决定是否需要自身 timer，
   参数验证后只读取一次 `parent.deadline()`；若 parent 报告 deadline，必须验证元组与 `Date`，并只调用一次
   `Date.prototype.getTime.call(parentDeadline)`。
3. `withDeadline*` 只调用一次 `Date.prototype.getTime.call(deadline)`，读取 parent deadline 后只调用一次
   `Date.now()` 并保存为 `wallNow`。非 `Date` 抛出 `TypeError`；deadline 或墙上时钟采样值非有限或无效时抛出
   `RangeError`；Context 内只保存数值型 deadline 快照。
4. `withTimeout*` 先验证 `timeoutMs` 为有限值，再像 Go 求值 `time.Now().Add(timeout)` 一样先调用一次
   `Date.now()` 并得到请求纪元，之后才读取 parent deadline。原始 `wallNow + timeoutMs` 必须为有限值且位于
   闭区间 TimeClip 范围内；请求纪元值为 `Math.trunc(wallNow + timeoutMs)`。若需要拥有自身 timer，完成 parent
   deadline 与 `done()` 检查后再次采样 `Date.now()` 计算剩余时间，使同步 parent 查询耗时计入 timeout；第一
   次采样定义请求 deadline，第二次采样只决定是否立即终止以及单调计时器的剩余时长。
5. 若 parent deadline 严格早于请求 deadline，返回值在语义上必须等同 `withCancel(parent)`：deadline 继续
   动态委托 parent，且即使 `parent.done() === null` 也不得擅自补 timer。否则 timed Context 保存自己的请求
   deadline，`deadline()` 每次为该数值返回新的 `Date`。若请求 deadline 已到，必须同步成为
   `deadlineExceeded`，不读取 `performance.now()`，也不创建 timer。
6. 对未来的自身 deadline，只在墙上时钟采样后读取一次 `performance.now()`，并计算
   `monotonicTarget = monotonicNow + (requestedEpoch - wallNow)`。每次设置的计时长度不超过
   `2_147_483_647ms`；唤醒时只用新读取的 `performance.now()` 与目标值比较，过早则重新设置。构造后的墙上
   时钟跳变不改变到期时刻；取消操作清除当前计时器，陈旧回调不执行任何操作。契约测试必须检测两种时钟
   getter，断言调用次数和顺序。被冻结或挂起的宿主无法靠纯标准 Web API 保证暂停期间唤醒，必须在兼容性
   文档中如实声明。
7. `afterFunc` 先遵守 `done() === null` 与已经 canceled 的优先分支，再按正常 JavaScript 属性查找读取一次
   可选的同名方法；class/prototype/inherited callable method 也必须参与委托，并以 `this === ctx` 调用。委托
   同步尝试执行的回调先进入缓冲；只有委托返回可调用的 `StopFunc` 后，缓冲中的准入才可进入共享的一次性
   状态。委托抛错或返回非函数时丢弃缓冲，用户回调永不运行。
8. 公共 stop 与回调准入只有一个胜者：成功的 stop 只成功一次、抑制回调并返回 `true`；回调已经准入后，
   stop 返回 `false`。用户回调通过 microtask 排队且最多运行一次。取消时必须先让 `AbortSignal.aborted`
   可观察，再执行可能重入用户代码的 listener cleanup；一旦 `err()` 非 null，`done()` 必须已是 terminal，且
   `AbortSignal.reason` 必须与 `err()` 返回的稳定哨兵对象同一。
9. `cause()` 必须先读取外层 `err()`；若为 `null`，立即返回 `null` 且不得读取私有 value key。只有外层已终止时，
   才使用模块私有 key 经 `value(key)` 穿过 structural wrapper，保持最内层取消原因 identity；
   `withoutCancel()` 必须截断该 key。该能力不增加公共导出。内建取消链必须以迭代队列传播，至少 20,000 层
   `withCancel` 从根同步取消时不得耗尽 JavaScript 调用栈，且返回前最深后代必须可观察为 terminal。若用户在
   父级 abort listener 内重入构造 `withCancel*`、`withDeadline*` 或 `withTimeout*` child，注册期已经终止的
   父级必须在构造返回前同步 settle child；该路径不得等待队列尾部或为已取消 child 建立 deadline timer。
   每个显式 CancelFunc 即使从另一取消 listener 中重入，也必须在返回前完成自己的独立同步取消波次。波次中的
   cleanup 必须按后代先于祖先的后序关系执行，同时保持同一 Context 内的注册顺序；嵌套自身 timer 因此按
   子 timer、父 timer 的顺序调用 `clearTimeout`，与 Go 的递归 child cancel 再停止自身 timer 一致。
10. 无 deadline 的第一个返回值使用 Go zero time 对应的 `0001-01-01T00:00:00.000Z`；`withValue` 在 parent
    校验后拒绝 `null` 和 `undefined` key。其他 key 使用 JavaScript identity，明确属于宿主映射。

### `@likego/core`

```ts
export interface Server<H extends ServerHandle = ServerHandle> {
  start(ctx: Context): Promise<H>
}

export interface ServerHandle {
  done(): Promise<void>
  stop(ctx: Context): Promise<void>
}
```

根导出还包括 `App`、`AppHandle`、`AppDiagnostics`、`AppStatusSource` 类型，`newApp`、`name`、
`server`、`hardDrainTimeout` 选项函数，以及 `ServerAlreadyStartedError`、`UnexpectedExitError`、
`DrainTimeoutError`。`Server` 接口与 `server(...)` 选项函数分别遵循类型和值的命名规则，并由类型测试锁定。

`waitForContext(ctx, operation)` 只从 `@likego/core/lifecycle` 子路径导出；Context 必须是首参。它只约束
调用方的等待过程，不中止或修改 operation。

`AppHandle` 可扩展基础 handle，并提供 `diagnostics()` 与只读 `status()`；endpoint、readiness 和 health
不进入基础 `ServerHandle`。

Core 默认给整个 App 的逆序排空一个共享 `30_000ms` 单调总预算，并给每个 Server 一个默认
`30_000ms` 局部预算；实际 deadline 取两者较早值，后处理的 Server 只能使用 App 剩余预算。
`hardDrainTimeout` 直接传给 `newApp(...)` 时设置总预算，传给 `server(...)` 时设置局部预算。能够通过安全公开原生 API 强制收敛的常驻适配器，
默认在 `25_000ms` 尝试自己的 force，为 supervisor 留出终态传播和清理余量；适配器不能依赖两个相同
deadline 计时器的插入顺序。没有可信 force 的适配器不得把 timeout 当作 native terminal，稳定 `done()`
必须保持 pending，最终由 Core 报告 orphan。应用覆盖已有 adapter 边界时，App 总预算必须
严格更大，并由组合生命周期测试证明实际终态或 timeout 证据先于 App 的孤儿分类发生。

### `@likego/web`

- 根入口导出标准单参数 `Handler`，以及 `ContextHandler`、`ContextHandlerOptions`、`contextHandler`。
- `Handler` 始终只有一个 `Request` 参数；Context 只能通过显式桥接进入。
- `@likego/web/health` 提供探针 HTTP Handler；`@likego/web/node` 提供 Node listener lifecycle；
  `@likego/web/node/testing` 只提供 Node host 测试接缝。
- Web 框架拥有 router、middleware 和 response mapping；LikeGo 不定义第二套路由 API。

### `@likego/transport` 与 `@likego/transport-http`

- `@likego/transport` 根入口定义内部微服务通信的 `Transport`、`Client`、`Listener`、`Socket`、`Message`
  与 options；`./headers` 固定 `Likego-` wire header，`./testing` 提供 provider conformance。
- `@likego/transport-http` 根入口同时提供标准 Fetch unary client、注入式 `HTTPHost` listener server 和
  Core lifecycle `newHTTPServer`；`./node` 提供真实 Node HTTP Server，`./testing` 复用公共 conformance。
- Transport 与 Web 的 handler/ownership 语义独立，二者不相互重导出。

### `@likego/health`

- `ProbeRegistry.check(ctx, kind)`，Context 是首参。
- HTTP 路由不在本包。`createHealthHandler(...)` 从 `@likego/web/health` 返回标准 `Handler`。
- `registerAppProbes(registry, statusSource)` 使用显式 `AppStatusSource`，不对基础 handle 使用鸭子类型判断。

### `@likego/testing`

根路径只导出与运行器无关的 case 和 harness 类型；Server 一致性能力从 `@likego/testing/server` 子路径导出，
listener 一致性能力从 `@likego/testing/listener` 子路径导出。任何生产依赖都不能引用 testing；仅测试图可以
通过 devDependency 使用它。

## 后果

- 临时原型只能复用测试意图，不能直接复制公共接口形态。
- 公共 API 允许列表、正向/负向类型 fixture 和 tarball 导出 smoke 是发布门禁。
- 任何新增根导出都必须先更新本 ADR、类型 fixture 与包导出测试。

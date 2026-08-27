# ADR 0005：操作级韧性必须保持显式

## 状态

v1 已接受。

## 背景

Kratos 通过 middleware 提供 circuit breaker 与 rate limiter，而 go-micro 提供 client retry 与 backoff
策略。这些行为对使用标准 Fetch 的 TypeScript 服务仍然有价值，但通用 RPC client 或隐式 Fetch
middleware 必须猜测请求体能否重放，以及操作是否具备幂等性。

go-like 还要求 Context 保持为独立首参，并要求 portable production code 只使用 ECMAScript 与标准 Web API。

## 决策

`@go-like/resilience` 提供三个相互独立、作用于操作范围的 primitive：

- `retry(ctx, operation, options)` 要求显式提供 `idempotent` 或 `caller-approved` 授权、有限的 attempt
  count，以及由调用方拥有的 failure predicate。`exponentialBackoff` 提供有界 delay policy。Context
  取消会停止新 attempt 的准入，并释放活动中的 backoff timer。
- `newCircuitBreaker(options)` 返回一个由 closure 持有状态的普通对象，包含 closed、open 与 half-open
  三种状态。连续失败会打开 circuit；reset timeout 结束后只允许一个 probe；调用方可以将 rejection
  identity 与不可变的 `circuitOpen` sentinel 比较。由调用方拥有的 classifier 决定哪些 rejected
  operation 计为依赖失败。
- `newTokenBucketLimiter(options)` 返回一个非阻塞、Context-first 的 limiter。Token 使用标准单调时钟
  `performance.now()` 惰性 refill；`allow(ctx)` 会消耗一个 token，或返回明确的 retry delay。Limiter
  不创建后台 timer，因此不存在隐藏的常驻 lifecycle。

调用侧只增加两个薄适配器：

- `@go-like/client` 的 `circuitBreakerMiddleware(options)` 在 middleware 闭包中按已安装的 canonical
  `service/endpoint` operation 懒建 breaker。它包围一次完整逻辑调用，所以显式 retry 的多个 attempt 只记录
  一个 outcome；open 时不会进入 Discovery、Selector 或 Transport I/O。Context 取消保持中立，表示业务交换
  已完成交换的原生 `AggregateError` 固定记为健康；response 位于 `cause`，后置错误按顺序位于 `errors`。
- `@go-like/server` 的 `rateLimitMiddleware(limiter)` 一个实例只使用调用方传入的一个 limiter，与 Kratos Server
  middleware 的共享策略一致。拒绝时返回 canonical `rate_limited`、HTTP 语义状态 429 和
  `retryAfterMs`。需要按 operation 隔离时，由 `use(selector, ...)` 组合不同 limiter 实例。

该 package 不调用 Fetch、不 clone `Request`、不缓存请求体、不选择端点，也不转换 `Response`。授权 retry
的 Fetch 调用方必须在每次 retry operation 内构造全新的 `Request`。go-like 不会重放 streaming body 或
其他无法重新构造的请求体。

有状态 factory 返回结构化的冻结对象，`exponentialBackoff` 则返回无状态的 callable policy。契约不包含
class、decorator、reflection、ambient context、runtime-specific global 或 vendor client。

## 并发与失败语义

Circuit 准入携带内部 generation。早于新状态转换获得准入的调用，其 outcome 不能关闭或重新打开这个较新
generation。Reset duration 使用标准单调时钟 `performance.now()`，因此 wall-clock 调整不会延长或缩短
open 区间。Context 取消对 breaker health 保持中立，并释放 half-open probe。

Failure classifier 抛出的错误会计为 breaker failure，因为此时无法安全判断依赖结果。被 classifier 判定
为 `false` 的 rejection 属于一次健康的 breaker observation：它会重置 closed circuit 的连续失败计数，
并关闭一次成功的 half-open probe，同时仍向调用方保留原始 rejection。

Token-bucket decision 是同步且非阻塞的。Wall-clock 调整不能凭空生成 token。完整的 refill interval 会在
下一次 `allow` 或 `snapshot` 调用时应用，且不会超过 capacity。

当 predicate 拒绝 retry 或 attempt bound 耗尽时，Retry 会保留原始 operation rejection。Policy failure
仍以 policy failure 的形式对外可见。在新 attempt 开始前或 backoff wait 期间，终态 Context error 具有
更高优先级。

## 后果

应用可以围绕 Fetch 调用、registry selection、broker operation 或其他任意 Context-aware operation 显式
组合 primitive；内部 unary Client/Server 则使用上述薄 middleware。代价是有意保留的显式性：调用方必须
自行声明幂等性、failure classification、attempt bound 与 `Request` 重建方式。go-like 不移植 Kratos 的
概率型 SRE breaker、BBR、CPU sampler 或完成反馈协议，也不把 token bucket 冒充这些算法。

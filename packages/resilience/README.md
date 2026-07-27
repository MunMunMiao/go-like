# @likego/resilience

面向 LikeGo 服务、可移植且感知 Context 的韧性原语。

该包提供：

- 需要显式授权、有次数上限且由调用方判定重试条件的 retry。
- 设有上限的指数退避。
- 按连续失败计数、只允许单次半开探测的熔断器。
- 惰性补充、非阻塞的令牌桶限流器。

它不会导入 Fetch、克隆请求、缓冲请求体、选择端点或拥有后台 worker。应用必须在每次 retry 操作内
构造新的输入，并继续负责判断重放是否安全。

```ts
import { background } from "@likego/context"
import {
  exponentialBackoff,
  newCircuitBreaker,
  newTokenBucketLimiter,
  retry
} from "@likego/resilience"

const ctx = background()
const backoff = exponentialBackoff({ initialDelayMs: 25, maxDelayMs: 500 })

const value = await retry(
  ctx,
  async (_attemptContext, attempt) => {
    return `attempt-${attempt}`
  },
  {
    authorization: "idempotent",
    maxAttempts: 3,
    shouldRetry: async (_attemptContext, failure) => failure instanceof TypeError,
    backoff
  }
)

const breaker = newCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1_000 })
const protectedValue = await breaker.execute(ctx, () => value)

const limiter = newTokenBucketLimiter({
  capacity: 10,
  refillTokens: 10,
  refillIntervalMs: 1_000
})
const decision = limiter.allow(ctx)

void [protectedValue, decision]
```

所有操作都会保留调用方的值与错误标识同一性。Context 取消或截止时间到期始终优先于 retry、熔断器与
限流接纳结果。

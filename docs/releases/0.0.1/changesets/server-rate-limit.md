---
"@likego/server": patch
---

增加复用 `@likego/resilience` RateLimiter 的 unary Server middleware，并通过 operation middleware
显式组合独立限流 bucket。

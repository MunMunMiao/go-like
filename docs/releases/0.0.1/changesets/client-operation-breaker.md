---
"@go-like/client": minor
---

增加按 canonical `service/endpoint` operation 隔离的 `circuitBreakerMiddleware`。熔断器观察完整逻辑调用，
open 时在发现与传输 I/O 前拒绝；Context 取消保持中立，已完成业务交换的 cleanup `AggregateError`
保持健康并原样抛回。

---
"@likego/registry": minor
"@likego/client": minor
---

扩展 selector feedback 的 `SelectionOutcome`，对齐 Kratos `DoneInfo` 的响应 metadata 与
send/receive 阶段事实；Client 按真实 unary attempt 时序发布不可变反馈，内置 selector 继续只使用
`error` 更新健康度。

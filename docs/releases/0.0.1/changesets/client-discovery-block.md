---
"@go-like/client": minor
---

增加可选的 `withBlock()` discovery wait-for-ready。它只等待服务首次出现原始 endpoint；调用 Context
独立限制每个 waiter，Client 关闭会唤醒等待者，而首次就绪后的空快照继续权威 fail closed。

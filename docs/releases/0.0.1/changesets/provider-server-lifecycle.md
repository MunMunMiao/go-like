---
"@go-like/broker": minor
"@go-like/bullmq": minor
"@go-like/event": minor
"@go-like/nats": minor
---

将 Broker、NATS Core/JetStream、BullMQ Worker 与 Event adapter 收敛为
`Server.start(ctx): Promise<void>` / `stop(ctx): Promise<void>`，删除公共 Handle、`done()` 与通用
hard-drain timeout；Broker 的 `Subscriber` 仅表示 go-micro 风格的订阅句柄，生命周期适配统一使用
`newBrokerServer(...)`。仅在底层 SDK 无法接受 `AbortSignal` 时保留 provider 专属关闭超时。

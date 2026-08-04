---
"@go-like/broker-memory": patch
---

增加进程内 exact-topic Broker provider，支持广播、每订阅 FIFO、并行订阅处理、Context-first 排空与
`newBrokerServer` 生命周期接入；不增加 queue、持久化、ack、Event Store 或 replay 语义。

---
"@likego/broker": patch
"@likego/broker-memory": patch
"@likego/broker-rabbitmq": patch
"@likego/nats": patch
---

让 Broker provider 的被动终止与 handler 失败进入现有 `Server.start()` 终态，同时保持 go-micro 风格
`Subscriber` 只有 `topic` 与 `unsubscribe(ctx)`。RabbitMQ `basic.cancel` 改为可由 owner stop 打断的
有界退避恢复；恢复期间的再次取消会触发下一轮恢复，旧 generation 迟到的取消不会重复创建 consumer，
恢复耗尽也不再延迟到手动 unsubscribe 才报告。订阅接纳会先捕获 `unsubscribe` owner，再校验
返回 topic；畸形或 hostile provider metadata 会使用独立 Context 回滚，且保留 primary/rollback 失败顺序。

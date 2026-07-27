---
"@likego/broker-rabbitmq": minor
---

新增 borrowed `ConfirmChannel` Broker，并让 recovering Broker 的每个 generation 使用 publisher confirms；
publish 在对应 broker ack 后保留原 flow-control boolean，nack 或 channel close 时拒绝。Publisher confirm
不提供 exactly-once，需要业务级去重时仍应使用幂等键或 outbox。

# @likego/event

`@likego/event` 是 `@likego/broker` 之上的显式 typed codec 层。包直接定义最小
`Codec<T> { mediaType, encode, decode }`，不要求应用采用特定 schema 库。publish 使用 codec 编码
detached bytes；subscribe 只包装 delivery，直到应用调用 `decode()` 才执行解码。
`decode()` 要求 delivery 只携带一个大小写不敏感的 `content-type` header，且值与 codec 的
`mediaType` 完全一致；不匹配时不会把字节交给 codec。

解码失败时，`EventMessage.native` 仍保持底层 NATS `Msg` 或 JetStream `JsMsg` 的原始 identity，应用自行决定 `nak`、`term` 或不 ack。包不创建 Broker connection，也不决定重投、DLQ、durable consumer 或 MaxDeliver。

`eventBroker(...)` 返回 typed `EventBroker`；它直接声明 `subscribe(...)`，并返回底层
provider 的同一个 `Subscriber` handle。需要接入应用生命周期时，直接把它传给
`@likego/broker` 的 `newBrokerServer(...)`，不再学习第二套 Event 生命周期入口。

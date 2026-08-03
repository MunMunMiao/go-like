# 消息与事件

`@likego/broker` 定义 Context-first 的 bytes/topic publish 与 subscribe SPI。每条 delivery 都保留 provider 的原生消息，因为 ack、nak、term、重投、durable consumer 和死信队列是具体 broker 的语义，硬压成一套公共方法只会丢信息。

`@likego/event` 是可选的 typed codec 层。发布时编码成独立 bytes，订阅时不急着解码，只有业务调用 `decode()` 才做 schema 校验。即使解码失败，原生 NATS `Msg` 或 JetStream `JsMsg` 仍然在，应用照样能选择正确的确认方式。

`Broker.subscribe(ctx, topic, handler)` 返回带有 `unsubscribe(ctx)` 的 provider `Subscriber`。`newBrokerServer(...)` 把 `Broker` 接入 Core `Server` 契约：`start(ctx)` 表示完整运行期，`stop(ctx)` 请求停止。LikeGo 负责停止已经接纳的 subscription，但从不拥有 connection、stream 或 durable consumer；启动取消会回滚已创建但尚未接纳的 subscription。

`@likego/broker-rabbitmq` 的推荐入口使用 `amqplib@2` 官方 recovery setup：应用仍拥有 connection，
LikeGo 在每次连接恢复后重放仍活跃订阅的 exchange、queue、binding、QoS 与 consumer。稳定
`Subscriber` 一旦取消就不会复活；`broker.ack/nack/reject(event.native)` 只会操作产生该 delivery 的
channel generation。需要完全自行管理连接恢复时，也可以使用显式的 borrowed-channel 入口。

需要事件广播和投递语义时用 Broker；需要 BullMQ 自己那套 job、retry、backoff、token 与 Worker 行为时就用 `@likego/bullmq`。两者并不相同，适配器也不该为了 API 看起来统一而把差异藏起来。

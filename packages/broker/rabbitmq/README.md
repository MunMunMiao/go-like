# @likego/broker-rabbitmq

LikeGo 的 RabbitMQ AMQP 0-9-1 Broker provider，基于官方生态维护的 `amqplib`。

推荐入口 `newRecoveringRabbitMqBroker(ctx, connector)` 把 setup callback 交给应用的
`amqplib.connect(..., { recovery: { setup } })`。它返回稳定 Broker 和应用拥有的
`RecoveringChannelModel`；每次恢复会新建内部 generation `ConfirmChannel`，并重放仍活跃订阅的 topology、
QoS 与 consumer。稳定 subscriber 一旦 `unsubscribe` 就不会在后续 generation 复活。该入口的
`await publish()` 在当前 generation 的 broker ack 后完成；nack 或 channel close 会拒绝发布。

内部 channel 没有独立公共 stop 契约：setup/connector 失败时 provider 会回滚关闭；已接纳 generation 在
上游断线或应用关闭其 `RecoveringChannelModel` 时由 amqplib connection 从属关闭。因此 owner manifest 只
声明 provider 可独立停止的 consumer；应用拥有并负责关闭 connection。

`newConfirmRabbitMqBroker(channel)` 借用应用创建的原生 `ConfirmChannel`，提供与 canonical 入口相同的
per-publish confirm 语义，同时保留 amqplib flow-control boolean。调用方 Context 只能提前结束自己的等待；
迟到 confirm 仍会被观察。`newRabbitMqBroker(channel)` 则保留 plain `Channel` 逃生口，其 publish 结果只表示
amqplib flow control，不表示 broker 已确认。两个 borrowed 入口都不关闭 channel 或 connection。每次
`subscribe` 拥有且只拥有一个 RabbitMQ consumer，`unsubscribe(ctx)` 取消该 consumer 并等待已经接纳的
handler。订阅 admission 受调用方 Context 约束；取消后才完成的原生 consumer 会被异步清理。RabbitMQ
以 `basic.cancel` 取消 consumer 时，稳定 Subscriber 会在同一 channel 上重新声明 topology 并重新接入；
恢复过程中再次到达的 `basic.cancel` 会触发下一轮恢复，不会因当前恢复尚未完成而丢失；
已经被替换的旧 consumer 迟到发送 `basic.cancel` 时会被 generation fence 忽略，不会重复创建新 consumer；
重接最多尝试 6 次，退避从 25ms 增长到 400ms；`unsubscribe(ctx)` 会立即打断等待中的退避。恢复耗尽、
owner Context 终止或 handler 失败都会结束订阅，并通过既有 `newBrokerServer(...).start()` 运行期 Promise
报告。应用侧 `Subscriber` 仍只有 `topic` 与 `unsubscribe(ctx)`。exchange、queue 与 binding 的生命周期
仍由应用通过原生配置决定。

`amqplib@2` 提供 opt-in connection recovery，但不会替应用重建 borrowed 入口传入的 channel。canonical
入口直接复用官方 setup/backoff，不另造重连循环；connection 的创建与关闭始终由应用负责。

Publisher confirm 不提供 exactly-once；需要业务级去重的发布仍应使用幂等键或 outbox。

`event.native` 是原始 `ConsumeMessage`。provider 不自动 `ack`、`nack` 或 `reject`。canonical 入口应调用
稳定 broker 的 `ack/nack/reject(event.native, ...)`，它只会路由到产生该 delivery 的 generation；断线后的
旧 delivery 会 fail closed，绝不会确认到新 channel。borrowed 入口也可使用相同辅助方法，或直接操作传入的
原生 channel。

`topic` 默认作为 publish routing key；未配置 exchange 的订阅默认声明同名 queue。配置 exchange 时，可同时
指定 exchange type/options、queue options、routing key、binding arguments、prefetch 和原生 consume options。
配置 exchange 但完全未配置 queue 时，provider 使用 RabbitMQ server-named queue，并默认
`durable: false, exclusive: true, autoDelete: true`，避免遗留无人持有的匿名 queue。

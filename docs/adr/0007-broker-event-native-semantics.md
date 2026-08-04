# ADR 0007：Broker、Event 与原生消息语义

日期：2026-07-21

状态：消息语义已接受；生命周期入口已更新

> Broker/Event 的数据面和原生消息所有权决策仍有效。`subscribe(...)` 直接返回上游式 `Subscriber`
> handle；需要 Core 生命周期时使用 `newBrokerServer(...)`，不再发布 `eventSubscription(...)` 或第二套
> Event 生命周期入口。

## 背景

go-micro 与 go-zlab/go-kratos 都提供 Broker 及多种消息后端。消息系统在 publish/subscribe 之外，还存在
ack、nak、term、DLQ、durable consumer、redelivery、queue group 和事务等彼此不等价的语义。把这些能力塞进
一个“看起来通用”的接口会迫使 provider 伪造行为，并隐藏真正的数据面所有权。

go-like 第一版需要一个可移植的 bytes/topic 边界，以及建立在它上面的显式 typed codec 层；供应商原生事件
必须完整保留，应用才能按真实 provider 语义做 settlement。

## 决策

### Broker SPI

`@go-like/broker` 定义泛型 `Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent>`：

- `publish(ctx, topic, message, options?)` 和 `subscribe(ctx, topic, handler, options?)` 都以 Context 为独立首参。
- `BrokerMessage` 只有不可变 headers 与 detached `Uint8Array` body。
- `BrokerEvent` 保留 topic、bytes message 和原生 `native` 对象。
- `Broker` 直接声明 subscribe；subscribe 返回的 `Subscriber` 只保留上游式 `topic` 与
  `unsubscribe(ctx)`，它不代表 broker connection。
- `newBrokerServer(...)` 把 `Broker` 或 typed `EventBroker` 的一次 subscribe 接入 Core Server 生命周期，不创建、
  关闭或重连底层 connection。

公共 SPI 不定义 ack、nak、term、commit、transaction、DLQ、retry 或 consumer offset。provider 原生对象仍是
这些行为的唯一权威。

### Event typed 层

`@go-like/event` 使用显式 `Codec<T>` 包装 Broker：

- publish 在调用 provider 前编码一次，并传递 detached bytes 和固定 content-type。
- subscribe 在收到 delivery 时只复制 bytes；应用调用 `decode()` 时才执行一次新的防御性副本解码。
- schema/codec 失败不能丢失 `native` identity；应用仍可对原生 NATS `Msg`、JetStream `JsMsg` 或其他事件
  执行正确的 settlement。
- typed `EventBroker` 直接声明 subscribe，并原样返回底层 `Subscriber` handle；需要生命周期时直接交给
  `newBrokerServer(...)`，不再创建 Event 专属入口。

Event 不建立 codec registry，不从 topic 猜 schema，也不自动捕获、吞掉或重试 handler failure。

### NATS provider

`@go-like/nats/broker` 和 `@go-like/nats/jetstream/broker` 将官方 NATS API 投影到公共 Broker：

- Core NATS 保留 at-most-once、queue group、原生 `Msg` 与官方 drain/closed 语义。
- JetStream 保留 PubAck、`JsMsg`、durable consumer、ack/nak/term、MaxDeliver 与 redelivery 语义。
- 应用拥有 `NatsConnection`、JetStream manager、stream 和 durable consumer；go-like 只拥有一次订阅。
- provider-specific options/result/native type 通过泛型公开，不压扁成无法表达真实能力的布尔字段。
- lifecycle Server 接收应用直接持有的原生资源或 start-time factory；Broker 入口则从借用的 Core connection
  创建 Subscription，或通过应用工厂取得 JetStream ConsumerMessages。两类入口不应混写成“只接入现成订阅”。

### Memory provider

`@go-like/broker-memory` 提供 exact-topic、进程内广播：

- 每个订阅按 publish admission 顺序串行消费，不同订阅并行；无订阅时 publish 成功。
- `native` 固定为 `null`，不发明 ack、sequence 或 durable identity。
- 每个 delivery 独立复制 headers 与 body；publish 等待本次已接纳的 delivery。
- `unsubscribe(ctx)` 先移除订阅，再等待已接纳 handler；调用方取消只放弃该次等待，不取消共享 drain。
- handler failure 保留 Error identity、终止该订阅且不影响其他订阅继续执行。

它不实现 queue group、wildcard、buffer、持久化、重投或跨 worker/进程共享。

### 错误、取消与所有权

调用 Context 只限制 publish、subscribe admission 或 handler scope。已经成功接纳的 subscription cleanup 由其
owner Context 管理，caller 取消不能让远端订阅处于未知状态。原生 Error 保留 identity；配置包含凭据时，
provider 错误必须阻止 URL、header、token 和嵌套 cause graph 泄露。

- start-time factory 或 Broker admission 已取得、但尚未接纳的原生资源，必须在 Context 取消后调用
  `unsubscribe()` 或 `stop()` 回滚，并等待原生 terminal 或明确 hard bound；直接传入 lifecycle Server 的资源在
  接纳前仍归应用，启动失败不得擅自停止。
- 首次 `stop(ctx)` 启动唯一 owner stop；每个调用方 Context 只限制自身等待。Server 的 `start(ctx)` Promise
  保持运行，直到 unsubscribe 和原生 terminal 真正收敛。
- owner stop 前的被动退出形成稳定的 typed lifecycle error；handler failure 复用已有 owner stop，不创建第二条
  drain 路径。
- 单一原生 Error 保留 identity；admission、handler、graceful、force 与 terminal 的独立失败按主错误优先、观察
  顺序组成 `AggregateError`。

Broker/Event 不拥有 retry、backoff、breaker 或幂等判断。需要这些能力时，应用显式组合
`@go-like/resilience`，并对 provider 的交付保证负责。

## 验证要求

公共包使用 fake 只验证不可变性、泛型传递、lazy decode、native identity 和生命周期边界。Memory Broker 使用
真实进程内并发、Context 与发布态 Bun/Node/Deno 验证，不启动没有第三方服务的 Docker。NATS provider 必须在
固定 digest 的真实容器中验证 Core 与 JetStream round trip、queue group、unsubscribe/drain、PubAck、ackAck、
非法 payload 后应用显式 nak/term、故障恢复，以及 stream、consumer、subscription、connection、container 和
network 零残留。RabbitMQ provider 必须在固定 digest 的真实容器中验证 publish/consume、ack/nack/reject、
connection restart 后 topology/consumer recovery、delivery generation 隔离、unsubscribe，以及 container 和
network 零残留。启动取消还必须分别证明 factory 创建的未接纳资源已回滚、直接传入的应用资源仍可使用，且
connection、stream 与 durable consumer 没有被越权删除。

## 后果

go-like 具备与被调研框架同角色的 Broker/Event 组合，但不会以统一接口牺牲消息系统真实语义。新增 Kafka、
Redis Streams 或其他 provider 时，可以复用 bytes/topic 生命周期契约，同时通过泛型和 `native`
保留各自的 settlement 与 delivery model。

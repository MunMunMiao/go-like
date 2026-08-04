# `@go-like/nats`

根入口与 `./jetstream` 把官方 NATS Core `Subscription` 和 JetStream `ConsumerMessages` 接入 go-like 结构化
`Server` 生命周期；Broker 子路径从应用借用的 connection/client 创建一次订阅，并投影为 `@go-like/broker`。
本包不创建或关闭连接、stream、durable consumer，也不接管确认、重试、死信和编解码策略。

## 导出布局

- `@go-like/nats`：管理官方 `@nats-io/transport-node` 的原生 `Subscription`；
- `@go-like/nats/broker`：从借用的 `NatsConnection` 创建并拥有一次 Core Subscription；
- `@go-like/nats/jetstream`：管理官方 `@nats-io/jetstream` 的原生 `ConsumerMessages`；
- `@go-like/nats/jetstream/broker`：从借用的 JetStream client 与应用 factory 取得并拥有一次
  ConsumerMessages。

四个入口都保留官方 SDK 类型和 Error identity。应用拥有数据面与连接；go-like 只在资源成功接纳后拥有对应的
终止操作。Broker subscription 使用 go-micro 风格的 `unsubscribe(ctx)`；handler 失败复用同一个 owner
unsubscribe，不创建第二条 drain 路径，也不公开 terminal handle。
Broker provider 会通过 `@go-like/broker/provider` 关联已有 completion；因此被动原生终止或 handler
失败会拒绝 `newBrokerServer(...).start()`，但应用侧 `Subscriber` 仍然只有 `topic` 与
`unsubscribe(ctx)`。

## NATS Core：`@go-like/nats`

应用使用官方 SDK 配置连接、subject、queue group，并自行迭代原始 `Msg`：

```ts
import { newApp, server } from "@go-like/core"
import { newNatsCoreServer } from "@go-like/nats"
import { connect } from "@nats-io/transport-node"

const connection = await connect({ servers: "nats://127.0.0.1:4222" })
const subscription = connection.subscribe("orders.created", { queue: "billing" })
const app = newApp(server(newNatsCoreServer(subscription)))
const running = app.run()

const messages = (async () => {
  for await (const message of subscription) {
    await processOrder(message.data)
  }
})()

await app.stop()
await running
await messages
await connection.drain()
```

也可提供无参工厂，让原生订阅在 `start()` 时创建：

```ts
const subject = newNatsCoreServer(() =>
  connection.subscribe("orders.created", { queue: "billing" })
)
```

工厂不接收 go-like `Context`，因此不会把 Context-first handler ABI 注入官方 NATS 数据面。应用仍负责
`NatsConnection.subscribe()`、subject、queue group、消费循环、错误隔离、并发、重试、发布，以及连接自身的
`drain()` / `close()`。

### Core 公共 API

运行时只导出：

- `newNatsCoreServer(source, ...options)`；
- `natsCoreDrainTimeout(milliseconds)`。

`source` 是官方 `Subscription`，或返回 `Subscription | PromiseLike<Subscription>` 的无参工厂。类型入口同时导出
`NatsCoreSubscriptionSource`、`NatsCoreSubscriptionFactory` 与 lifecycle error 类型。

### Core 生命周期契约

- Server 只能启动一次；第二次 `start()` 返回 `NatsCoreAlreadyStartedError`。
- `start(ctx)` 在接纳完成后继续阻塞，直到原生订阅终止；`stop(ctx)` 位于 Server 本身，不返回额外 handle。
- 预先取消的启动不会调用工厂。工厂在取消后迟到返回，或在最终接纳检查失败前已经返回的订阅，会被
  `unsubscribe()` 回滚。
- 直接传入的 `Subscription` 在最终接纳前始终由应用持有；启动取消或失败不会对它调用
  `drain()` 或 `unsubscribe()`。
- 首次 `stop(ctx)` 启动唯一共享 owner stop。每个调用方 Context 只能放弃自己的等待，不会取消共享 drain。
- 正常停止调用官方 `Subscription.drain()`，并观察官方 `Subscription.closed`。
- 默认 provider 边界为 25 秒。官方 `Subscription.drain()` 不接受 `AbortSignal`，因此
  `natsCoreDrainTimeout` 到期后 `stop(ctx)` 以 `NatsCoreDrainTimeoutError` 结算，并只对当前订阅调用
  `unsubscribe()`；不会关闭应用连接。
- provider timeout 不会伪造 `closed`。`start(ctx)` 的运行期 Promise 仍等待 drain 与官方 `closed` 结算。
- 超时后迟到的 drain/closed 失败进入运行期 Promise 的最终 Error 或有序 `AggregateError`，原生 Error
  identity 保留。
- owner stop 前被动关闭的订阅由运行期 Promise 报告 `NatsCoreUnexpectedExitError`。

## JetStream：`@go-like/nats/jetstream`

应用使用官方 SDK 创建 stream、consumer 和 `ConsumerMessages`，并自行处理原始 `JsMsg`：

```ts
import { newApp, server } from "@go-like/core"
import { newNatsJetStreamServer } from "@go-like/nats/jetstream"
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream"
import { connect } from "@nats-io/transport-node"

const connection = await connect({ servers: "nats://127.0.0.1:4222" })
const client = jetstream(connection)
const manager = await jetstreamManager(connection)

await manager.consumers.add("EVENTS", {
  durable_name: "events-worker",
  name: "events-worker",
  ack_policy: AckPolicy.Explicit,
  filter_subject: "events.created"
})

const consumer = await client.consumers.get("EVENTS", "events-worker")
const messages = await consumer.consume({ max_messages: 1 })
const app = newApp(server(newNatsJetStreamServer(messages)))
const running = app.run()

const processing = (async () => {
  for await (const message of messages) {
    await processEvent(message.data)
    await message.ackAck()
  }
})()

await app.stop()
await running
await processing
await connection.drain()
```

也可提供返回 `ConsumerMessages | PromiseLike<ConsumerMessages>` 的无参工厂。工厂同样不接收 go-like `Context`。

### ack、重投递与 DLQ 属于应用

适配器不会调用 `ack`、`ackAck`、`nak`、`working` 或 `term`，也不会替应用选择 `MaxDeliver`。例如
“DLQ 发布成功后再终止重投递”的顺序应由应用明确实现：

```ts
for await (const message of messages) {
  if (message.info.deliveryCount >= 3) {
    await client.publish("events.dlq", message.data, {
      msgID: `events-dlq:${message.info.streamSequence}`
    })
    message.term("application dead-lettered after PubAck")
    continue
  }
  await processEvent(message.data)
  await message.ackAck()
}
```

### JetStream 公共 API

运行时只导出：

- `newNatsJetStreamServer(source, ...options)`；
- `natsJetStreamCloseTimeout(milliseconds)`。

`source` 是官方 `ConsumerMessages`，或返回该原生对象的无参工厂。类型入口同时导出
`NatsJetStreamMessagesSource`、`NatsJetStreamMessagesFactory` 与 lifecycle error 类型。

### JetStream 生命周期契约

- Server 只能启动一次；第二次 `start()` 返回 `NatsJetStreamAlreadyStartedError`。
- `start(ctx)` 在接纳完成后继续阻塞，直到原生消息流终止；`stop(ctx)` 位于 Server 本身。
- 预先取消的启动不会调用工厂。工厂在取消后迟到返回，或在最终接纳检查失败前已经返回的
  `ConsumerMessages`，会调用官方 `stop()` 回滚。
- 直接传入的 `ConsumerMessages` 在最终接纳前始终由应用持有；启动取消或失败不会对它调用
  `close()` 或 `stop()`。
- 首次 `stop(ctx)` 启动唯一共享 owner stop。调用方 Context 只能放弃自己的等待，不能取消共享 close。
- 正常停止调用官方 `ConsumerMessages.close()`，并观察官方 `closed()`。
- 默认 provider 边界为 25 秒。官方 `ConsumerMessages.close()` 不接受 `AbortSignal`，因此
  `natsJetStreamCloseTimeout` 到期后 `stop(ctx)` 以 `NatsJetStreamCloseTimeoutError` 结算，并对当前
  `ConsumerMessages` 调用官方 `stop()`；不会删除 durable consumer，也不会关闭 client 或 connection。
- provider timeout 不代表 iterator/`closed()` 已终止；`start(ctx)` 的运行期 Promise 仍等待 `close()` 与
  `closed()` 结算。
- 超时后迟到的 close/closed 失败进入运行期 Promise 的最终 Error 或有序 `AggregateError`，原生 Error
  identity 保留。
- owner stop 前被动结束的 `ConsumerMessages` 由运行期 Promise 报告
  `NatsJetStreamUnexpectedExitError`。

## 所有权边界

- `Subscription` 与 `ConsumerMessages` 都是 application-owned/native-borrowed、go-like-owned stop。
- 直接对象只在成功接纳后向 go-like 转移终止操作权；工厂创建但尚未接纳的临时对象允许 go-like 回滚。
- connection、client、stream、durable consumer、消息迭代和确认策略始终位于适配器边界之外。
- Broker 的 `unsubscribe(ctx)` 内部同样使用 25 秒 provider boundary：官方 `Subscription.drain()` 与
  `ConsumerMessages.close()` 都不接受 `AbortSignal`，到期后只强制当前原生订阅，不关闭借用的 connection
  或 client。该边界不对外暴露另一套 handle 或 hard-drain API。

## 运行时与上游声明边界

固定官方 `@nats-io/transport-node@3.4.0` 与 `@nats-io/jetstream@3.4.0`，并在 Bun 1.3.14、Node.js 24.18.1
和 Node.js 26.x 测试运行。

包内构建与测试设置 `skipLibCheck: true`；根配置仍为 `false`。TypeScript 7.0.2 检查固定版本
`@nats-io/nats-core` 时会命中 `MsgImpl.headers` / `Msg.headers` 与 `NatsConnectionImpl.info` /
`NatsConnection.info` 两个已知 `TS2420`。发布包类型测试会精确匹配这些诊断，再使用官方原生类型执行
consumer 检查；不得用 go-like facade 掩盖上游声明问题。

## 验证

```sh
bun run typecheck
bun run test:unit:coverage
bun run build
bun run test:e2e:suites -- --suite nats-core-docker
bun run test:e2e:suites -- --suite nats-jetstream-docker
```

两条 Docker 测试都从实际安装的官方 SDK `package.json` 读取版本，并使用固定 digest 的 NATS Server 2.14.4。
Core 场景定义原始消费、queue group、失败隔离、重连、factory 启动取消回滚与 direct Subscription 保留；
JetStream 场景定义 `ackAck`、`MaxDeliver`、DLQ PubAck→term、重连消费、factory 启动取消回滚与 direct
ConsumerMessages 保留。

# @go-like/nats

NATS Core 与 JetStream 的 `Broker` 和 `Subscriber`。应用持有连接或 JetStream 客户端。本包不提供只管生命周期的 Server；连接的排空用 `@go-like/core/lifecycle` 的 `newResourceServer`。

## 入口

| 入口                      | 填充的插座             | 关键导出                                                                     |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `@go-like/nats/broker`    | `Broker`、`Subscriber` | `newNatsCoreBroker`、`NatsCoreBroker`、`natsCoreDrainTimeout`                |
| `@go-like/nats/jetstream` | `Broker`、`Subscriber` | `newNatsJetStreamBroker`、`NatsJetStreamBroker`、`natsJetStreamCloseTimeout` |

通道是 Node.js 与 Bun。没有根入口。

## 依赖

| 种类      | 包                        | 范围     | 说明                          |
| --------- | ------------------------- | -------- | ----------------------------- |
| peer      | `@go-like/core`           | `0.0.1`  | dev 依赖为 `workspace:*`      |
| 常规      | `@nats-io/transport-node` | `3.4.0`  | Core 连接                     |
| 可选 peer | `@nats-io/jetstream`      | `^3.4.0` | 只被 `./jetstream` 需要       |
| 开发      | `@types/node`             | `26.6.6` | 公开 `.d.ts` 不引用 Node 类型 |

开发依赖把 `@nats-io/jetstream` 钉在 `3.4.0`。

## 示例

```ts
import { newBrokerServer } from "@go-like/core/broker"
import { newResourceServer } from "@go-like/core/lifecycle"
import { newNatsCoreBroker } from "@go-like/nats/broker"
import { connect } from "@nats-io/transport-node"

const connection = await connect({ servers: "nats://127.0.0.1:4222" })
const broker = newNatsCoreBroker(connection)
const consumer = newBrokerServer(broker, "orders.paid", async () => {})
const connectionResource = newResourceServer({
  terminal: connection.closed(),
  close: () => connection.drain()
})
```

JetStream 用 `newNatsJetStreamBroker(client, messagesFactory)`。`messagesFactory` 决定消费哪些消息；传给 `newBrokerServer` 的 topic 是 span 名。确认仍在 `event.native` 上完成。

## 错误码

| 代码                                     | 类型                               | 入口          |
| ---------------------------------------- | ---------------------------------- | ------------- |
| `GO_LIKE_NATS_CORE_UNEXPECTED_EXIT`      | `NatsCoreUnexpectedExitError`      | `./broker`    |
| `GO_LIKE_NATS_CORE_DRAIN_TIMEOUT`        | `NatsCoreDrainTimeoutError`        | `./broker`    |
| `GO_LIKE_NATS_JETSTREAM_UNEXPECTED_EXIT` | `NatsJetStreamUnexpectedExitError` | `./jetstream` |
| `GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT`   | `NatsJetStreamCloseTimeoutError`   | `./jetstream` |

超时选项不是 `0..2147483647` 的整数时抛出 `RangeError`。连接或客户端缺少可调用方法时抛出 `TypeError`。

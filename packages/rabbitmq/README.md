# @go-like/rabbitmq

RabbitMQ 的 `Broker` 与 `Subscriber`。公开入口只有 `@go-like/rabbitmq/broker`。应用持有 `amqplib` 的 channel；运行时只做类型导入。

## 依赖

| 种类      | 包              | 范围     |
| --------- | --------------- | -------- |
| peer      | `@go-like/core` | `0.0.1`  |
| 可选 peer | `amqplib`       | `^2.3.1` |
| 开发      | `@types/node`   | `26.6.6` |

`@go-like/core` 的 dev 依赖是 `workspace:*`。开发依赖把 `amqplib` 钉在 `2.3.1`。通道是 Node.js 与 Bun。

## 示例

```ts
import { newBrokerServer } from "@go-like/core/broker"
import { newRabbitMqBroker } from "@go-like/rabbitmq/broker"
import type { Channel } from "amqplib"

declare const channel: Channel

const broker = newRabbitMqBroker(channel)
const consumer = newBrokerServer(broker, "orders", async () => {})
void consumer
```

确认通道用 `newConfirmRabbitMqBroker`。应用自己管理连接恢复时用 `newRecoveringRabbitMqBroker`。

## 错误码

本包不定义 `GO_LIKE_` 错误码。

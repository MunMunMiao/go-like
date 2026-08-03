# IoT Telemetry

这个可运行示例演示一个 NATS JetStream 遥测校验微服务：

- 原始遥测写入 `TELEMETRY_RAW`；
- Broker Subscription 作为一个普通 Core Server 接入 App 生命周期；
- 合法消息写入 `TELEMETRY_VALIDATED` 后确认原消息；
- 永久无效或达到重投阈值的消息写入 `TELEMETRY_DLQ` 后终止重投；
- 官方 NATS Client 负责连接、重连与 JetStream 协议。

## 运行

从仓库根目录执行：

```sh
docker compose -f examples/iot-telemetry/compose.yaml up -d
bun run --filter @likego/example-iot-telemetry start
```

程序默认连接 `nats://127.0.0.1:44222`，可通过 `NATS_URL` 覆盖。启动后会创建或复用三个
File Storage Stream 和 durable consumer，并输出 `LIKEGO_EXAMPLE_READY`。

停止程序后清理：

```sh
docker compose -f examples/iot-telemetry/compose.yaml down -v
```

## 目录

```text
src/
├── telemetry.ts  # v1 数据契约与业务校验策略
├── nats.ts       # subject 与 Broker 类型
├── processor.ts  # validated、重投、ack 与 DLQ 流程
├── runtime.ts    # JetStream 拓扑与 NATS Connection Server
├── worker.ts     # 把 Broker Subscription 适配为 Core Server
└── main.ts       # 创建 JetStream 资源并组装 App
test/
└── telemetry.test.ts
e2e/
└── docker.ts     # 真实 NATS、持久化、重投、重连与排空
```

`main.ts` 负责组合；消息校验与处理不写在入口文件。`newTelemetryServer(...)` 返回标准
`Server`，因此 App 对 Cron、Broker Worker、Web Server 或用户自定义 Server 使用同一生命周期接口。

## 消息流程

```text
Producer
   |
   v
TELEMETRY_RAW -> durable consumer -> LikeGo subscription Server
                                      |
                                      +-- valid -> TELEMETRY_VALIDATED -> ack raw
                                      |
                                      +-- transient -> delayed nak -> redelivery
                                      |
                                      +-- permanent/limit -> TELEMETRY_DLQ -> term raw
```

Raw v1 示例：

```json
{
  "schemaVersion": 1,
  "messageId": "msg_0189",
  "deviceId": "sensor_42",
  "sequence": "1042",
  "observedAt": "2026-07-23T08:15:30.000Z",
  "temperatureC": 23.4,
  "humidityPct": 58.2
}
```

交付语义是 at-least-once。Validated 事件使用稳定 `eventId`，但 JetStream 的 `Nats-Msg-Id`
只在配置的滚动 duplicate window 内去重；下游仍必须持久幂等，示例不声称 exactly-once。

## LikeGo 能力

| 能力         | 使用方式                                                          |
| ------------ | ----------------------------------------------------------------- |
| 应用生命周期 | `newApp(server(...))`、`app.run()`                                |
| Broker       | `@likego/broker` 的 `newBrokerServer(...)` 返回 Core Server       |
| NATS         | `@likego/nats/jetstream/broker` 适配官方 JetStream Client         |
| Context      | 传播取消、处理 deadline 与停止边界                                |
| 数据契约     | 应用内 TypeScript 类型、标准 JSON 与显式 required-field、范围校验 |

LikeGo 不重新实现 Cron 或消息系统；它只让这些长期运行组件实现统一 `Server.start/stop` 契约，再交给
App 管理。

## 验证

```sh
bun run --filter @likego/example-iot-telemetry typecheck
bun run --filter @likego/example-iot-telemetry test:unit
bun run test:e2e:examples
```

Docker E2E 使用固定 digest 的 NATS 2.14.4，真实验证 PubAck、explicit ack、DLQ、redelivery、
容器重启后的重连、File Storage 持久化和停止清理。

## 边界

- Stream、Consumer、retention、ack/nak/term 策略属于应用与 NATS SDK。
- 设备认证、MQTT/CoAP bridge、时序数据库、告警和设备管理不属于本示例。
- NATS 本地端口无认证，仅用于隔离开发；生产部署必须配置认证、TLS、权限和容量策略。

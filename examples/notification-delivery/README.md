# 通知投递

该示例演示通知投递微服务：标准 Fetch API 接收 email 或 SMS 消息，使用
`@go-like/resilience` 的显式幂等 retry 重试瞬时 provider 故障，并用 circuit breaker
阻止持续故障继续冲击下游。成功 receipt 随后通过 `@go-like/event` 编码并发布到
`@go-like/broker-memory`，消费者把结果投影到 `@go-like/store-memory`；`@go-like/winston`
记录标准 Web 请求完成日志并进入同一个 App 生命周期。

## 主要演示

- retry 必须声明 `authorization: "idempotent"`，且只重试明确分类的瞬时错误。
- circuit breaker 统计一次完整投递操作的连续失败，而不是悄悄无限重试。
- typed Event 不隐藏 codec，Memory Broker 的订阅由标准 Broker Server 生命周期持有。
- Memory Store 保存可查询的进程内 receipt 投影；它不是持久 Event Store 或 replay。
- 应用创建原生 Winston Logger，go-like 只包装请求日志和终态排空。
- `@go-like/context` 作为投递应用和 provider 操作的首个参数。
- 标准 Fetch Handler 与投递服务、Provider、运行入口分离。

## 业务不变量

- messageId 唯一绑定消息内容；完全相同的重放返回原 receipt，冲突内容失败。
- 每次投递最多尝试三次，只有瞬时 provider 错误允许重试。
- 连续两次完整投递失败后熔断，后续请求不得触达 provider。
- email 与 SMS 使用各自严格的目标地址格式，空正文不会进入 provider。

## 接口

`POST /v1/notifications/deliver`

```json
{
  "messageId": "message-1001",
  "channel": "email",
  "destination": "ops@example.test",
  "body": "Cold-room alarm"
}
```

## 文件结构

- `src/service.ts`：通知类型、输入校验、重试和熔断策略。
- `src/provider.ts`：幂等内存 Provider 与可控故障计划。
- `src/events.ts`：typed codec、Memory Broker consumer 与 Memory Store receipt 投影。
- `src/http.ts`：标准 Fetch 请求解码与响应映射。
- `src/main.ts`：组装并运行 go-like HTTP App；这是唯一直接执行入口。
- `test/main.test.ts`：重试上界、熔断、幂等冲突、校验和 HTTP 测试。

## 验证

```sh
bun run --filter @go-like/example-notification-delivery typecheck
bun run --filter @go-like/example-notification-delivery test:unit
```

本示例的 Provider、Broker 和 Store 都是明确的进程内实现，不发送真实邮件或短信，也不伪装持久化、重投、
DLQ 或跨进程消息能力，因此不需要 Docker。

## 直接运行

```bash
bun run --filter @go-like/example-notification-delivery start
```

看到 `GO_LIKE_EXAMPLE_READY` 后发起一次真实 HTTP 请求：

```bash
curl -i http://127.0.0.1:3000/v1/notifications/deliver \
  -H 'content-type: application/json' \
  -d '{"messageId":"demo-1","channel":"email","destination":"ops@example.test","body":"incident opened"}'
```

默认监听 `127.0.0.1:3000`，可用 `HOST`、`PORT` 覆盖。按 `Ctrl-C` 或发送 `SIGTERM` 停止。

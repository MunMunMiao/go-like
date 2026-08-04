# 药房处方发药

该示例演示处方发药的关键一致性边界：只有已签发处方可以发药，库存扣减
失败时处方仍保持 `issued`，成功请求重试不得重复扣减库存。

## 架构与职责

- `src/service.ts`：处方状态、发药与取消用例、内存仓储、库存网关及仅针对瞬时故障的有限重试。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一可执行入口，组合处方服务、HTTP Server 与进程信号。

## HTTP 接口

- `POST /v1/prescriptions/{prescriptionId}/dispense`
- `DELETE /v1/prescriptions/{prescriptionId}`

本示例验证库存失败边界和状态流转，不声明已接入药房库存系统或分布式事务。
库存扣减以 `requestId` 作为 gateway 幂等键：即使远端已经提交扣减但响应丢失，重试也不会重复扣减。
库存不足等业务失败不重试，只有 `PHARMACY_INVENTORY_TRANSIENT` 才进入最多三次的重试边界。

## 直接运行

```bash
bun run --filter @go-like/example-pharmacy-prescription start
```

程序预置处方 `rx-demo` 和 `drug-a` 库存。看到 `GO_LIKE_EXAMPLE_READY` 后执行发药：

```bash
curl -i http://127.0.0.1:3000/v1/prescriptions/rx-demo/dispense \
  -H 'content-type: application/json' \
  -d '{"requestId":"demo-1"}'
```

可用 `HOST`、`PORT` 覆盖监听地址；按 `Ctrl-C` 或发送 `SIGTERM` 停止。

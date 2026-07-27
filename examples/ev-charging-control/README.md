# 电动汽车充电控制

该示例演示电动汽车充电控制微服务：标准 Fetch API 接受充电会话，站点控制仓储在单个
原子操作中检查在线状态、连接器占用和功率容量，`@likego/health` 暴露可独立执行的 readiness。

## 主要演示

- `@likego/health` 聚合充电站可用性，全部离线时 readiness fail closed。
- `@likego/context` 作为充电与健康检查的首个参数。
- `@likego/web` 输出可挂载到任意标准 Fetch runtime 的 Handler。
- 充电规则、站点状态、HTTP 路由和进程生命周期按真实职责拆分。

## 源码结构

- `src/service.ts`：会话规则、连接器占用、站点功率准入和 readiness。
- `src/http.ts`：充电会话的标准 Fetch 路由。
- `src/main.ts`：唯一直接执行入口，启动并管理 Node HTTP Server。

## 业务不变量

- 一个站点的已分配功率不得超过额定容量。
- 同一连接器同时只能承载一个已接纳会话。
- 相同 `sessionId` 和完全相同内容的重试幂等；同 ID 不同内容必须拒绝。
- 离线站点不接受新会话；没有任何在线站点时 readiness 必须失败。

## 接口

`POST /v1/charging-sessions`

```json
{
  "sessionId": "session-1",
  "stationId": "station-1",
  "connectorId": "connector-1",
  "requestedKw": 20
}
```

## 验证

```sh
bun run --cwd examples/ev-charging-control typecheck
bun run --cwd examples/ev-charging-control test:unit
```

本示例不模拟 OCPP、真实充电桩、计费和持久化；内存仓储只证明微服务边界、容量不变量与
LikeGo readiness 组合方式。

## 直接运行

```sh
bun run --cwd examples/ev-charging-control start
```

`start` 会先构建本地 LikeGo 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。看到 `LIKEGO_EXAMPLE_READY=...` 后启动一个充电会话：

```sh
curl -sS http://127.0.0.1:3000/v1/charging-sessions \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-demo","stationId":"station-1","connectorId":"connector-1","requestedKw":20}'
```

按 `Ctrl+C` 发送 `SIGINT`，或执行 `kill -TERM <pid>`，LikeGo 会有序停止 HTTP Server。

# 双边平台订单履约编排

## 行业问题

库存预占、支付确认、发货与取消来自不同服务并可能重复或乱序送达。业务必须拒绝越级状态变化，并让同一事件的重投稳定收敛。

## 独有业务不变量

- 履约阶段只能沿 `placed -> inventoryReserved -> paymentCaptured -> shipped` 前进。
- 发货终态不可取消或覆盖。
- 相同 `eventId` 只接受相同订单与动作。

## 架构与职责

- `src/service.ts`：履约状态机、幂等仓储、用例，以及 Handler 与 Worker 资源组合。
- `src/worker.ts`：具有独立启动、停止与诊断状态的结构式后台 Server。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一创建 Core App 的可执行入口，按顺序挂载 Worker、HTTP Server 与进程信号。

## LikeGo 能力

使用 `@likego/core` 启停并排空结构式履约 worker；只有 worker 处于运行期时才接收履约事件。`@likego/web` 暴露标准 Web API。事件重投由确定性内存仓储模拟，不声称已经连接真实 Broker。

## 验证矩阵

| 场景                      | 证据                                                       |
| ------------------------- | ---------------------------------------------------------- |
| 合法阶段推进和终态保护    | `test/main.test.ts` 状态机用例                             |
| Broker 式重复投递收敛     | `test/main.test.ts` event identity 用例                    |
| Core 管理 worker 生命周期 | `test/main.test.ts` 启动前拒绝、运行中接收、停止后诊断用例 |
| Fetch 入口                | `test/main.test.ts` 运行期 Web API 用例                    |

```bash
bun run --filter @likego/example-marketplace-order-fulfillment typecheck
bun run --filter @likego/example-marketplace-order-fulfillment test
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @likego/example-marketplace-order-fulfillment start
```

看到 `LIKEGO_EXAMPLE_READY` 后推进订单第一步：

```bash
curl -sS http://127.0.0.1:3000/v1/fulfillment-events \
  -H 'content-type: application/json' \
  -d '{"eventId":"event-1","orderId":"order-1","action":"reserveInventory"}'
```

HTTP 用例通过正在运行的履约 Worker 处理事件。前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM` 可让 Core 排空 Worker 与 HTTP Server。

## Docker 判定

本案例只聚焦状态机与幂等边界，不声明外部数据库或 Broker，因此无需 Docker。升级为完整 Saga/Outbox 案例时必须加入固定版本 PostgreSQL 与 NATS Docker E2E，并验证故障间隙和零残留。

## 非目标

不实现支付账本、库存数据库或通用工作流引擎。

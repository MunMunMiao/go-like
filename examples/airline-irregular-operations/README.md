# 航空不正常运行处置

## 行业问题

航班取消或严重延误后，同一旅客行程只能进入一种最终处置：改签或退款。重复消息可以重放，但不同渠道不得把已经退款的行程再次改签。

## 独有业务不变量

- 同一航变案例只能产生一个最终处置。
- 相同处置重试必须幂等返回。
- 已进入终态后，任何冲突处置必须失败。

## 架构与职责

- `src/service.ts`：终态规则、处置用例、进程内仓储及服务端点选择。
- `src/registry.ts`：可选 ZooKeeper App 注册装配。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一可执行入口，组合业务服务、HTTP Server 与进程信号。

## LikeGo 能力

使用 `@likego/context` 贯穿处置仓储调用，使用 `@likego/web` 提供与运行时无关的标准 Fetch 入口，并使用 `@likego/registry` 的 round-robin selector 为改签处置选择下游服务端点。

## 验证矩阵

| 场景             | 证据                                 |
| ---------------- | ------------------------------------ |
| 重复改签幂等     | `test/main.test.ts` 的重试用例       |
| 改签与退款互斥   | `test/main.test.ts` 的冲突终态用例   |
| 改签服务端点轮询 | `test/main.test.ts` 的 selector 用例 |
| 标准 Fetch 入口  | `test/main.test.ts` 的 HTTP 用例     |

```bash
bun run --filter @likego/example-airline-irregular-operations typecheck
bun run --filter @likego/example-airline-irregular-operations test
```

## Docker 判定

默认模式使用内存处置仓储，不声明已连接 GDS、航司 PSS、支付或票务系统，因此不需要 Docker。
设置 `ZOOKEEPER_ADDRESS` 后，`@likego/registry-zookeeper` 会把当前服务注册到真实 ensemble，并在停止时
注销；可用 `ZOOKEEPER_ROOT` 隔离路径。连接或认证失败会使生命周期失败，不会静默改用内存注册中心。

## 非目标

不执行真实改签、退票、票价重算、座位控制或旅客通知。

## 直接运行

```bash
bun run --filter @likego/example-airline-irregular-operations start
```

看到 `LIKEGO_EXAMPLE_READY=...` 后请求航变处置接口：

```bash
curl -sS http://127.0.0.1:3000/v1/disruptions/resolve \
  -H 'content-type: application/json' \
  -d '{"caseId":"case-demo","outcome":"rebooked"}'
```

按 `Ctrl+C` 发送 `SIGINT`，或执行 `kill -TERM <pid>`，LikeGo 会有序停止 HTTP Server。

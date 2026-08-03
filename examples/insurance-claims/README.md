# 保险理赔限额裁定

## 行业问题

保险理赔必须检查事故是否发生在承保期内，再应用单次免赔额和保单累计赔付上限。后续理赔不能突破已经被前序赔付消耗的剩余保额。

## 独有业务不变量

- 事故时刻必须满足 `startsAt <= incidentAt < endsAt`。
- 每次理赔先扣除免赔额，低于免赔额的损失不产生赔付。
- 累计赔付永远不超过 `coverageLimitCents`，重复的同一理赔请求不会再次消耗保额。

## 架构与职责

- `src/service.ts`：免赔额与保额规则、理赔用例、进程内幂等仓储，以及 Handler 与 Worker 资源组合。
- `src/worker.ts`：实现 `start(ctx)` 与 `stop(ctx)` 的结构式理赔复核 Server。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一创建 Core App 的可执行入口，按顺序挂载复核 Worker、HTTP Server 与进程信号。

## LikeGo 能力

主要演示 `@likego/core` 如何把用户实现的结构式理赔复核 Worker 当作 `Server` 纳入 App 生命周期：`start(ctx)` 表示整个运行期，`stop(ctx)` 请求停止，App 并发停止所有 Server；`@likego/web` 仍只暴露标准 Fetch Handler。

## 验证矩阵

| 场景                     | 证据                               |
| ------------------------ | ---------------------------------- |
| 免赔额和累计保额封顶     | `test/main.test.ts` 的连续理赔用例 |
| 承保期拒绝与理赔身份冲突 | `test/main.test.ts` 的边界用例     |
| 标准 Fetch 入口          | `test/main.test.ts` 的 HTTP 用例   |
| 结构式 Worker 生命周期   | `test/main.test.ts` 的 Core 用例   |

```bash
bun run --filter @likego/example-insurance-claims typecheck
bun run --filter @likego/example-insurance-claims test:unit
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @likego/example-insurance-claims start
```

看到 `LIKEGO_EXAMPLE_READY` 后提交保单 `policy-1` 的理赔：

```bash
curl -sS http://127.0.0.1:3000/v1/claims \
  -H 'content-type: application/json' \
  -d '{"claimId":"claim-1","policyId":"policy-1","incidentAt":1784736000000,"lossCents":50000}'
```

前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM`，Core 会同时停止 HTTP Server 与理赔复核 Worker。

## Docker 判定

本案例只验证可移植的理赔裁定规则和单进程累计状态，没有声明外部保单库或理赔核心系统，因此不需要 Docker。接入生产数据库后应使用数据库约束或事务保证累计保额，并增加真实 Docker E2E。

## 非目标

不实现反欺诈、人工核赔、再保险、医疗编码、付款或通用规则引擎。

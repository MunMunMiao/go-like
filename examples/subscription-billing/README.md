# 订阅升降级按比例计费

## 行业问题

SaaS 订阅在账期中途升降级时，只能对剩余服务时间收取或退还差额。金额计算必须使用整数最小货币单位，并让同一个计费请求的重试得到稳定结果。

## 独有业务不变量

- 变更时刻必须严格位于账期开始与结束之间。
- 调整金额按“单价差 × 数量 × 剩余时长 ÷ 账期时长”计算，并采用确定性的四舍五入、远离零规则。
- 同一 `requestId` 和相同内容返回同一调整；相同 ID、不同内容拒绝处理。

## 架构与职责

- `src/service.ts`：整数金额规则、按比例计费用例与进程内幂等仓储。
- `src/config.ts`：构造 LikeGo Config，并把当前调整上限组合进计费用例。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一可执行入口，组合 Config、计费服务、HTTP Server 与进程信号。

## LikeGo 能力

主要演示 `@likego/config` 如何从真实 `objectSource` 执行 `load`、发布不可变配置值，再把计费调整上限组合进业务 Handler；应用通过 Core 的 `beforeStart / afterStop` hook 调用 `load / close`，同时使用 `@likego/context` 维持 Context-first 用例边界，并用 `@likego/web` 暴露不拥有 listener 的标准 Web API。

## 验证矩阵

| 场景                           | 证据                               |
| ------------------------------ | ---------------------------------- |
| 升级收费与降级退款的确定性舍入 | `test/main.test.ts` 的正负调整用例 |
| 幂等重试与冲突                 | `test/main.test.ts` 的请求身份用例 |
| 标准 Fetch 入口                | `test/main.test.ts` 的 HTTP 用例   |
| Config 当前值驱动计费上限      | `test/main.test.ts` 的配置组合用例 |

```bash
bun run --filter @likego/example-subscription-billing typecheck
bun run --filter @likego/example-subscription-billing test:unit
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @likego/example-subscription-billing start
```

看到 `LIKEGO_EXAMPLE_READY` 后提交账期变更：

```bash
curl -sS http://127.0.0.1:3000/v1/subscription-changes \
  -H 'content-type: application/json' \
  -d '{"requestId":"change-1","subscriptionId":"subscription-1","oldUnitPriceCents":1000,"newUnitPriceCents":2000,"quantity":1,"periodStart":0,"periodEnd":100,"changedAt":25}'
```

请求使用启动时发布的 Config 计费上限。前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM`，Core 会停止 HTTP Server，并在 `afterStop` hook 中关闭 Config。

## Docker 判定

本案例验证纯整数计费规则和单进程幂等边界，没有声明数据库、消息系统或第三方计费平台，因此不需要 Docker。接入真实账本或支付平台时，再增加固定版本依赖及其 Docker E2E。

## 非目标

不实现税务、发票、支付扣款、汇率转换或通用订阅平台。

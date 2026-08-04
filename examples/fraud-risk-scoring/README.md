# 支付交易欺诈风险评分

## 行业问题

支付授权需要综合交易金额、设备可信度、国家偏移和服务端观察到的交易速度，输出可解释且有上限的风险分数。客户端不能自行提供速度信号，否则攻击者可以直接伪造低风险输入。

## 独有业务不变量

- 速度和历史拒绝次数只从服务端仓储读取，不接受请求体传入。
- 每条命中规则留下可解释原因，风险分数封顶为 100。
- 分数小于 40 批准、40 至 69 人工复核、70 及以上拒绝；同一交易 ID 不能代表不同交易。

## 架构与职责

- `src/service.ts`：受信任信号仓储、可解释评分规则与交易身份用例。
- `src/cache.ts`：立即可用的 Memory Cache、TTL 编解码和 Circuit Breaker 组合。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一可执行入口，组合缓存风控服务、HTTP Server 与进程信号。

## go-like 能力

主要演示 `@go-like/cache-memory` 对已验证风险评估进行带身份指纹的 TTL 缓存，以及 `@go-like/resilience` Circuit Breaker 对评分依赖失败进行熔断；Memory Cache 构造后即可使用，外部入口继续使用标准 Fetch Handler。

## 验证矩阵

| 场景                         | 证据                                 |
| ---------------------------- | ------------------------------------ |
| 低风险批准和高风险封顶拒绝   | `test/main.test.ts` 的评分用例       |
| 交易身份稳定性               | `test/main.test.ts` 的重试与冲突用例 |
| 标准 Fetch 入口              | `test/main.test.ts` 的 HTTP 用例     |
| Cache 命中与 Circuit Breaker | `test/main.test.ts` 的微服务用例     |

```bash
bun run --filter @go-like/example-fraud-risk-scoring typecheck
bun run --filter @go-like/example-fraud-risk-scoring test:unit
```

## 直接运行

在仓库根目录启动完整的 Cache、Circuit Breaker、HTTP 和 Core 应用：

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @go-like/example-fraud-risk-scoring start
```

看到 `GO_LIKE_EXAMPLE_READY` 后，在另一个终端请求：

```bash
curl -sS http://127.0.0.1:3000/v1/risk-assessments \
  -H 'content-type: application/json' \
  -d '{"transactionId":"demo-1","accountId":"account-1","amountMinor":120000,"country":"DE","homeCountry":"DE","deviceTrusted":true}'
```

前台按 `Ctrl-C`，或向 Node 进程发送 `SIGTERM`；Core 会停止 HTTP Server，进程内风险缓存随应用内存释放。

## Docker 判定

本案例明确使用内存信号仓储，不宣称已连接风控数据库、特征平台或模型服务，因此不需要 Docker。接入实时特征库或模型服务后，再加入固定版本依赖及故障场景 E2E。

## 非目标

不训练机器学习模型，不实现黑名单管理、身份认证、制裁筛查或自动资金冻结。

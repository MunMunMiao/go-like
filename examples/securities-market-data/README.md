# 证券市场最优报价摄取

## 行业问题

行情消费者必须按交易所序列接收最优买卖价，拒绝倒退或冲突的更新。报价还必须符合证券的最小报价单位，并且买价不能等于或高于卖价。

## 独有业务不变量

- 每个证券的 `sequence` 只能严格递增；相同序列仅允许完全相同的重投。
- `bidPriceMicros < askPriceMicros`，避免接受交叉或锁定报价。
- 买卖价格都必须是配置的 `tickSizeMicros` 的整数倍。

## 架构与职责

- `src/service.ts`：报价与 tick 规则、递增序列仓储、摄取用例和健康探针。
- `src/http.ts`：标准 Web API 报价摄取及 `/livez`、`/readyz` 路由。
- `src/main.ts`：唯一可执行入口，组合行情服务、HTTP Server 与进程信号。

## LikeGo 能力

主要演示 `@likego/health` 注册行情进程 liveness 和指定证券 snapshot readiness：服务启动后可存活，但只有摄取该证券首笔合法报价才会就绪；探针通过 `@likego/web/health` 暴露标准 `/livez`、`/readyz` Handler。

## 验证矩阵

| 场景                            | 证据                                 |
| ------------------------------- | ------------------------------------ |
| 递增序列与过期更新拒绝          | `test/main.test.ts` 的序列用例       |
| 重投、序列冲突、交叉报价与 tick | `test/main.test.ts` 的市场不变量用例 |
| 标准 Fetch 入口                 | `test/main.test.ts` 的 HTTP 用例     |
| 首笔行情驱动 readiness          | `test/main.test.ts` 的健康探针用例   |

```bash
bun run --filter @likego/example-securities-market-data typecheck
bun run --filter @likego/example-securities-market-data test
```

## Docker 判定

本案例只验证确定性的报价摄取规则，没有声明已连接交易所、行情供应商或流式消息系统，因此不需要 Docker。接入真实 feed handler 或 Broker 后，应增加固定版本依赖和乱序、断线重连 E2E。

## 非目标

不实现完整订单簿、撮合、K 线、交易下单、行情历史存储或交易所协议解析。

## 直接运行

```bash
bun run --filter @likego/example-securities-market-data start
```

程序以 `LIKE` 为 readiness 所需证券。启动后先摄取报价，再检查健康状态：

```bash
curl -i http://127.0.0.1:3000/v1/market-quotes \
  -H 'content-type: application/json' \
  -d '{"symbol":"LIKE","sequence":1,"bidPriceMicros":100000,"bidQuantity":20,"askPriceMicros":100005,"askQuantity":15}'
curl -i http://127.0.0.1:3000/readyz
```

可使用 `HOST`、`PORT` 覆盖监听地址；按 `Ctrl-C` 或发送 `SIGTERM` 停止。

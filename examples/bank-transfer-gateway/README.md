# 银行转账网络路由

## 行业问题

银行转账网关必须依据付款行、收款行和币种选择国内清算、SEPA 或 SWIFT，不能把跨境转账误送到不适用的网络。费用和预计结算时间也必须由同一套确定性规则生成。

## 独有业务不变量

- 同国转账优先使用国内清算网络。
- 只有付款国与收款国都在 SEPA 且币种为 EUR 时才选择 SEPA。
- 其他跨境路径必须具备合法 BIC 才能选择 SWIFT，且 SWIFT 费用不少于最低费用。

## 架构与职责

`src/main.ts` 是直接入口；`src/http.ts` 处理标准 Web API；`src/service.ts` 放置路由规则、用例和内存网络目录；
`src/contract.ts` 以 `endpoint` 直接绑定 request/response Struct，并由 `Infer` 推导唯一的共享类型；`src/transport.ts` 组合真实 Client、Server 与 Memory Transport。

## go-like 能力

主要演示 `@go-like/struct` 契约、`@go-like/transport` 的类型化 `endpoint`、`@go-like/server` 的 `handler(contract, fn)` 与 `@go-like/client` 的 `client.call(ctx, contract, value)`。请求由统一 Struct JSON 边界校验，并由 `@go-like/transport-memory` 完成真实的进程内 Client→Server 消息交换；外部入口仍使用 `@go-like/web` 标准 Fetch Handler。

## 验证矩阵

| 场景                   | 证据                               |
| ---------------------- | ---------------------------------- |
| 国内与 SEPA 路由优先级 | `test/main.test.ts` 的两类网络用例 |
| SWIFT BIC 和最低费用   | `test/main.test.ts` 的跨境用例     |
| 标准 Fetch 入口        | `test/main.test.ts` 的 HTTP 用例   |
| 内部 unary 微服务链路  | `test/main.test.ts` 的内存传输用例 |

```bash
bun run --filter @go-like/example-bank-transfer-gateway typecheck
bun run --filter @go-like/example-bank-transfer-gateway test:unit
```

## Docker 判定

本案例使用明确的内存网络目录，不声明已连接银行、SWIFT 或 SEPA 外部系统，因此不需要 Docker。接入实际路由目录或报文网关后，必须以其沙箱或固定版本服务增加集成验证。

## 非目标

不发起真实资金划转，不处理外汇兑换、制裁筛查、账户余额或银行报文签名。

## 直接运行

```bash
bun run --filter @go-like/example-bank-transfer-gateway start
```

看到 `GO_LIKE_EXAMPLE_READY` 后请求转账报价。HTTP Handler 会真实经过 Client → Server → Memory Transport 内部微服务链：

```bash
curl -i http://127.0.0.1:3000/v1/transfer-quotes \
  -H 'content-type: application/json' \
  -d '{"requestId":"demo-1","sourceCountry":"DE","beneficiaryCountry":"FR","currency":"EUR","amountMinor":50000}'
```

可用 `HOST`、`PORT` 覆盖监听地址；按 `Ctrl-C` 或发送 `SIGTERM` 时，Core 会关闭 HTTP 与 Memory Transport。

# 数字身份核验

## 主要演示

演示数字身份微服务如何在不接收、记录或回显证件原文的前提下，把供应商准入名单、调用超时、隔离熔断和 readiness 组合到同一条核验链路。公共请求只携带不透明申请引用和小写 SHA-256 摘要。

## 行业问题与不变量

- 只有显式 allowlist 内的核验供应商可以被调用，未知与未获准供应商使用同一拒绝语义。
- 同一 `requestId` 的相同命令稳定返回原结果；更换供应商、申请引用或摘要会冲突。
- 供应商延迟受 Context timeout 限制；每个供应商拥有独立 Circuit Breaker。
- 日志路径不记录请求载荷，API 与 health 响应不返回 `documentDigest`；仓储只保留用于幂等冲突检测的最小指纹。

## 文件职责

- `src/service.ts`：隐私最小化命令、校验和 Context-first 幂等核验用例。
- `src/provider.ts`：内存结果仓储、供应商、allowlist、timeout 与 Circuit Breaker。
- `src/http.ts`：标准 Fetch 核验入口、health 和供应商 readiness 组合。
- `src/main.ts`：配置演示供应商并运行常驻 go-like HTTP App；这是唯一直接执行入口。
- `test/main.test.ts`：供应商准入、幂等冲突、超时、熔断、health 和最小化输出。

## go-like 能力

`@go-like/resilience` 为每个允许的供应商提供独立 Circuit Breaker，`@go-like/context` 为调用设置确定的超时边界，`@go-like/health` 与 `@go-like/web/health` 发布 `/readyz`。测试实际触发超时、打开熔断器并观察 readiness 失败。

```bash
bun run --filter @go-like/example-digital-identity-verification typecheck
bun run --filter @go-like/example-digital-identity-verification test:unit
```

## Docker 判定

本例使用确定性的进程内供应商替身，未声明任何外部核验厂商或 daemon，因此不需要 Docker。接入真实供应商时应增加其沙箱 E2E、固定网络故障注入和秘密管理，而不是把本例的内存替身描述成外部集成。

## 非目标

不上传证件、不做人脸生物特征处理、不实现 OCR、不持久化原始身份材料，也不把模拟决定当作真实 KYC 结论。

## 直接运行

```sh
bun run --filter @go-like/example-digital-identity-verification start
```

看到 `GO_LIKE_EXAMPLE_READY=...` 后调用核验接口：

```sh
curl -sS http://127.0.0.1:3000/v1/identity-verifications \
  -H 'content-type: application/json' \
  -d '{"requestId":"request-demo","applicantReference":"applicant-demo","providerId":"trusted-demo","documentDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
```

按 `Ctrl+C` 发送 `SIGINT`，或执行 `kill -TERM <pid>`，go-like 会有序停止 HTTP Server。

# 电信业务开通

该示例演示电信业务开通微服务：公共标准 Fetch API 不直接修改资源，而是通过
`@likego/client`、`@likego/server` 与 `@likego/transport-memory` 调用内部
`Provisioning.Activate` unary 服务。

## 主要演示

- LikeGo Client、Server declaration 与 Memory Transport 构成真实进程内内部调用。
- 内部服务以结构式 `Server` 暴露 `start(ctx)`、`stop(ctx)` 生命周期。
- `@likego/context` 从公共请求传播到内部 unary endpoint 与仓储。
- 业务服务、仓储、内部 Transport、公共 HTTP 与运行入口按真实职责拆分。

## 业务不变量

- 只有 `mobile-basic` 与 `mobile-premium` 两种明确套餐能够开通。
- 相同订单与相同载荷的重试幂等；同订单不同载荷必须拒绝。
- 一张 SIM 不能分配给不同订户。
- 月费使用固定整数最小货币单位，不在传输层计算或修改。

## 接口

`POST /v1/telecom-services`

```json
{
  "orderId": "order-1",
  "subscriberId": "subscriber-1",
  "simId": "sim-1",
  "plan": "mobile-premium"
}
```

## 文件结构

- `src/service.ts`：套餐、命令校验和 Context-first 开通用例。
- `src/repository.ts`：订单幂等与 SIM 唯一约束的内存仓储。
- `src/transport.ts`：内部 unary Server、Client 与 Memory Transport 生命周期。
- `src/http.ts`：公共标准 Fetch 请求解码与响应映射。
- `src/main.ts`：同时运行内部 Server 与 HTTP Server；这是唯一直接执行入口。
- `test/main.test.ts`：费率、幂等、SIM 约束和真实内存传输测试；测试与主程序均由
  Core App 管理内部 Server 生命周期。

## 验证

```sh
bun run --filter @likego/example-telecom-service-provisioning typecheck
bun run --filter @likego/example-telecom-service-provisioning test:unit
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @likego/example-telecom-service-provisioning start
```

看到 `LIKEGO_EXAMPLE_READY` 后开通业务：

```bash
curl -sS http://127.0.0.1:3000/v1/telecom-services \
  -H 'content-type: application/json' \
  -d '{"orderId":"order-1","subscriberId":"subscriber-1","simId":"sim-1","plan":"mobile-premium"}'
```

HTTP 请求会完整经过 Client、Memory Transport 与内部 unary Server。前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM` 可让 Core 排空两类 Server。

本示例不伪装 OSS/BSS、SIM 厂商、号码携转或计费平台；Memory Transport 只用于真实验证
LikeGo 内部微服务边界，跨进程部署时可替换为已实现的 HTTP Transport。

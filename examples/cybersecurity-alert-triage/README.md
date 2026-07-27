# 网络安全告警分诊

该示例演示 SOC 告警分诊微服务：标准 Fetch API 接收身份、终端或网络告警，通过
`@likego/health` readiness 确认规则已发布，再从 `@likego/config` 当前不可变配置读取阈值并计算
处置队列。默认模式无需外部服务；设置 `ETCD_ADDRESS` 后，同一程序改用真实
`@likego/config-etcd`、`@likego/registry-etcd` 和 `@likego/store-etcd`。

## 主要演示

- Core hook 在 HTTP Server 启动前加载 Config，并在停止后关闭 Config。
- etcd 模式从一个精确 KV key 读取规则、注册当前 App，并持久化分诊结果后 fresh readback。
- Health readiness 作为告警接纳前的 fail-closed 门禁。
- `@likego/context` 作为分诊和告警台账操作的首个参数。
- 标准 Fetch Handler 与规则服务、Config、运行入口分离。

## 业务不变量

- 规则的 high 阈值必须严格低于 critical 阈值，阈值边界按较高级别接纳。
- 特权账户活动始终进入 critical，不被较低的数值信号降级。
- 多个风险信号取最高严重度，不做会掩盖强信号的平均。
- 同一 alertId 的完全重放幂等，内容冲突失败；规则未就绪时不得写入分诊台账。

## 接口

`POST /v1/security/alerts/triage`

```json
{
  "alertId": "alert-1001",
  "source": "identity",
  "failedAttempts": 12,
  "malwareConfidence": 0,
  "privileged": true
}
```

## 文件结构

- `src/service.ts`：告警类型、规则校验、分级算法和 Context-first 分诊用例。
- `src/config.ts`：固定或 etcd Config、readiness 门禁以及内存或 etcd 分诊台账。
- `src/http.ts`：标准 Fetch 请求解码与响应映射。
- `src/main.ts`：组装健康接口并运行 LikeGo HTTP App；这是唯一直接执行入口。
- `test/main.test.ts`：阈值边界、readiness、幂等冲突和 Config 当前值测试，直接使用
  与 go-kratos 对齐的 `load / close` 契约。

## 验证

```sh
bun run --filter @likego/example-cybersecurity-alert-triage typecheck
bun run --filter @likego/example-cybersecurity-alert-triage test:unit
bun run test:e2e:examples
```

`test:e2e` 使用固定 digest 的真实 etcd 3.7.1，验证 Config 读取、Registry 注册/注销、Store 写入与
fresh readback，并检查 owner-labeled 容器零残留。默认启动仍使用固定 Config source 和内存台账，不连接
SIEM、EDR 或身份系统。

## 直接运行

```bash
bun run --filter @likego/example-cybersecurity-alert-triage start
```

Core 的 `beforeStart` hook 加载 Config。看到 `LIKEGO_EXAMPLE_READY` 后提交告警并检查 readiness：

```bash
curl -i http://127.0.0.1:3000/v1/security/alerts/triage \
  -H 'content-type: application/json' \
  -d '{"alertId":"alert-demo","source":"identity","failedAttempts":12,"malwareConfidence":0,"privileged":true}'
curl -i http://127.0.0.1:3000/readyz
```

可用 `HOST`、`PORT` 覆盖监听地址；按 `Ctrl-C` 或发送 `SIGTERM` 时，Core 会关闭 HTTP，并在 `afterStop` hook 中关闭 Config。

若要让可执行程序接入已有 etcd，先把完整规则 JSON 写入
`likego/examples/security/triage/config`，再设置 `ETCD_ADDRESS`；可用 `ETCD_CONFIG_KEY` 覆盖 key。
该模式不会回退为内存成功：etcd 不可用、协议错误或注册失败都会使启动或请求真实失败。

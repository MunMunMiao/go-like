# 临床检验结果接收

该示例聚焦两个容易被普通 CRUD 忽略的边界：

1. 检验结果只能写入与患者、开单医生都匹配的就诊上下文。
2. HTTP 响应和审计事件不得携带检验正文或患者标识。

## 架构与职责

- `src/service.ts`：就诊关联规则、结果接收用例、内存仓储、安全审计、Metadata 白名单与健康探针。
- `src/http.ts`：绑定 `x-encounter-id` 的标准 Web API。
- `src/main.ts`：唯一可执行入口，组合检验服务、HTTP Server 与进程信号。

`POST /v1/laboratory-results` 只返回接收回执。检验正文仅保存在仓储边界内部。
本示例没有声称已接入真实 LIS、Pino 或 OpenTelemetry 后端。
`newSafeResultAuditSink` 可把 downstream client metadata 限制为 `x-request-id` 与 `x-encounter-id`，
单元测试验证 Authorization、患者标识和检验正文不会被该包装器传播。当前 `main.ts` 使用进程内审计 sink，
未装配该 Metadata 包装器、真实远程审计调用或 HTTP health 路由；探针与包装器由测试独立验证。

## 直接运行

```bash
bun run --filter @go-like/example-laboratory-results start
```

看到 `GO_LIKE_EXAMPLE_READY=...` 后提交与演示就诊匹配的检验结果：

```bash
curl -sS http://127.0.0.1:3000/v1/laboratory-results \
  -H 'content-type: application/json' \
  -H 'x-encounter-id: encounter-1' \
  -d '{"resultId":"result-demo","encounterId":"encounter-1","patientId":"patient-1","orderingClinicianId":"clinician-1","testCode":"HB","value":"13.5"}'
```

按 `Ctrl+C` 发送 `SIGINT`，或执行 `kill -TERM <pid>`，go-like 会有序停止 HTTP Server。

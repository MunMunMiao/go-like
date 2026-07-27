# 医疗预约时段

该示例演示医疗预约服务最小但真实的业务边界：同一医生的有效预约时段
不得重叠，取消后的时段可以再次预约，重复请求必须保持幂等。

## 程序结构

- `service.ts`：预约模型、输入校验、预约与取消用例，以及带时段冲突检查的内存仓储。
- `transport.ts`：使用 `@likego/client`、`@likego/server` 与
  `@likego/transport-memory` 完成进程内预约策略 unary 调用。
- `http.ts`：标准 Fetch API 入口。
- `main.ts`：唯一可执行入口，组合内部策略服务、HTTP Server 和进程生命周期。

## HTTP 接口

- `POST /v1/appointments`：创建预约。
- `DELETE /v1/appointments/{appointmentId}`：取消预约。

本示例使用进程内仓储验证业务不变量，不声明数据库、消息系统或分布式锁已经接入。
程序和测试都由 Core App 管理策略 Server，并实际经过 Client `withAddress` →
Memory Transport → Server unary dispatch。`memory:` 是 transport-opaque 地址，因此显式绕过只接受
HTTP(S) URL 的 Discovery/Selector 便利层；策略拒绝发生在写入预约仓储之前，不存在手工启动的第二生命周期。

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @likego/example-healthcare-appointments start
```

看到 `LIKEGO_EXAMPLE_READY` 后，创建未来时段预约；该请求会真实经过内部策略服务：

```bash
NOW=$(($(date +%s) * 1000))
curl -sS http://127.0.0.1:3000/v1/appointments \
  -H 'content-type: application/json' \
  -d "{\"appointmentId\":\"appointment-1\",\"doctorId\":\"doctor-1\",\"patientId\":\"patient-1\",\"startsAt\":$((NOW + 3600000)),\"endsAt\":$((NOW + 5400000))}"
```

前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM`，Core 会反向停止 HTTP Server 与 Memory Transport 策略服务。

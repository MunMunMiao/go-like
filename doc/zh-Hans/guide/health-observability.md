# 健康与可观测性

`@go-like/health` 把 liveness 和 readiness 分开处理。空的 liveness registry 返回健康，因为进程确实活着；空的 readiness registry 会 fail closed，因为一个探针都没注册时，不该贸然把流量放进来。`@go-like/web/health` 可以把结果变成标准 Web 响应。默认路由是 `GET /livez` 和 `GET /readyz`：健康返回 `200`，失败返回 `503`，不支持的方法返回 `405`，未知路径返回 `404`。空 liveness 是 `200`，空 readiness 是 `503`；这两个路径只有在应用把 Handler 挂到自己的 Web router/host 后才会出现。

```ts
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"

const probes = newProbeRegistry()
const health = createHealthHandler(probes)
// 在应用自己的 route table 中把 /livez 和 /readyz 指向 health。
```

如需实际检查，可在启动后执行 `curl -i http://127.0.0.1:3000/livez`；这条命令只适用于已经把 health Handler 挂到该地址的应用。

`@go-like/server` 是另一条面。`newServer(...)` 在 Node HTTP 传输上默认对 `GET` / `HEAD` `/healthz` 回答 HTTP `200` 空 body，只表示 unary listener 接纳了这次请求，不是 `@go-like/health` 的 readiness registry，也不检查 broker、store 或对端证书。`httpRoute("GET", "/healthz", …)` 会覆盖该缺省。unary 上未匹配的 `/livez`、`/readyz` 仍是 `404`，除非应用自己挂了 `@go-like/web/health`。

Docker Desktop 发布端口的 TCP connect 不能当成 `/healthz` 已就绪：docker-proxy 可能在进程 TLS / HTTP listen 之前就接受宿主 TCP。探活应等待 HTTP（或 TLS HTTP/2）响应；dest 习惯把 `200` 或 `503` 当作接纳，启动期断连则重试。不要靠「先绑 HTTP 再等 recovering setup」来掩盖这条竞态。

指标和追踪都要求显式装配。`@go-like/prometheus` 暴露应用自己拥有的 `prom-client` Registry，不碰全局
Registry。`@go-like/otel` 接管应用创建的 OpenTelemetry provider 生命周期，并为 unary Client、unary
middleware、标准 Web Handler 和 Broker 提供显式 wrapper；它不会自行安装全局 provider、exporter、
context manager 或自动 instrumentation。

日志适配遵循同一原则。`@go-like/pino` 和 `@go-like/winston` 只承接原生 destination 或 logger 的停止边界，日志级别、脱敏、格式、transport、child logger 和字段规范仍由应用决定。

指标 label 必须控制值域，凭据不能塞进 attribute。需要异步 trace 父子关系时，先安装当前 runtime 真正支持的 context manager。Telemetry 导出失败也必须在终态里如实报告，不能为了“优雅关闭”四个字把错误吞了。

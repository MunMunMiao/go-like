# 健康与可观测性

`@likego/health` 把 liveness 和 readiness 分开处理。空的 liveness registry 返回健康，因为进程确实活着；空的 readiness registry 会 fail closed，因为一个探针都没注册时，不该贸然把流量放进来。`@likego/web/health` 可以把结果变成标准 Web 响应。

指标和追踪都要求显式装配。`@likego/prometheus` 暴露应用自己拥有的 `prom-client` Registry，不碰全局
Registry。`@likego/otel` 接管应用创建的 OpenTelemetry provider 生命周期，并为 unary Client、unary
middleware、标准 Web Handler 和 Broker 提供显式 wrapper；它不会自行安装全局 provider、exporter、
context manager 或自动 instrumentation。

日志适配遵循同一原则。`@likego/pino` 和 `@likego/winston` 只承接原生 destination 或 logger 的停止边界，日志级别、脱敏、格式、transport、child logger 和字段规范仍由应用决定。

指标 label 必须控制值域，凭据不能塞进 attribute。需要异步 trace 父子关系时，先安装当前 runtime 真正支持的 context manager。Telemetry 导出失败也必须在终态里如实报告，不能为了“优雅关闭”四个字把错误吞了。

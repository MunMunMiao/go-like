---
"@go-like/otel": patch
---

增加 unary Client、Server、Web Handler 与 Broker 的显式 OpenTelemetry instrumentation，升级至
OpenTelemetry JS 2.10.0 兼容组，完整转发 unary `CallOption`，并保留应用对 provider、exporter、propagator、
Context Manager 及 Fetch body 的所有权。

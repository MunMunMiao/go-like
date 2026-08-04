---
"@go-like/pino": patch
"@go-like/winston": patch
"@go-like/otel": patch
---

Pino、Winston 与 OpenTelemetry 的完成遥测不再复制原始 Error、message、stack 或 cause；失败只保留
有界且格式合法的错误类型与可选错误码，恶意 getter 不会替换原业务结果。

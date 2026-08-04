---
"@go-like/client": patch
"@go-like/server": patch
"@go-like/transport": patch
---

增加 canonical `ServiceError` wire、Client middleware 与业务错误健康反馈分类，并由单一 unary handler 驱动
精确 dispatch 与实际绑定端点解析。Registry 注册统一归 Core App 管理，不在 Server 内引入第二套生命周期。

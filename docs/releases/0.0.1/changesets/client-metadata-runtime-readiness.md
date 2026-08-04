---
"@go-like/client": patch
"@go-like/core": patch
"@go-like/metadata": patch
"@go-like/server": patch
"@go-like/transport": patch
"@go-like/transport-http": patch
---

增加显式 unary 调用路由、安全重试、有界关闭与保留已完成 response 的原生 `AggregateError`，
不可变多值 Metadata，client/server TransportInfo 与 HTTP provider 传播，完整 AppInfo、
Node/Bun 信号运行宿主，以及 Server 启动后注册、停止前反注册的应用生命周期。

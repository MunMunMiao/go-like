---
"@likego/server": minor
---

以 `newServer(transport(), address(), handler(service, endpoint, fn), middleware(), listenOption())`
取代服务声明、Fetch 与自动注册复合
DSL。实际绑定端点统一通过 Core `Endpointer.endpoint(ctx)` 读取，不再增加 Server 专属 `address()`。
新增 `advertise(...)` 分离监听地址与注册端点；host-only 值保留真实绑定端口，wildcard bind 未提供
可达地址时拒绝注册。`stop(ctx)` 接管进行中的 bind，并关闭迟到 listener 而不再进入 accept。
Listener 的唯一关闭操作独立于调用者 Context；每次 `stop(ctx)` 只用 Context 约束自己的等待，不会由首个
已取消调用者污染稳定关闭结果。

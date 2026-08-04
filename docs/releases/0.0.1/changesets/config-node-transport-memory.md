---
"@go-like/config": patch
"@go-like/transport-memory": patch
---

增加显式 Node filesystem Config host，并新增进程内 unary Memory Transport provider，二者均遵循现有
Context-first 与资源生命周期合同。Node file watcher 对 read/watch/change/close/detach 的同步边界执行完整
Promise/thenable 观察，保留取消原因与清理失败顺序，并确保自引用回调结果只订阅一次；Memory Transport 在
dial/listen/accept/dispatch/reply 的准入点重新裁决 Context，失败时回滚所有权，同时以 TransportInfo 投影请求和
响应 metadata。

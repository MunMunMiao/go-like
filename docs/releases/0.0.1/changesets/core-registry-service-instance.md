---
"@likego/core": minor
"@likego/registry": minor
"@likego/server": minor
---

将 Registry 公共模型收敛为 go-kratos `ServiceInstance`、`Registrar`、`Discovery` 与 `Watcher`；删除
`RegistrationHandle`、registration Server 和 go-micro IDL 描述树。Core App 新增 `registrar` /
`registrarTimeout`，按 Server 启动、注册、反注册、停止的 Kratos 生命周期管理服务实例；内部 Server 通过异步
`Endpointer` 与 `start` 共享同一次真实监听绑定。

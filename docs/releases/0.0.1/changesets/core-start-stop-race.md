---
"@go-like/core": patch
---

修复 App 在 `beforeStart`、endpoint 准备或 Registrar 注册期间收到 stop 后仍启动或遗漏清理的竞态；停止会
先取消启动 Context，再等待已进入的启动阶段收束，随后执行 `beforeStop`、反注册及 Server 清理。Node signal
listener 在首个异步启动步骤前安装，并在生命周期结束后移除。

---
"@likego/core": patch
---

移除 `server(...)` 注册时无生命周期意义的手写 `serverName` 参数；Core 改为按注册顺序生成稳定诊断标识，
使应用可直接注册任意结构化 Server。

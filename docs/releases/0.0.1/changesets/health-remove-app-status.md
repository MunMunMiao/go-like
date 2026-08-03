---
"@likego/health": minor
---

移除依赖自定义 App 状态机的 `registerAppProbes`。应用按实际依赖显式注册 liveness 与 readiness probe。

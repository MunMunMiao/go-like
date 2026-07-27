---
"@likego/config": patch
---

新增 `onTerminalError`，在成功 load 后第一次不可恢复 watcher 失败上、owner drain 开始前通知应用；回调与
`close(ctx)` 保留同一主 Error，且不会改变 last-good 配置或 Config 的既有结构接口。

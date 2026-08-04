---
"@go-like/client": minor
---

# Client 空闲连接边界

- 新增 `poolSize(maxIdle)` 与 `poolTtl(milliseconds)` Client options。
- idle owner 默认在整个 Client 范围最多保留 100 个，并在 60,000ms 后主动关闭。
- size 淘汰复用现有 Map 的 LRU 顺序；acquire、TTL、release 和 close 竞态共享同一次 owner close。

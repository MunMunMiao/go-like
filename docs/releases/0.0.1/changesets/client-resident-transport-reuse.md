---
"@go-like/client": minor
---

按 transport address 复用一个空闲 Client，同一连接不承接并发调用；失败 attempt 与多余并发连接立即关闭。
`client.close(ctx)` 幂等关闭空闲、活跃及迟到接纳的连接，并与 discovery 清理聚合失败。传输 owner 的 drain
独立于调用者 Context，transport 与 discovery 只建立一个稳定的组合 drain；畸形 provider 在 `close` 已捕获
后发生 getter/shape 失败也会先回滚 owner。

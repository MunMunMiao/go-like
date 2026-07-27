---
"@likego/cache-redis": minor
---

支持将官方 node-redis dormant client factory 交给 Cache 生命周期持有，在保留 URL 单节点模式的同时承接
`createClient()`、`createSentinel()` 与 `createCluster()`。命令继续使用调用方 Context 和统一 timeout；真实 Docker
门禁覆盖 TLS/auth、Sentinel 主节点故障转移与三主三从 Cluster 晋升。

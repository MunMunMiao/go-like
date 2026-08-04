# 配置、注册、缓存与存储

这四个能力在运维上经常一起出现，但职责完全不同。`@go-like/config` 把多个来源合成不可变的 last-good 快照，并管理已经接纳的 watcher；`@go-like/registry` 发布服务节点、发现活着的 endpoint；`@go-like/cache` 保存可丢弃的 bytes 值和可选 TTL；`@go-like/store` 则提供 Context-first 的持久 bytes 记录、revision、TTL、CAS、prefix 查询和稳定分页。

配置支持环境变量、文件、Consul、etcd、通过 `@go-like/config-kubernetes` 读取 Kubernetes
ConfigMap/Secret，以及通过 `@go-like/config-vault` 读取 Vault KV v2。Registry 支持适合本地网络的 mDNS，
以及 Consul、etcd、Kubernetes EndpointSlice 和 ZooKeeper。Cache provider 是 `@go-like/cache-memory` 和
`@go-like/cache-redis`。Store 支持单 owner 文件快照、Consul KV、etcd KV，以及通过
`@go-like/store-vault` 使用 Vault KV v2。每种实现都是独立平铺包，应用没选的后端就不会被带进依赖树。

Provider 构造时显式接收地址、凭据和宿主能力。可移植 HTTP provider 使用注入的单参数 Fetch，不读 runtime 全局变量。密钥只进 header，公共错误不能泄漏密钥或响应 body。watch 遇到 etcd compaction、Kubernetes `410 Gone` 这类观测缺口时，会重新拿完整快照再继续。ZooKeeper watch 在一次性通知或 session 过期后也会重新挂载；如果取消发生在 `multi` 已提交之后，provider 会等待真实结果并按精确状态回滚，结果仍然不明确时则关闭 session，再恢复此前已接纳的注册 owner。

文件 Store 适合少量本地状态，不是多进程数据库；Registry 记录的是短暂可达性，也不是业务持久化表。边界说清楚，才不会被一个看似方便的 API 骗去依赖后端根本给不了的保证。

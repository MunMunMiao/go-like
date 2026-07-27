# 包参考

LikeGo 的源码可以按能力分目录，但发布出去的包保持平铺。核心包括 `@likego/context`、`@likego/core`、`@likego/client`、`@likego/server`、`@likego/transport`、`@likego/metadata`、`@likego/web`、`@likego/config`、`@likego/registry`、`@likego/cache`、`@likego/store`、`@likego/broker`、`@likego/event`、`@likego/health` 和 `@likego/resilience`。

进程内调用与测试可以使用 `@likego/transport-memory`。内部 HTTP 是 `@likego/transport-http`；
`@likego/transport-http/node` 提供同时支持 `dial/listen` 的 Node 实现，并在服务端支持 PEM TLS/mTLS 与
ALPN HTTP/2。Web 框架桥接是 `@likego/hono`、`@likego/elysia`、`@likego/h3`。常见库生命周期适配包括
`@likego/croner`、`@likego/bullmq`、`@likego/nats`、`@likego/pino`、`@likego/winston`，可观测性则有
`@likego/prometheus` 和 `@likego/otel`。

配置 provider 有 `@likego/config-consul`、`@likego/config-etcd`、`@likego/config-kubernetes`、
`@likego/config-vault`，环境变量、文件与 YAML source 在 config 子路径。Registry provider 包括
`@likego/registry-mdns`、`@likego/registry-consul`、`@likego/registry-etcd`、
`@likego/registry-kubernetes`、`@likego/registry-zookeeper`。Broker provider 是
`@likego/broker-memory`、`@likego/broker-rabbitmq` 与 NATS 的 broker 子路径。Cache provider 是
`@likego/cache-memory`、`@likego/cache-redis`；Store provider 是 `@likego/store-memory`、
`@likego/store-file`、`@likego/store-consul`、`@likego/store-etcd`、`@likego/store-vault`。

仓库的项目创建 CLI 包是 `@likego/create`。

应用应该从真正拥有该契约的最小包导入。Node 等 runtime-specific 实现使用 `/node` 这类明确子路径。
公开包名里没有含糊的 `adapters` 大桶，项目自定义
header 一律使用 `Likego-` 前缀。

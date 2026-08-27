# 包参考

go-like 的源码可以按能力分目录，但发布出去的包保持平铺。核心包括 `@go-like/context`、`@go-like/core`、`@go-like/client`、`@go-like/server`、`@go-like/transport`、`@go-like/metadata`、`@go-like/web`、`@go-like/config`、`@go-like/registry`、`@go-like/cache`、`@go-like/store`、`@go-like/broker`、`@go-like/event`、`@go-like/health` 和 `@go-like/resilience`。

进程内调用与测试可以使用 `@go-like/transport-memory`。内部 HTTP 是 `@go-like/transport-http`；
`@go-like/transport-http/node` 提供同时支持 `dial/listen` 的 Node 实现，并在服务端支持 PEM TLS/mTLS 与
ALPN HTTP/2。Web 框架直接把原生 Fetch Handler 交给 `@go-like/web`；go-like 不发布框架专用桥接包。常见库生命周期适配包括
`@go-like/croner`、`@go-like/bullmq`、`@go-like/nats`、`@go-like/pino`、`@go-like/winston`，可观测性则有
`@go-like/prometheus` 和 `@go-like/otel`。

配置 provider 有 `@go-like/config-consul`、`@go-like/config-etcd`、`@go-like/config-kubernetes`、
`@go-like/config-vault`，环境变量、文件与 YAML source 在 config 子路径。Registry provider 包括
`@go-like/registry-mdns`、`@go-like/registry-consul`、`@go-like/registry-etcd`、
`@go-like/registry-kubernetes`、`@go-like/registry-zookeeper`。Broker provider 是
`@go-like/broker-memory`、`@go-like/broker-rabbitmq` 与 NATS 的 broker 子路径。Cache provider 是
`@go-like/cache-memory`、`@go-like/cache-redis`；Store provider 是 `@go-like/store-memory`、
`@go-like/store-file`、`@go-like/store-consul`、`@go-like/store-etcd`、`@go-like/store-vault`。

应用应该从真正拥有该契约的最小包导入。Node 等 runtime-specific 实现使用 `/node` 这类明确子路径。
公开包名里没有含糊的 `adapters` 大桶，项目自定义
header 一律使用 `Go-Like-` 前缀。

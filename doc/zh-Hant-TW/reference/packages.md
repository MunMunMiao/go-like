# 套件參考

go-like 原始碼可以依能力分資料夾，但發布套件保持平鋪。核心有 `@go-like/context`、`@go-like/core`、`@go-like/client`、`@go-like/server`、`@go-like/transport`、`@go-like/metadata`、`@go-like/web`、`@go-like/config`、`@go-like/registry`、`@go-like/cache`、`@go-like/store`、`@go-like/broker`、`@go-like/event`、`@go-like/health`、`@go-like/resilience`。

程序內呼叫與測試可以使用 `@go-like/transport-memory`。內部 HTTP 是 `@go-like/transport-http`；`@go-like/transport-http/node` 提供 Node 的 `dial` 與 `listen` 實作，伺服器端支援 PEM TLS/mTLS 及透過 ALPN 協商 HTTP/2。Web 框架直接將原生 Fetch Handler 交給 `@go-like/web`；go-like 不發布框架專用橋接套件。常見函式庫生命週期適配包含 `@go-like/croner`、`@go-like/bullmq`、`@go-like/nats`、`@go-like/pino`、`@go-like/winston`，觀測工具則是 `@go-like/prometheus` 與 `@go-like/otel`。

Registry provider 包括 mDNS、Consul、etcd、Kubernetes 和 ZooKeeper 的獨立 `@go-like/registry-*` 套件；Store provider 是 `@go-like/store-memory`、`@go-like/store-file`、`@go-like/store-consul`、`@go-like/store-etcd`、`@go-like/store-vault`；Config 的 Consul、etcd 及 Vault 也各自發布，包含 `@go-like/config-vault`，環境、檔案及 YAML 來源則放在 config 子路徑。Cache 使用 `@go-like/cache` 契約，provider 是 `@go-like/cache-memory` 與 `@go-like/cache-redis`。

Registry provider 的完整名稱是 `@go-like/registry-mdns`、`@go-like/registry-consul`、`@go-like/registry-etcd`、`@go-like/registry-kubernetes`、`@go-like/registry-zookeeper`。Config provider 也包含 `@go-like/config-consul`、`@go-like/config-etcd`、`@go-like/config-kubernetes`；Broker provider 是 `@go-like/broker-memory` 與 `@go-like/broker-rabbitmq`。

請從真正擁有契約的最小套件匯入。Node 等 runtime host 也有獨立入口。公開命名沒有含糊的 `adapters` 大桶，自訂 HTTP header 統一使用 `Go-Like-` 前綴。

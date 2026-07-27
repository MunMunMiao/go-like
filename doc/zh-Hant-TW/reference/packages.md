# 套件參考

LikeGo 原始碼可以依能力分資料夾，但發布套件保持平鋪。核心有 `@likego/context`、`@likego/core`、`@likego/client`、`@likego/server`、`@likego/transport`、`@likego/metadata`、`@likego/web`、`@likego/config`、`@likego/registry`、`@likego/cache`、`@likego/store`、`@likego/broker`、`@likego/event`、`@likego/health`、`@likego/resilience`。

程序內呼叫與測試可以使用 `@likego/transport-memory`。內部 HTTP 是 `@likego/transport-http`；`@likego/transport-http/node` 提供 Node 的 `dial` 與 `listen` 實作，伺服器端支援 PEM TLS/mTLS 及透過 ALPN 協商 HTTP/2。Web 框架橋接有 `@likego/hono`、`@likego/elysia`、`@likego/h3`。常見函式庫生命週期適配包含 `@likego/croner`、`@likego/bullmq`、`@likego/nats`、`@likego/pino`、`@likego/winston`，觀測工具則是 `@likego/prometheus` 與 `@likego/otel`。

Registry provider 包括 mDNS、Consul、etcd、Kubernetes 和 ZooKeeper 的獨立 `@likego/registry-*` 套件；Store provider 是 `@likego/store-memory`、`@likego/store-file`、`@likego/store-consul`、`@likego/store-etcd`、`@likego/store-vault`；Config 的 Consul、etcd 及 Vault 也各自發布，包含 `@likego/config-vault`，環境、檔案及 YAML 來源則放在 config 子路徑。Cache 使用 `@likego/cache` 契約，provider 是 `@likego/cache-memory` 與 `@likego/cache-redis`。

Registry provider 的完整名稱是 `@likego/registry-mdns`、`@likego/registry-consul`、`@likego/registry-etcd`、`@likego/registry-kubernetes`、`@likego/registry-zookeeper`。Config provider 也包含 `@likego/config-consul`、`@likego/config-etcd`、`@likego/config-kubernetes`；Broker provider 是 `@likego/broker-memory` 與 `@likego/broker-rabbitmq`。建立專案的 CLI 套件是 `@likego/create`。

請從真正擁有契約的最小套件匯入。Node 等 runtime host 也有獨立入口。公開命名沒有含糊的 `adapters` 大桶，自訂 HTTP header 統一使用 `Likego-` 前綴。

# 套件參考

LikeGo 原始碼可以按能力分資料夾，但發布套件保持平鋪。核心有 `@likego/context`、`@likego/core`、`@likego/client`、`@likego/server`、`@likego/transport`、`@likego/metadata`、`@likego/web`、`@likego/config`、`@likego/registry`、`@likego/cache`、`@likego/store`、`@likego/broker`、`@likego/event`、`@likego/health`、`@likego/resilience`。

進程內呼叫同測試可以用 `@likego/transport-memory`。內部 HTTP 用 `@likego/transport-http`；`@likego/transport-http/node` 提供 Node 嘅 `dial` 同 `listen` 實作，服務端支援 PEM TLS/mTLS 同以 ALPN 協商 HTTP/2。Web 框架橋接有 `@likego/hono`、`@likego/elysia`、`@likego/h3`。常用 library 生命週期適配包括 `@likego/croner`、`@likego/bullmq`、`@likego/nats`、`@likego/pino`、`@likego/winston`，觀測套件就係 `@likego/prometheus` 同 `@likego/otel`。

Registry provider 有 mDNS、Consul、etcd、Kubernetes、ZooKeeper 嘅獨立 `@likego/registry-*` 套件；Store provider 係 `@likego/store-memory`、`@likego/store-file`、`@likego/store-consul`、`@likego/store-etcd`、`@likego/store-vault`；Config 嘅 Consul、etcd 同 Vault 亦分開發布，包括 `@likego/config-vault`，環境、檔案同 YAML 來源就放喺 config 子路徑。Cache 用 `@likego/cache` 契約，provider 係 `@likego/cache-memory` 同 `@likego/cache-redis`。

Registry provider 嘅完整名稱係 `@likego/registry-mdns`、`@likego/registry-consul`、`@likego/registry-etcd`、`@likego/registry-kubernetes`、`@likego/registry-zookeeper`。Config provider 亦包括 `@likego/config-consul`、`@likego/config-etcd`、`@likego/config-kubernetes`；Broker provider 係 `@likego/broker-memory` 同 `@likego/broker-rabbitmq`。建立專案嘅 CLI 套件係 `@likego/create`。

應用應該由真正擁有契約嘅最小套件 import。Node 等 runtime host 亦有獨立入口。公開命名冇含糊嘅 `adapters` 大桶，自訂 HTTP header 統一用 `Likego-` 前綴。

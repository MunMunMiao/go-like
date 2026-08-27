# 套件參考

go-like 原始碼可以按能力分資料夾，但目前 checkout 的非 private package manifest 保持平鋪。呢個 checkout 有 43 個非 private `@go-like/*` package，版本全部係 `0.0.1`，目前仲未發布到 npm。核心有 `@go-like/context`、`@go-like/core`、`@go-like/client`、`@go-like/server`、`@go-like/transport`、`@go-like/metadata`、`@go-like/struct`、`@go-like/web`、`@go-like/config`、`@go-like/registry`、`@go-like/cache`、`@go-like/store`、`@go-like/broker`、`@go-like/event`、`@go-like/health`、`@go-like/resilience`。

程序內呼叫同測試可以用 `@go-like/transport-memory`。內部 HTTP 用 `@go-like/transport-http`；`@go-like/transport-http/node` 提供 Node 嘅 `dial` 同 `listen` 實作，伺服器端支援 PEM TLS/mTLS 同以 ALPN 協商 HTTP/2。Web framework 直接將原生 Fetch Handler 交畀 `@go-like/web`；go-like 目前冇 framework 專用橋接套件。常用 library lifecycle adapter 包括 `@go-like/croner`、`@go-like/bullmq`、`@go-like/nats`、`@go-like/pino`、`@go-like/winston`，觀測套件就係 `@go-like/prometheus` 同 `@go-like/otel`。

Registry provider 有 mDNS、Consul、etcd、Kubernetes、ZooKeeper 嘅獨立 `@go-like/registry-*` 套件；Store provider 係 `@go-like/store-memory`、`@go-like/store-file`、`@go-like/store-consul`、`@go-like/store-etcd`、`@go-like/store-vault`；Config 嘅 Consul、etcd 同 Vault 亦分開發布，包括 `@go-like/config-vault`，環境、檔案同 YAML 來源就放喺 config 子路徑。Cache 用 `@go-like/cache` 契約，provider 係 `@go-like/cache-memory` 同 `@go-like/cache-redis`。

Registry provider 嘅完整名稱係 `@go-like/registry-mdns`、`@go-like/registry-consul`、`@go-like/registry-etcd`、`@go-like/registry-kubernetes`、`@go-like/registry-zookeeper`。Config provider 亦包括 `@go-like/config-consul`、`@go-like/config-etcd`、`@go-like/config-kubernetes`；Broker provider 係 `@go-like/broker-memory` 同 `@go-like/broker-rabbitmq`。

應用應該由真正擁有契約嘅最小套件 import。Node 等 runtime host 亦有獨立入口。公開命名冇含糊嘅 `adapters` 大桶，自訂 HTTP header 統一用 `Go-Like-` 前綴。

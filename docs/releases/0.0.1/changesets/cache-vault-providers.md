---
"@likego/cache": patch
"@likego/cache-memory": patch
"@likego/cache-redis": patch
"@likego/config": patch
"@likego/config-vault": patch
"@likego/store-consul": patch
"@likego/store-vault": patch
---

增加独立 Cache SPI、Memory 与 Redis provider，为 Config 和 Store 增加 Vault KV v2 provider，并让 Consul
Store 支持显式物理 root 隔离。Config 对齐 go-kratos 的 `load`、`scan`、`value`、`watch`、`close`
契约，使用 `newConfig(source(...), schema(...), onReloadError(...))` functional options，不再作为 Core
Server；source watcher 的可恢复重载继续保留 last-good 值。

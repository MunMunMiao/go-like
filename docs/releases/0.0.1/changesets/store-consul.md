---
"@go-like/store-consul": patch
---

增加基于标准 Fetch 的 Consul Store，支持即时 CRUD、前缀分页、CAS、Session TTL 与 ACL。分页 cursor
绑定 Consul `X-Consul-Index`，数据变化后 fail closed，避免拼接不同 KV 快照。

---
"@go-like/client": minor
"@go-like/transport": minor
"@go-like/transport-http": minor
---

删除与 go-micro Transport 平行的 FetchTransport、StreamClient 及对应 HTTP 工厂。内部服务通信统一使用
Transport/Client/Listener/Socket；外部 Web 继续使用标准 Fetch Handler。同时删除把 Client 伪装成 App
Server 的 ResidentClient 与 pool 生命周期 API，只保留普通 `newClient`。构造器使用
`withDiscovery(...)`、`withSelector(...)`、`withTransport(...)` functional options；调用过滤复用 Registry
`Filter`，不再维护 Client 专属 version/metadata DSL，也不解析 provider 的 endpoint URL。

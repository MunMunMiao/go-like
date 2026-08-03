---
"@likego/transport-http": patch
---

新增 Node-only 安全 HTTP transport：公共 `newNodeHTTPTransport(...)` 通过 `clientAuth(...)` 与
`allowHTTP1(...)` 配置 server mTLS/ALPN；server host 支持 PEM TLS/mTLS、HTTP/1.1 ALPN fallback、HTTP/2 GOAWAY
与真实 force drain；每个 dial 返回的 client 自行持有 HTTP/1 keep-alive Agent 或 HTTP/2 session，支持
CA、client identity、SNI、GOAWAY 后换连和确定性 close。portable 根入口仍只使用标准 Web API。
显式传入 `executor(...)` 时继续使用调用方 Fetch executor，不会被 Node 原生连接池静默覆盖。

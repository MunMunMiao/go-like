---
"@likego/transport": minor
"@likego/transport-http": minor
"@likego/transport-memory": minor
---

收紧 Transport 公共选项，只保留当前 provider 能够真实实现的能力。删除未被任何实现消费的
`addrs`，以及标准 Fetch 和 unary Transport 无法兑现的 `withStream`、
`withInsecureSkipVerify`；保留 Memory provider 已实现的 `withConnClose`。同时删除没有内置
runtime host 能够兑现的 HTTP/2 buffer 配置，避免发布只能失败的公共选项。

# @likego/transport-http

`@likego/transport` 的 HTTP 实现。它同时实现 `dial` 与 `listen`，不再额外定义 client/server/host 生命周期。

```ts
import { newNodeHTTPTransport } from "@likego/transport-http/node"

const transport = newNodeHTTPTransport()
const listener = await transport.listen(ctx, "127.0.0.1:9000")
const client = await transport.dial(ctx, listener.addr())
```

Node HTTPS client 使用 `@likego/transport` 的公共 TLS 配置：

```ts
import { secure, tlsConfig } from "@likego/transport"
import { newNodeHTTPTransport } from "@likego/transport-http/node"

const transport = newNodeHTTPTransport()
transport.init(
  secure(true),
  tlsConfig({
    serverName: "catalog.internal",
    caCertificate: { encoding: "pem", bytes: ca },
    certificateChain: { encoding: "pem", bytes: clientCertificate },
    privateKey: { encoding: "pem", bytes: clientKey }
  })
)
const client = await transport.dial(ctx, "catalog.internal:443")
```

Node HTTPS server 在同一个 Transport 构造器上配置客户端证书认证和 ALPN：

```ts
import { secure, tlsConfig } from "@likego/transport"
import { allowHTTP1, clientAuth, newNodeHTTPTransport } from "@likego/transport-http/node"

const transport = newNodeHTTPTransport(clientAuth("require"), allowHTTP1(false))
transport.init(
  secure(true),
  tlsConfig({
    serverName: null,
    caCertificate: { encoding: "pem", bytes: ca },
    certificateChain: { encoding: "pem", bytes: serverCertificate },
    privateKey: { encoding: "pem", bytes: serverKey }
  })
)
const listener = await transport.listen(ctx, "127.0.0.1:9443")
```

`clientAuth("require")` 会用 `caCertificate` 验证客户端证书；`allowHTTP1(false)` 只允许 HTTP/2。
默认值分别是 `"none"` 和 `true`。这些是 Node transport construction options，不会公开内部 Host SPI。

内部微服务 Server 由 `@likego/server` 组合：

```ts
const rpc = newServer(
  transport(newNodeHTTPTransport()),
  address("127.0.0.1:9000"),
  handler("catalog", "get", getCatalog)
)
```

根入口 `newHTTPTransport(...)` 使用标准 Fetch 完成 dial，适用于 Bun、Node 与 Deno。Node 子路径同时提供
真实 listener 与原生 HTTPS client：按 ALPN 优先使用 HTTP/2、回退 HTTP/1.1，并支持 CA 校验和 mTLS
客户端证书；证书验证不可关闭。`maxMessageBytes(...)` 是请求与响应的边界限制，`executor(...)` 仅用于
注入 portable Fetch 实现，两者都是 construction option。portable client 的连接复用由 Fetch runtime
管理；Node native client 在同一个 `transport.dial(...)` 返回的 Client 内复用 HTTP/1 keep-alive
连接或 HTTP/2 session。GOAWAY 会让旧 session 完成已有 stream，并让下一次请求建立新 session；
`withConnClose()` 显式绕过复用。`client.close(ctx)` 负责释放该次 dial 持有的全部连接资源。

内部 Transport 不自动跟随 HTTP redirect。portable client 固定使用 `Request.redirect === "manual"`，
3xx 响应继续由 `client.recv(ctx)` 作为 HTTP status error 返回，不会把请求 body 或内部 header 重放到
`Location`。通过 `executor(...)` 注入的自定义 Fetch executor 必须遵守传入的 `Request.redirect`，不得
自行跟随或重放请求；Node native client 同样只向该次 dial 固定的 origin 发起请求。

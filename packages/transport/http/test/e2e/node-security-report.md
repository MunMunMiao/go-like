# Node HTTP 安全传输 Docker 验证报告

验证日期：2026-07-25

执行命令：

```sh
bun run --filter @likego/transport-http e2e:node-security:docker
```

测试使用 digest 固定的 Node 镜像，在 `--network none`、只读根文件系统、无 Linux capabilities 的容器中运行同一份
构建产物。TLS 请求只经过容器回环网络；每个容器退出后按本次运行的 owner label 回读残留。

运行时镜像：

- `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`
- `node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb`

真实输出：

```text
node24-lts: LIKEGO_NODE_HTTP_HOST_SECURE_E2E_V1={"runtime":"Node.js 24.18.0","tls":"TLSv1.3","mtlsRequired":true,"alpn":"h2","http1Fallback":true,"likegoClientHTTP2":true,"likegoClientHTTP1":true,"likegoClientHTTP1TLSConnections":1,"gracefulGoaway":true,"goawayErrorCode":0,"portReleased":true,"tcpResourceDelta":0}
node26-current: LIKEGO_NODE_HTTP_HOST_SECURE_E2E_V1={"runtime":"Node.js 26.5.0","tls":"TLSv1.3","mtlsRequired":true,"alpn":"h2","http1Fallback":true,"likegoClientHTTP2":true,"likegoClientHTTP1":true,"likegoClientHTTP1TLSConnections":1,"gracefulGoaway":true,"goawayErrorCode":0,"portReleased":true,"tcpResourceDelta":0}
LIKEGO_TRANSPORT_HTTP_NODE_SECURITY_DOCKER_V1={"valid":true,"lanes":["node24-lts","node26-current"],"secureHost":true,"fixedDigests":true,"containersRemaining":0}
```

已验证：

- TLS 1.3 与 mTLS 客户端证书校验；
- ALPN `h2` 和 HTTP/1.1 fallback；
- server policy 仅通过 `@likego/transport-http/node` 的 `clientAuth(...)`、`allowHTTP1(...)` 和
  `newNodeHTTPTransport(...)` 配置；
- `newNodeHTTPTransport()` 使用真实客户端证书连入禁用 HTTP/1.1 的服务端；
- `newNodeHTTPTransport()` 回退 HTTP/1.1 时复用同一条已验证 TLS socket，服务端只观察到一次 TLS admission；
- 缺少客户端证书时不会进入 Handler；
- HTTP/2 graceful close 发出 `NGHTTP2_NO_ERROR` GOAWAY；
- 关闭后端口可重新绑定，TCP resource delta 为 0；
- 两个固定镜像退出后 owner label 下容器残留为 0。

portable Fetch client 仍不接受自定义 TLS 证书；Node 专属能力只位于 `@likego/transport-http/node`，且不提供
跳过证书验证的选项。

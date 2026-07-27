# @likego/config-vault

`@likego/config-vault` 使用调用方注入的标准 Fetch，从 HashiCorp Vault KV v2 的一个精确 secret 路径读取
完整 `ConfigObject`，并以 `data.metadata.version` 作为配置 revision。它不依赖 Vault SDK，不读取运行时全局
`fetch`，也不支持 KV v1。

```ts
import { vaultSource } from "@likego/config-vault"

const source = vaultSource({
  fetch(request) {
    return fetch(request)
  },
  address: "https://vault.example.com",
  mount: "secret",
  path: "applications/orders/config",
  token: credentials.vaultToken,
  namespace: "platform"
})
```

请求固定为 `GET /v1/:mount/data/:path`。`mount` 和 `path` 按斜杠拆分、逐段百分号编码，并拒绝空段、`.`、
`..` 和非法 UTF-16；Vault 地址必须是不包含凭据、路径、查询或 fragment 的 HTTP(S) origin。token 与 namespace
只通过 `X-Vault-Token`、`X-Vault-Namespace` 发送，重定向被拒绝，公共错误不保留响应正文、token 或 secret 数据。

`watch` 是 Config 拥有的真实轮询 watcher。它默认每 5 秒读取一次完整 KV v2 响应，只有 metadata version 变化
时 `next(ctx)` 才完成。传输错误及 HTTP 404、408、425、429、5xx 使用可取消的指数退避并保留 last-good；
HTTP 403 等其他客户端错误以及畸形 KV v2 响应会终止 watcher。`stop(ctx)` 会中止 timer、Fetch 和 body 读取，
并在当前操作排空后完成。`pollIntervalMs`、`retryInitialMs`、`retryMaximumMs` 可显式调整。

Docker 集成脚本固定使用 2026-07-22 核验的最新稳定镜像
`hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54`。
它已真实验证错误 token、KV v2 两个版本、轮询发布、生命周期排空和容器零残留；普通单元测试不会自动启动
Docker，需显式执行 `bun run test:docker`。证据见 `test/integration/vault-2.0.3-report.md`。

官方参考：

- https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2
- https://developer.hashicorp.com/vault/api-docs
- https://hub.docker.com/r/hashicorp/vault/tags

# Enterprise Platform Runtime

这个可运行示例演示如何用 go-like 公开 API 组装一套企业微服务运行时：

- Core App 管理所有长期运行组件；
- Consul 提供服务注册与发现；
- Vault KV v2 提供可热更新的配置；
- 内部 unary HTTP Server 和 Client 完成服务调用；
- OpenTelemetry 向 Collector 导出 trace 与 metric；
- Prometheus、health 和 Pino 提供运维入口与日志。
- Vault Store 在独立 KV root 保存本次运行实例，并在停止时精确删除。

## 运行

从仓库根目录执行：

```sh
docker compose -f examples/enterprise-platform-runtime/compose.yaml up -d --wait
curl --fail --request POST \
  --header "X-Vault-Token: go-like-enterprise-dev" \
  --header "Content-Type: application/json" \
  --data '{"data":{"release":1,"feature":{"enabled":true}}}' \
  http://127.0.0.1:58200/v1/secret/data/applications/platform/config
bun run --filter @go-like/example-enterprise-platform-runtime start
```

程序默认监听 `http://127.0.0.1:3000`。在另一个终端调用：

```sh
curl --fail http://127.0.0.1:3000/call
curl --fail http://127.0.0.1:3000/livez
curl --fail http://127.0.0.1:3000/readyz
curl --fail http://127.0.0.1:3000/metrics
```

`/call` 通过 Consul 发现本进程注册的 `platform.echo/Ping`，返回
`{"response":"pong:1"}`。修改 Vault 中的 `release` 后，Config watcher 会发布新快照，后续调用使用新值。

停止程序后清理：

```sh
docker compose -f examples/enterprise-platform-runtime/compose.yaml down
```

可通过 `HOST`、`PORT`、`CONSUL_HTTP_ADDR`、`VAULT_ADDR`、`VAULT_TOKEN`、
`OTEL_EXPORTER_OTLP_ENDPOINT` 和 `LOG_PATH` 覆盖默认参数。

## 目录

```text
src/
├── config.ts      # Vault 配置契约与完整快照校验
├── echo.ts        # platform.echo/Ping 业务 Handler
├── probes.ts      # liveness/readiness 探针
├── management.ts  # health 与 metrics 路由
├── runtime-state.ts # Vault Store 运行实例状态
└── main.ts        # 创建组件、组装 App、运行
test/
├── unit/runtime.test.ts
└── e2e/docker-e2e.ts
```

业务、配置和管理面各自独立，`main.ts` 只做 composition root。

## 组件关系

```text
Vault KV v2 -> Config ------------------------------+
                                                     |
management /call -> Client -> Consul -> HTTP Server -> Echo Handler
       |                                             |
       +-> /livez /readyz                            +-> Prometheus Counter
       +-> /metrics

Client/Server middleware -> OpenTelemetry SDK -> OTel Collector
application logs --------> Pino destination
```

## go-like 能力

| 能力          | 使用方式                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------- |
| App           | `newApp(...options)`、`app.run()`、`app.stop()`                                          |
| Server        | `newServer(transport(...), address(...), handler(...), middleware(...))`                 |
| Client        | `newClient(withDiscovery(...), withSelector(...), withTransport(...))`                   |
| Registry      | Core App 使用 `registrar(registry)` 注册自身；Client 直接使用同一 Discovery              |
| Config        | Vault Source 作为 Config 的输入，通过 Core `beforeStart / afterStop` hook 加载和关闭     |
| Web           | Node Web Server 承载标准 Fetch Handler                                                   |
| Observability | OTel 与 Pino 只接管应用创建资源的生命周期                                                |
| Store         | `@go-like/store-vault` 写入隔离的 runtime state，并执行 write/read/delete fresh readback |

Server、Client、Registry 和 App 的用法与 go-like 当前公开 API 保持一致。

## 验证

```sh
bun run --filter @go-like/example-enterprise-platform-runtime typecheck
bun run --filter @go-like/example-enterprise-platform-runtime test:unit
bun run test:e2e:examples
```

Docker E2E 使用固定 digest 的 Consul 2.0.2、Vault 2.0.3 与 OpenTelemetry Collector 0.157.0，
验证真实配置更新、Vault Store 状态写入与清理、注册发现、内部 HTTP 调用、health、Prometheus、trace、metric、日志脱敏、
停止撤注册和容器清理。

## 安全与部署边界

- 当前公开 Node HTTP Transport 示例使用 loopback plaintext。TLS 应由受控 Ingress、Sidecar、Service Mesh
  或后续经过评审的公开 Transport 配置提供；本示例不会声称存在尚未公开的应用层 TLS 配置。
- Compose 中 Vault 使用开发 root token，Consul 使用 dev agent，只能用于本地验证。
- 生产环境必须配置 Vault/Consul ACL 与 TLS、凭据注入、持久化、备份和网络策略。
- Collector 不等于长期 telemetry backend；生产部署仍需配置实际 exporter 和存储。

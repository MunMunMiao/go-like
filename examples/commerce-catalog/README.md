# Commerce Catalog

这个可运行示例演示一个小型商城目录微服务：

- Hono 提供对外商品查询 API；
- Pricing 作为 go-like 内部 HTTP 服务运行；
- Pricing 通过 Core App 注册到 Consul；
- Catalog 使用 Client、Consul Discovery 和 round-robin Selector 调用 Pricing；
- Redis 缓存有效价格，第二次相同查询不再调用 Pricing。

## 运行

从仓库根目录执行：

```sh
docker compose -f examples/commerce-catalog/compose.yaml up -d --wait
bun run --filter @go-like/example-commerce-catalog start
```

程序默认监听 `http://127.0.0.1:3000`。在另一个终端调用：

```sh
curl --fail "http://127.0.0.1:3000/v1/products/sku-001?currency=USD"
curl --fail "http://127.0.0.1:3000/livez"
curl --fail "http://127.0.0.1:3000/readyz"
```

停止程序后清理依赖：

```sh
docker compose -f examples/commerce-catalog/compose.yaml down
```

可以通过 `HOST`、`PORT`、`CONSUL_HTTP_ADDR` 和 `REDIS_URL` 覆盖默认地址。

## 目录

```text
src/
├── catalog.ts   # 商品与价格数据、业务校验
├── pricing.ts   # Pricing.Get 编解码、Client 调用与服务 Handler
├── http.ts      # Hono 商品 API 与健康检查
└── main.ts      # 创建组件、组装两个 App、运行并关停
test/
└── app.test.ts  # 业务、缓存、重试与健康检查
e2e/
└── docker.ts    # 真实 Consul、Redis、注册发现与 HTTP 调用
```

`main.ts` 只负责组合：Pricing App 持有内部 `Server` 并由 `registrar(registry)` 注册；Catalog App
持有 Redis Cache 和 Web Server。业务逻辑分别留在 `catalog.ts`、`pricing.ts` 和 `http.ts`。

## 请求流程

```text
HTTP 调用方
    |
    v
Hono Catalog API
    |
    +-- Redis 命中 ----------------------------> 返回商品与价格
    |
    +-- Redis 未命中
            |
            v
       go-like Client -> Consul Discovery -> Pricing.Get HTTP Server
            |                                      |
            +--------------- 有效价格 <------------+
                            |
                            +-- 写入 Redis
```

`GET /v1/products/:productId?currency=USD` 返回商品和整数最小货币单位价格。当前示例支持
`sku-001`、`sku-002` 以及 `USD`、`CNY`。

Pricing 调用显式声明为幂等，并配置最多三次有界重试。默认 Client 不会替业务自行决定是否重放。

## go-like 能力

| 能力         | 使用方式                                                               |
| ------------ | ---------------------------------------------------------------------- |
| 应用生命周期 | `newApp(..., server(...))`、`app.run()`、`app.stop()`                  |
| 服务端       | `newServer(transport(...), address(...), handler(...))`                |
| 客户端       | `newClient(withDiscovery(...), withSelector(...), withTransport(...))` |
| 注册发现     | Core App 的 `registrar`、Consul Registry                               |
| 内部传输     | `@go-like/transport-http` client 与 Node server transport               |
| 对外 Web     | Hono Handler 由 `@go-like/web/node` 承载                                |
| 缓存         | Redis Cache 作为 App Server 管理连接生命周期                           |
| 数据契约     | 应用内 TypeScript 类型、标准 JSON 与显式业务校验                       |

示例只使用 go-like 公开的 App、Server、Client、Registry 与 functional options。

## 验证

```sh
bun run --filter @go-like/example-commerce-catalog typecheck
bun run --filter @go-like/example-commerce-catalog test:unit
bun run test:e2e:examples
```

Docker E2E 使用固定 digest 的 Consul 2.0.2 与 Redis 8.10.0，验证注册、发现、真实内部 HTTP 调用、
Redis 命中、停止后撤注册以及容器清理。

## 边界

- Redis 是缓存，不是价格真相源。
- Consul 和 Redis 的开发模式只适合本地示例；生产环境仍需 ACL、认证、TLS、持久化和网络策略。
- 对外认证、库存、订单、支付、搜索和公网 TLS 不属于这个示例。
- 内部 HTTP 与对外 Hono Web API 是两条不同边界。

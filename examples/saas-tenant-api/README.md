# SaaS Tenant API

这个可运行示例演示一个多租户配置微服务：

- Consul KV 是权威配置源，Config 自动监听完整文档更新；
- Hono 提供租户配置 API；
- Redis 按租户和配置 generation 缓存公开响应；
- Token Bucket 对每个租户执行进程内限流；
- Pino 输出结构化请求日志，并由 Core App 管理输出终态。
- `@go-like/store-consul` 在隔离 KV root 发布当前进程状态，启动和清理都执行 fresh readback。

## 运行

从仓库根目录执行：

```sh
docker compose -f examples/saas-tenant-api/compose.yaml up -d --wait
curl --fail --request PUT --data-binary @- \
  http://127.0.0.1:28500/v1/kv/go-like/examples/saas-tenant-api/config <<'JSON'
{"schemaVersion":1,"generation":"demo-1","cacheTtlMs":30000,"tenants":{"tenant-acme":{"enabled":true,"plan":"pro","features":{"exports":true,"auditLog":true},"rateLimit":{"capacity":60,"refillTokens":60,"refillIntervalMs":60000}}}}
JSON
bun run --filter @go-like/example-saas-tenant-api start
```

程序默认监听 `http://127.0.0.1:3000`。在另一个终端调用：

```sh
curl --fail -H "X-Tenant-Id: tenant-acme" http://127.0.0.1:3000/v1/tenant/config
```

停止程序后清理：

```sh
docker compose -f examples/saas-tenant-api/compose.yaml down
```

可以通过 `HOST`、`PORT`、`CONSUL_HTTP_ADDR`、`REDIS_URL` 和 `CONFIG_KEY` 覆盖默认配置。

## 目录

```text
src/
├── config.ts  # 配置 Schema、租户策略与公开投影
├── cache.ts   # 缓存编解码与 generation 校验
├── http.ts    # Hono、身份解析、限流与日志
├── runtime-state.ts # Consul Store 进程状态
└── main.ts    # 创建组件并组装 App
test/
└── app.test.ts
e2e/
└── docker.ts  # 真实 Consul、Redis、热更新、隔离与日志验证
```

## 请求流程

```text
Consul KV -> Config value -----------------------+
                                                  |
HTTP -> Hono -> TenantResolver -> Tenant policy -> Token Bucket
                                                  |
                                                  +-> Redis cache
                                                  |      |
                                                  |      +-- miss
                                                  v
                                            public projection
```

`GET /v1/tenant/config` 只返回当前租户的 `tenantId`、`generation`、`plan` 和公开
feature flags。缓存 key 同时包含 generation 与 tenant ID，配置更新后旧缓存不会跨 generation 命中。

`main.ts` 中的 `X-Tenant-Id` 仅用于让本地小程序可以直接运行。`newTenantHandler` 接受
`resolveTenant(ctx, request)`；生产应用必须接入已经完成认证和授权的身份系统，不能直接信任该示例 header。

## go-like 能力

| 能力         | 使用方式                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| 应用生命周期 | Config 通过 `beforeStart / afterStop` hook 加载和关闭；Cache、Pino 与 Web Server 作为 `Server` 交给 Core App |
| 配置         | `@go-like/config-consul` 提供 Config Source，完整文档通过 Schema 后发布                                      |
| 缓存         | Redis Cache 持有连接生命周期                                                                                 |
| Web          | Hono Handler 由标准 Web Server 承载                                                                          |
| 限流         | `@go-like/resilience` 的无后台 timer Token Bucket                                                            |
| 日志         | 应用配置 Pino；`@go-like/pino` 负责 flush/close 生命周期                                                     |
| Store        | `@go-like/store-consul` 写入隔离的 runtime state，并在 App 停止时删除                                        |

## 验证

```sh
bun run --filter @go-like/example-saas-tenant-api typecheck
bun run --filter @go-like/example-saas-tenant-api test:unit
bun run test:e2e:examples
```

Docker E2E 使用固定 digest 的 Consul 2.0.2 和 Redis 8.10.0，验证 Config watch、Store
write/read/delete、generation 切换、缓存命中、租户隔离、限流、Pino flush/redaction 和容器清理。

## 边界

- Consul 是配置源，Redis 只是公开投影缓存。
- Token Bucket 是单进程限流，不是跨副本全局配额。
- JWT/OIDC、租户管理、计费和配置审计不属于本示例。
- Compose 使用无凭据开发模式；生产环境必须补齐 ACL、TLS、认证、持久化和网络策略。

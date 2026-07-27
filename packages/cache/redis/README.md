# `@likego/cache-redis`

`@likego/cache-redis` 使用官方 `@redis/client` 6.1.0 实现 `@likego/cache`。连接由 Cache 生命周期拥有：
构造只捕获配置，`start(ctx)` 才连接，`stop(ctx)` 先停止新操作、等待已接纳操作，再关闭 Redis client。

```ts
import { newRedisCache } from "@likego/cache-redis"
import { newApp, server } from "@likego/core"

const cache = newRedisCache({ url: "redis://127.0.0.1:6379" })
const app = newApp(server(cache))

await app.run()
```

需要 TLS、Sentinel 或 Cluster 时，直接传入官方 `@redis/client` 的 dormant client factory；LikeGo 不复制
node-redis 的拓扑配置：

```ts
import { createCluster, createSentinel } from "@redis/client"
import { newRedisCache } from "@likego/cache-redis"

const sentinel = newRedisCache({
  client: () =>
    createSentinel({
      name: "primary",
      sentinelRootNodes: [{ host: "127.0.0.1", port: 26379 }]
    })
})

const cluster = newRedisCache({
  client: () => createCluster({ rootNodes: [{ url: "redis://127.0.0.1:7000" }] })
})
```

`url` 与 `client` 必须且只能提供一个。factory 在构造期只调用一次，并且必须返回尚未连接的官方
`createClient()`、`createSentinel()` 或 `createCluster()` client；连接仍由 Cache 生命周期拥有。TLS、认证、
Sentinel、Cluster、地址映射、连接超时和重连策略继续通过 node-redis 原生 options 配置。`connectTimeoutMs` 只属于
URL 模式；native client 使用 node-redis 自己的 socket options。

`start(ctx)` 是驻留运行过程，直到 `stop(ctx)` 完成后才返回；应用代码不需要接触额外的 lifecycle handle。
业务 handler 在 Cache 运行期间直接调用 `get`、`put`、`delete`。

值使用带版本的规范 base64 carrier，读取陌生或损坏值会返回稳定的 `RedisCacheProtocolError`，不会把任意 Redis
字符串误当业务字节。默认 key 前缀为 `likego:cache:`，可显式设置为空字符串或其他 namespace。provider 会直接校验：
key 最多 1024 UTF-8 bytes，值最多 1 MiB，TTL 为 1 至 `Number.MAX_SAFE_INTEGER` 毫秒。

每条命令使用调用 `Context` 的 `AbortSignal`，默认命令 timeout 为 5000ms；URL 模式的默认连接 timeout 也是
5000ms。`onError` 只观察 node-redis 后台错误；其抛错或 rejected thenable 会被隔离，不拥有 Cache 生命周期。

真实集成验证固定使用官方
`redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb`
镜像；测试覆盖二进制往返、覆盖写、miss、delete、毫秒 TTL、namespace 隔离、Context 取消、TLS/auth、
Sentinel 主节点故障转移、三主三从 Cluster 晋升以及停止后的连接回收。

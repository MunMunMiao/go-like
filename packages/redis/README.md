# @go-like/redis

Redis `Cache`，同时是资源层 `Server`。公开入口只有 `@go-like/redis/cache`。客户端由本包构造并封装。

## 依赖

| 种类 | 包              | 范围    |
| ---- | --------------- | ------- |
| peer | `@go-like/core` | `0.0.1` |
| 常规 | `@redis/client` | `6.3.1` |

没有可选 peer。`@go-like/core` 的 dev 依赖是 `workspace:*`。通道是 Node.js 与 Bun。

## 示例

```ts
import { newApp, resources } from "@go-like/core"
import { newRedisCache } from "@go-like/redis/cache"

const cache = newRedisCache({ url: "redis://127.0.0.1:6379" })
const app = newApp(resources(cache))
void app
```

`newRedisCache` 返回 `RedisCache`（`Cache` 与资源层 `Server`，`string()` 为 `"redis"`）。读写只在 `start` 成功之后、`stop` 之前有效。也可以传入自己的 `client` 工厂，而不是 `url`。`RedisCacheState` 是生命周期状态。

## 错误码

| 代码                            | 类型                       |
| ------------------------------- | -------------------------- |
| `GO_LIKE_CACHE_REDIS_OPERATION` | `RedisCacheOperationError` |
| `GO_LIKE_CACHE_REDIS_PROTOCOL`  | `RedisCacheProtocolError`  |
| `GO_LIKE_CACHE_REDIS_STATE`     | `RedisCacheStateError`     |

这三个错误类型都从 `@go-like/redis/cache` 导出。`RedisCacheStateError.state` 的取值是 `RedisCacheState`。操作失败与协议失败的构造函数留在包内，不是公开入口。

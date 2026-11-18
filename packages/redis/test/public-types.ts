import type { Cache } from "@go-like/core/cache"
import type { Server } from "@go-like/core/lifecycle"
import {
  newRedisCache,
  type RedisCache,
  type RedisCacheClient,
  type RedisCacheClientFactory,
  type RedisCacheCommandClient,
  type RedisCacheErrorHandler,
  type RedisCacheOperation,
  type RedisCacheOperationError,
  type RedisCacheOptions,
  type RedisCacheProtocolError,
  type RedisCacheState,
  type RedisCacheStateError
} from "../src/cache/index"
import { createClient, createCluster, createSentinel } from "@redis/client"

const onError: RedisCacheErrorHandler = (_error) => undefined
const options: RedisCacheOptions = { url: "redis://127.0.0.1", onError }
const factories: readonly RedisCacheClientFactory[] = [
  () => createClient(),
  () => createCluster({ rootNodes: [{ url: "redis://127.0.0.1:7000" }] }),
  () =>
    createSentinel({
      name: "go-like-primary",
      sentinelRootNodes: [{ host: "127.0.0.1", port: 26379 }]
    })
]
const nativeOptions: RedisCacheOptions = { client: factories[0] as RedisCacheClientFactory }
// @ts-expect-error native clients configure connection timeout through node-redis options
const invalidNativeTimeout: RedisCacheOptions = { client: factories[0], connectTimeoutMs: 1 }
const operation: RedisCacheOperation = "get"
declare const cache: Cache & Server
declare const operationError: RedisCacheOperationError
declare const protocolError: RedisCacheProtocolError
declare const stateError: RedisCacheStateError
const created: RedisCache = newRedisCache({ url: "redis://127.0.0.1:6379" })
const createdName: "redis" = created.string()
const cacheState: RedisCacheState = "running"
const stateErrorState: RedisCacheState = stateError.state
const stateErrorCode: "GO_LIKE_CACHE_REDIS_STATE" = stateError.code
const generic: Cache = cache
const createdCache: Cache = created
const createdServer: Server = created
const nativeGet: RedisCacheCommandClient["get"] = () => Promise.resolve(null)
const nativeSet: RedisCacheCommandClient["set"] = () => Promise.resolve(null)
const nativeDelete: RedisCacheCommandClient["del"] = () => Promise.resolve(1)
const nativeConnect: RedisCacheClient["connect"] = () => Promise.resolve()
const nativeClose: RedisCacheClient["close"] = () => Promise.resolve()
declare const thenOnlyString: Pick<Promise<string | null>, "then">
declare const thenOnlyNumber: Pick<Promise<number>, "then">
declare const thenOnlyUnknown: Pick<Promise<unknown>, "then">
// @ts-expect-error A then-only value is not a native Promise.
const thenOnlyGet: RedisCacheCommandClient["get"] = () => thenOnlyString
// @ts-expect-error A then-only value is not a native Promise.
const thenOnlySet: RedisCacheCommandClient["set"] = () => thenOnlyString
// @ts-expect-error A then-only value is not a native Promise.
const thenOnlyDelete: RedisCacheCommandClient["del"] = () => thenOnlyNumber
// @ts-expect-error A then-only value is not a native Promise.
const thenOnlyConnect: RedisCacheClient["connect"] = () => thenOnlyUnknown
// @ts-expect-error A then-only value is not a native Promise.
const thenOnlyClose: RedisCacheClient["close"] = () => thenOnlyUnknown
void options
void nativeOptions
void invalidNativeTimeout
void factories
void operation
void operationError
void protocolError
void stateError
void createdName
void cacheState
void stateErrorState
void stateErrorCode
void generic
void createdCache
void createdServer
void [
  nativeGet,
  nativeSet,
  nativeDelete,
  nativeConnect,
  nativeClose,
  thenOnlyGet,
  thenOnlySet,
  thenOnlyDelete,
  thenOnlyConnect,
  thenOnlyClose
]

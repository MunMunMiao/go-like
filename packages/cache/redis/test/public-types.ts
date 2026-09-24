import type { Cache } from "@go-like/cache"
import type { Server } from "@go-like/core"
import type {
  RedisCacheClient,
  RedisCacheClientFactory,
  RedisCacheCommandClient,
  RedisCacheErrorHandler,
  RedisCacheOperation,
  RedisCacheOperationError,
  RedisCacheOptions,
  RedisCacheProtocolError
} from "../src/index"
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
const generic: Cache = cache
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
void generic
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

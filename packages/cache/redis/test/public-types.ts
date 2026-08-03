import type { Cache } from "@likego/cache"
import type { Server } from "@likego/core"
import type {
  RedisCacheClientFactory,
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
      name: "likego-primary",
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
void options
void nativeOptions
void invalidNativeTimeout
void factories
void operation
void operationError
void protocolError
void generic

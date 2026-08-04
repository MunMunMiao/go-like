/** Observes one Redis client error without taking ownership of the Cache lifecycle. */
export type RedisCacheErrorHandler = (error: Error) => void

/** Carries the command subset shared by official standalone, Sentinel, and Cluster clients. */
export interface RedisCacheCommandClient {
  get(key: string): PromiseLike<string | null>
  set(
    key: string,
    value: string,
    options?: Readonly<{ expiration: Readonly<{ type: "PX"; value: number }> }>
  ): PromiseLike<string | null>
  del(key: string): PromiseLike<number>
}

/** Describes the dormant official node-redis capability owned by one Cache lifecycle. */
export interface RedisCacheClient {
  readonly isOpen: boolean
  on(event: "error", listener: (value: unknown) => void): unknown
  off(event: "error", listener: (value: unknown) => void): unknown
  withCommandOptions(
    options: Readonly<{ abortSignal?: AbortSignal; timeout: number }>
  ): RedisCacheCommandClient
  connect(): PromiseLike<unknown>
  close(): PromiseLike<unknown>
  destroy(): unknown
}

/** Creates one dormant official standalone, Sentinel, or Cluster client exactly once. */
export type RedisCacheClientFactory = () => RedisCacheClient

interface RedisCacheCommonOptions {
  readonly prefix?: string
  readonly commandTimeoutMs?: number
  readonly onError?: RedisCacheErrorHandler
}

/** Configures one lifecycle-owned Redis Cache provider. */
export type RedisCacheOptions = RedisCacheCommonOptions &
  (
    | { readonly url: string; readonly client?: never; readonly connectTimeoutMs?: number }
    | {
        readonly url?: never
        readonly client: RedisCacheClientFactory
        readonly connectTimeoutMs?: never
      }
  )

/** Identifies the exact Redis provider boundary that failed. */
export type RedisCacheOperation = "connect" | "get" | "put" | "delete" | "close"

/** Describes one stable Redis client or protocol boundary failure. */
export interface RedisCacheOperationError extends Error {
  readonly name: "RedisCacheOperationError"
  readonly code: "GO_LIKE_CACHE_REDIS_OPERATION"
  readonly operation: RedisCacheOperation
  readonly cause: Error
}

/** Describes a value that is not a canonical go-like Redis Cache carrier. */
export interface RedisCacheProtocolError extends Error {
  readonly name: "RedisCacheProtocolError"
  readonly code: "GO_LIKE_CACHE_REDIS_PROTOCOL"
  readonly operation: "get"
}

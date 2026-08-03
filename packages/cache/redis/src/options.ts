import type { RedisCacheClientFactory, RedisCacheErrorHandler, RedisCacheOptions } from "./types"

const DefaultPrefix = "likego:cache:"
const DefaultConnectTimeoutMs = 5_000
const DefaultCommandTimeoutMs = 5_000
const MaximumTimeoutMs = 2_147_483_647
const MaximumPrefixBytes = 1_024

/** Carries one immutable, validated Redis provider construction snapshot. */
export interface CapturedRedisCacheOptions {
  readonly url: string | null
  readonly client: RedisCacheClientFactory | null
  readonly prefix: string
  readonly connectTimeoutMs: number
  readonly commandTimeoutMs: number
  readonly onError: RedisCacheErrorHandler | null
}

/** Reports whether a string contains only complete UTF-16 scalar sequences. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Validates one timeout supported consistently by Web and Node timers. */
function timeout(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MaximumTimeoutMs) {
    throw new RangeError(`${name} must be a positive timer-safe integer`)
  }
  return selected
}

/** Validates one well-formed Redis key namespace. */
function prefix(value: string | undefined): string {
  const selected = value ?? DefaultPrefix
  if (typeof selected !== "string" || !isWellFormed(selected)) {
    throw new TypeError("Redis Cache prefix must be a well-formed string")
  }
  if (new TextEncoder().encode(selected).byteLength > MaximumPrefixBytes) {
    throw new RangeError(`Redis Cache prefix exceeds ${MaximumPrefixBytes} UTF-8 bytes`)
  }
  return selected
}

/** Validates one Redis URL without retaining a parsed credential-bearing object. */
function redisUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError("Redis Cache url must be a non-empty well-formed string")
  }
  let protocol: string
  try {
    protocol = new URL(value).protocol
  } catch {
    throw new TypeError("Redis Cache url is invalid")
  }
  if (protocol !== "redis:" && protocol !== "rediss:") {
    throw new TypeError("Redis Cache url must use redis or rediss")
  }
  return value
}

/** Captures all Redis provider options exactly once before client construction. */
export function captureRedisCacheOptions(value: RedisCacheOptions): CapturedRedisCacheOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Redis Cache options must be an object")
  }
  const onError = value.onError
  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("Redis Cache onError must be callable")
  }
  const hasUrl = value.url !== undefined
  const hasClient = value.client !== undefined
  if (hasUrl === hasClient) {
    throw new TypeError("Redis Cache options must provide exactly one of url or client")
  }
  if (hasClient && typeof value.client !== "function") {
    throw new TypeError("Redis Cache client must be a factory")
  }
  if (hasClient && value.connectTimeoutMs !== undefined) {
    throw new TypeError("Redis Cache native client must configure connect timeout in node-redis")
  }
  return Object.freeze({
    url: hasUrl ? redisUrl(value.url) : null,
    client: hasClient ? value.client : null,
    prefix: prefix(value.prefix),
    connectTimeoutMs: timeout(
      value.connectTimeoutMs,
      DefaultConnectTimeoutMs,
      "Redis Cache connectTimeoutMs"
    ),
    commandTimeoutMs: timeout(
      value.commandTimeoutMs,
      DefaultCommandTimeoutMs,
      "Redis Cache commandTimeoutMs"
    ),
    onError: onError ?? null
  })
}

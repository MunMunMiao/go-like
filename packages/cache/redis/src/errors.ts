import type {
  RedisCacheOperation,
  RedisCacheOperationError,
  RedisCacheProtocolError
} from "./types"

const Operations = new Set<RedisCacheOperation>(["connect", "get", "put", "delete", "close"])

/** Narrows one public operation token without a type assertion. */
function isOperation(value: unknown): value is RedisCacheOperation {
  return (
    value === "connect" ||
    value === "get" ||
    value === "put" ||
    value === "delete" ||
    value === "close"
  )
}

/** Converts a foreign rejection into an Error without retaining primitive payloads. */
export function normalizeRedisError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Redis Cache operation failed")
}

/** Narrows one decorated Redis operation error after its fields are installed. */
function isOperationError(value: Error): value is RedisCacheOperationError {
  return (
    value.name === "RedisCacheOperationError" &&
    "code" in value &&
    value.code === "GO_LIKE_CACHE_REDIS_OPERATION" &&
    "operation" in value &&
    isOperation(value.operation) &&
    "cause" in value &&
    value.cause instanceof Error
  )
}

/** Creates one frozen provider error while preserving the exact Error cause. */
export function newRedisCacheOperationError(
  operation: RedisCacheOperation,
  cause: Error
): RedisCacheOperationError {
  if (!Operations.has(operation)) throw new TypeError("Redis Cache operation is invalid")
  if (!(cause instanceof Error)) throw new TypeError("Redis Cache cause must be an Error")
  const error = new Error(`Redis Cache ${operation} failed`, { cause })
  Object.defineProperties(error, {
    name: { enumerable: true, value: "RedisCacheOperationError" },
    code: { enumerable: true, value: "GO_LIKE_CACHE_REDIS_OPERATION" },
    operation: { enumerable: true, value: operation }
  })
  if (!isOperationError(error)) throw new TypeError("Redis Cache error decoration failed")
  return Object.freeze(error)
}

/** Narrows one decorated Redis protocol error after its fields are installed. */
function isProtocolError(value: Error): value is RedisCacheProtocolError {
  return (
    value.name === "RedisCacheProtocolError" &&
    "code" in value &&
    value.code === "GO_LIKE_CACHE_REDIS_PROTOCOL" &&
    "operation" in value &&
    value.operation === "get"
  )
}

/** Creates the stable secret-safe error for a foreign or corrupted cache value. */
export function newRedisCacheProtocolError(): RedisCacheProtocolError {
  const error = new Error("Redis Cache value is not a canonical go-like carrier")
  Object.defineProperties(error, {
    name: { enumerable: true, value: "RedisCacheProtocolError" },
    code: { enumerable: true, value: "GO_LIKE_CACHE_REDIS_PROTOCOL" },
    operation: { enumerable: true, value: "get" }
  })
  if (!isProtocolError(error)) throw new TypeError("Redis Cache protocol error decoration failed")
  return Object.freeze(error)
}

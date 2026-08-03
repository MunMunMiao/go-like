import { cause, type Context } from "@likego/context"
import type { Server } from "@likego/core"
import { waitForContext } from "@likego/core/lifecycle"
import type { Cache, PutOption } from "@likego/cache"
import { putOptions } from "@likego/cache/provider"

import { decodeRedisCacheValue, encodeRedisCacheValue } from "./codec"
import { newRedisConnection, type RedisConnectionFactory } from "./connection"
import { newRedisCacheOperationError, normalizeRedisError } from "./errors"
import { captureRedisCacheOptions, type CapturedRedisCacheOptions } from "./options"
import type { RedisCacheOperation, RedisCacheOptions } from "./types"

const MaximumKeyBytes = 1_024
const MaximumValueBytes = 1_048_576

type RedisCacheState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

/** Creates one stable private admission error for the Redis Server lifetime. */
function newRedisCacheStateError(operation: string, state: RedisCacheState): Error {
  const error = new Error(`Redis Cache ${operation} is unavailable while ${state}`)
  Object.defineProperties(error, {
    name: { enumerable: true, value: "RedisCacheStateError" },
    code: { enumerable: true, value: "LIKEGO_CACHE_REDIS_STATE" },
    operation: { enumerable: true, value: operation },
    state: { enumerable: true, value: state }
  })
  return Object.freeze(error)
}

/** Creates one externally settleable terminal owner barrier. */
function completion(): PromiseWithResolvers<void> {
  return Object.freeze(Promise.withResolvers<void>())
}

/** Reports one exact Context cancellation cause or null while active. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
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

/** Validates one provider-neutral cache key against Redis provider bounds. */
function cacheKey(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError("Redis Cache key must be a non-empty well-formed string")
  }
  if (new TextEncoder().encode(value).byteLength > MaximumKeyBytes) {
    throw new RangeError(`Redis Cache key exceeds ${MaximumKeyBytes} UTF-8 bytes`)
  }
  return value
}

/** Copies and validates one Cache value before asynchronous provider I/O. */
function cacheValue(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError("Redis Cache value must be a Uint8Array")
  if (value.byteLength > MaximumValueBytes) {
    throw new RangeError(`Redis Cache value exceeds ${MaximumValueBytes} bytes`)
  }
  return new Uint8Array(value)
}

/** Converts a Redis rejection unless caller cancellation already won the boundary. */
function operationFailure(ctx: Context, operation: RedisCacheOperation, value: unknown): Error {
  return contextFailure(ctx) ?? newRedisCacheOperationError(operation, normalizeRedisError(value))
}

/** Creates the Redis Cache over one explicit connection factory. */
export function createRedisCache(
  construction: RedisCacheOptions,
  factory: RedisConnectionFactory = newRedisConnection
): Cache & Server {
  if (typeof factory !== "function")
    throw new TypeError("Redis connection factory must be callable")
  const options: CapturedRedisCacheOptions = captureRedisCacheOptions(construction)
  const connection = factory(options)
  let state: RedisCacheState = "idle"
  let active = 0
  const terminal = completion()

  /** Starts graceful connection close after every admitted operation releases. */
  async function finishStop(): Promise<void> {
    if (state !== "stopping" || active !== 0) return
    try {
      await connection.close()
    } catch (value) {
      try {
        await connection.destroy()
      } catch {
        // The close failure remains the owner terminal fact.
      }
      state = "failed"
      terminal.reject(newRedisCacheOperationError("close", normalizeRedisError(value)))
      return
    }
    state = "stopped"
    terminal.resolve()
  }

  /** Admits one running operation and returns its one-shot owner release. */
  function admit(ctx: Context, operation: RedisCacheOperation): () => void {
    const failure = contextFailure(ctx)
    if (failure !== null) throw failure
    if (state !== "running") throw newRedisCacheStateError(operation, state)
    active += 1
    /** Releases this internally owned operation exactly once. */
    function release(): void {
      active -= 1
      void finishStop()
    }
    return release
  }

  /** Starts or joins the unique owner drain. */
  function stop(ctx: Context): Promise<void> {
    if (state === "idle") return Promise.reject(newRedisCacheStateError("stop", state))
    if (state === "starting") state = "stopping"
    if (state === "running") {
      state = "stopping"
      void finishStop()
    }
    return waitForContext(ctx, terminal.promise)
  }

  return Object.freeze({
    /** Connects and runs the lifecycle-owned Redis client until it stops. */
    async start(ctx: Context): Promise<void> {
      if (state !== "idle") throw newRedisCacheStateError("start", state)
      state = "starting"
      const failure = contextFailure(ctx)
      if (failure !== null) {
        try {
          await connection.destroy()
        } catch {
          // The Context cancellation remains the startup result.
        }
        state = "failed"
        terminal.resolve()
        throw failure
      }
      try {
        await waitForContext(ctx, connection.connect())
      } catch (value) {
        try {
          await connection.destroy()
        } catch {
          // The connect or Context failure remains primary.
        }
        state = "failed"
        terminal.resolve()
        throw operationFailure(ctx, "connect", value)
      }
      if (state === "starting") state = "running"
      else void finishStop()
      return terminal.promise
    },
    /** Starts or joins Cache drain while Context scopes only this caller. */
    stop,
    /** Reads and decodes one exact Redis cache key. */
    async get(ctx: Context, rawKey: string): Promise<Uint8Array | null> {
      const release = admit(ctx, "get")
      try {
        const key = `${options.prefix}${cacheKey(rawKey)}`
        let value: string | null
        try {
          value = await connection.get(ctx.done(), key)
        } catch (failure) {
          throw operationFailure(ctx, "get", failure)
        }
        return value === null ? null : decodeRedisCacheValue(value, MaximumValueBytes)
      } finally {
        release()
      }
    },
    /** Encodes and writes one exact Redis cache key. */
    async put(
      ctx: Context,
      rawKey: string,
      rawValue: Uint8Array,
      ...functionalOptions: readonly PutOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
    ): Promise<void> {
      const release = admit(ctx, "put")
      try {
        const key = `${options.prefix}${cacheKey(rawKey)}`
        const value = encodeRedisCacheValue(cacheValue(rawValue))
        const resolved = putOptions(functionalOptions)
        const ttl = resolved.expiresInMs
        try {
          await connection.put(ctx.done(), key, value, ttl)
        } catch (failure) {
          throw operationFailure(ctx, "put", failure)
        }
      } finally {
        release()
      }
    },
    /** Deletes one exact Redis cache key. */
    async delete(ctx: Context, rawKey: string): Promise<void> {
      const release = admit(ctx, "delete")
      try {
        const key = `${options.prefix}${cacheKey(rawKey)}`
        try {
          await connection.remove(ctx.done(), key)
        } catch (failure) {
          throw operationFailure(ctx, "delete", failure)
        }
      } finally {
        release()
      }
    },
    /** Returns the stable provider diagnostic name. */
    string(): string {
      return "redis"
    }
  })
}

/** Creates one official node-redis-backed lifecycle-owned Cache. */
export function newRedisCache(options: RedisCacheOptions): Cache & Server {
  return createRedisCache(options)
}

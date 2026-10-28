import { createClient } from "@redis/client"

import { normalizeRedisError } from "./errors"
import type { CapturedRedisCacheOptions } from "./options"
import type { RedisCacheClient, RedisCacheCommandClient } from "./types"

/** Defines the exact vendor capability retained by the Cache lifecycle. */
export interface RedisConnection {
  connect(): Promise<void>
  get(signal: AbortSignal | null, key: string): Promise<string | null>
  put(
    signal: AbortSignal | null,
    key: string,
    value: string,
    expiresInMs: number | null
  ): Promise<void>
  remove(signal: AbortSignal | null, key: string): Promise<number>
  close(): Promise<void>
  destroy(): void | Promise<void>
}

/** Creates one connection capability from a captured construction snapshot. */
export type RedisConnectionFactory = (options: CapturedRedisCacheOptions) => RedisConnection

/** Observes an intentionally detached callback rejection. */
function ignoreCallbackFailure(_error: unknown): void {}

/** Reports whether a value carries the shared official node-redis capability. */
function isRedisClient(value: unknown): value is RedisCacheClient {
  if (typeof value !== "object" || value === null) return false
  return (
    typeof Reflect.get(value, "isOpen") === "boolean" &&
    typeof Reflect.get(value, "on") === "function" &&
    typeof Reflect.get(value, "off") === "function" &&
    typeof Reflect.get(value, "withCommandOptions") === "function" &&
    typeof Reflect.get(value, "connect") === "function" &&
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "destroy") === "function"
  )
}

/** Narrows the shared official node-redis lifecycle and command capability. */
function redisClient(value: unknown): RedisCacheClient {
  if (!isRedisClient(value)) {
    throw new TypeError("Redis Cache client factory must return an official node-redis client")
  }
  if (value.isOpen) throw new TypeError("Redis Cache client must not already be open")
  return value
}

/** Creates the official node-redis connection wrapper without starting network I/O. */
export function newRedisConnection(options: CapturedRedisCacheOptions): RedisConnection {
  let created: unknown
  if (options.client === null) {
    if (options.url === null) throw new TypeError("Redis Cache captured url is missing")
    created = createClient({
      url: options.url,
      socket: { connectTimeout: options.connectTimeoutMs },
      commandOptions: { timeout: options.commandTimeoutMs }
    })
  } else created = options.client()
  const client = redisClient(created)
  let listening = true

  /** Reports Redis background errors without allowing a user callback to crash the client. */
  function report(value: unknown): void {
    if (options.onError === null) return
    try {
      const result = options.onError(normalizeRedisError(value))
      void Promise.resolve(result).catch(ignoreCallbackFailure)
    } catch {
      return
    }
  }

  client.on("error", report)

  /** Removes the exact client error listener at most once. */
  function stopListening(): void {
    if (!listening) return
    listening = false
    client.off("error", report)
  }

  /** Selects one command facade carrying the caller signal and stable timeout. */
  function command(signal: AbortSignal | null): RedisCacheCommandClient {
    return signal === null
      ? client.withCommandOptions({ timeout: options.commandTimeoutMs })
      : client.withCommandOptions({ abortSignal: signal, timeout: options.commandTimeoutMs })
  }

  return Object.freeze({
    /** Opens the unique Redis client connection. */
    async connect(): Promise<void> {
      await client.connect()
    },
    /** Reads one Redis string carrier. */
    async get(signal: AbortSignal | null, key: string): Promise<string | null> {
      return await command(signal).get(key)
    },
    /** Writes one Redis string carrier with optional millisecond expiry. */
    async put(
      signal: AbortSignal | null,
      key: string,
      value: string,
      expiresInMs: number | null
    ): Promise<void> {
      const result =
        expiresInMs === null
          ? await command(signal).set(key, value)
          : await command(signal).set(key, value, {
              expiration: { type: "PX", value: expiresInMs }
            })
      if (result !== "OK") throw new Error("Redis SET returned an unexpected reply")
    },
    /** Deletes one exact Redis key. */
    async remove(signal: AbortSignal | null, key: string): Promise<number> {
      return await command(signal).del(key)
    },
    /** Gracefully closes after already-admitted commands settle. */
    async close(): Promise<void> {
      try {
        await client.close()
      } finally {
        stopListening()
      }
    },
    /** Immediately destroys a failed or canceled connection attempt. */
    async destroy(): Promise<void> {
      try {
        await client.destroy()
      } finally {
        stopListening()
      }
    }
  })
}

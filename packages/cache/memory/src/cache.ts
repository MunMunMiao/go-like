import type { PutOption } from "@likego/cache"
import { putOptions } from "@likego/cache/provider"
import { cause, type Context } from "@likego/context"

import { memoryCacheOptions } from "./options"
import type { MemoryCache, MemoryCacheClock, MemoryCacheOption } from "./types"

interface MemoryEntry {
  readonly value: Uint8Array
  readonly expiresAt: number | null
}

const MinimumTTLMilliseconds = 1
const MaximumTTLMilliseconds = 2_147_483_647
const MaximumKeyBytes = 4_096
const MaximumValueBytes = 16_777_216
const Encoder = new TextEncoder()

/** Reports whether a string contains no unmatched UTF-16 surrogate code units. */
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

/** Returns the exact cancellation carried by one terminal Context. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Rejects an operation admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Validates one exact non-empty Cache key and its UTF-8 provider bound. */
function cacheKey(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError("Memory Cache key must be a non-empty well-formed string")
  }
  if (Encoder.encode(value).byteLength > MaximumKeyBytes) {
    throw new RangeError("Memory Cache key exceeds maximumKeyBytes")
  }
  return value
}

/** Copies one admitted Cache value after validating its provider bound. */
function cacheValue(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError("Memory Cache value must be Uint8Array")
  if (value.byteLength > MaximumValueBytes) {
    throw new RangeError("Memory Cache value exceeds maximumValueBytes")
  }
  return value.slice()
}

/** Reads and validates one exact non-negative safe integer millisecond timestamp. */
function timestamp(selectedClock: MemoryCacheClock): number {
  const value = selectedClock()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Memory Cache clock must return a non-negative safe integer")
  }
  return value
}

/** Resolves one optional expiry timestamp inside the declared provider bounds. */
function expiry(selectedClock: MemoryCacheClock, durationMs: number | null): number | null {
  if (durationMs === null) return null
  if (durationMs < MinimumTTLMilliseconds || durationMs > MaximumTTLMilliseconds) {
    throw new RangeError("Memory Cache ttl is outside provider bounds")
  }
  const expiresAt = timestamp(selectedClock) + durationMs
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError("Memory Cache expiry exceeds safe timestamp bounds")
  }
  return expiresAt
}

/** Creates one immediately usable process-local Cache without resident resources. */
export function newMemoryCache(
  ...options: readonly MemoryCacheOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
): MemoryCache {
  const selected = memoryCacheOptions(options)
  const entries = new Map<string, MemoryEntry>()

  /** Returns one unexpired entry and lazily removes expiry misses. */
  function activeEntry(key: string): MemoryEntry | null {
    const entry = entries.get(key)
    if (entry === undefined) return null
    if (entry.expiresAt !== null && entry.expiresAt <= timestamp(selected.clock)) {
      entries.delete(key)
      return null
    }
    return entry
  }

  const cache: MemoryCache = {
    async get(ctx: Context, key: string): Promise<Uint8Array | null> {
      checkContext(ctx)
      const entry = activeEntry(cacheKey(key))
      return entry === null ? null : entry.value.slice()
    },
    async put(
      ctx: Context,
      key: string,
      value: Uint8Array,
      ...putOption: readonly PutOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
    ): Promise<void> {
      checkContext(ctx)
      const selectedKey = cacheKey(key)
      const selectedValue = cacheValue(value)
      const resolved = putOptions(putOption)
      const expiresAt = expiry(selected.clock, resolved.expiresInMs)
      entries.set(selectedKey, Object.freeze({ value: selectedValue, expiresAt }))
    },
    async delete(ctx: Context, key: string): Promise<void> {
      checkContext(ctx)
      entries.delete(cacheKey(key))
    },
    string(): "memory" {
      return "memory"
    }
  }
  return Object.freeze(cache)
}

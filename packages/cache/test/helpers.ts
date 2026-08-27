/// <reference lib="es2024.promise" />

import { cause, type Context } from "@go-like/context"

import type { Cache } from "../src/index"
import { putOptions } from "../src/provider"

interface TestEntry {
  readonly value: Uint8Array
  readonly expiresAt: number | null
}

export interface TestClock {
  /** Returns the current deterministic millisecond timestamp. */
  now(): number
  /** Advances the deterministic millisecond timestamp. */
  advance(milliseconds: number): void
}

/** Creates one deterministic mutable clock for conformance tests. */
export function testClock(initial: number = 1_000): TestClock {
  let current = initial
  return {
    now(): number {
      return current
    },
    advance(milliseconds: number): void {
      current += milliseconds
    }
  }
}

/** Creates one isolated or explicitly shared test backend. */
export function testBackend(): Map<string, TestEntry> {
  return new Map<string, TestEntry>()
}

/** Returns the exact cancellation carried by one terminal Context. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Rejects a test operation admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Creates one small provider used only to exercise the internal conformance suite. */
export function testCache(
  backend: Map<string, TestEntry> = testBackend(),
  ttl: boolean = true,
  selectedClock: TestClock = testClock()
): Cache {
  /** Returns one unexpired provider entry and lazily removes expiry misses. */
  function activeEntry(key: string): TestEntry | null {
    const entry = backend.get(key)
    if (entry === undefined) return null
    if (entry.expiresAt !== null && entry.expiresAt <= selectedClock.now()) {
      backend.delete(key)
      return null
    }
    return entry
  }

  return {
    async get(ctx, key) {
      checkContext(ctx)
      const entry = activeEntry(key)
      return entry === null ? null : entry.value.slice()
    },
    async put(ctx, key, value, ...options) {
      checkContext(ctx)
      const selected = putOptions(options)
      if (selected.expiresInMs !== null && !ttl) {
        throw new RangeError("Test Cache ttl is unsupported")
      }
      const expiresAt =
        selected.expiresInMs === null ? null : selectedClock.now() + selected.expiresInMs
      backend.set(key, Object.freeze({ value: value.slice(), expiresAt }))
    },
    async delete(ctx, key) {
      checkContext(ctx)
      if (activeEntry(key) === null) return
      backend.delete(key)
    },
    string() {
      return "test"
    }
  }
}

/** Creates one exact Cache pair without a tuple assertion. */
export function cachePair(first: Cache, second: Cache): readonly [Cache, Cache] {
  return [first, second]
}

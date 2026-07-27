import { background, cause, withCancel, withTimeout, type Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"

import { expiresIn } from "./options"
import type { Cache } from "./types"

/** Defines one runner-neutral executable Cache conformance case. */
export interface CacheConformanceCase {
  readonly name: string
  /** Runs one isolated semantic assertion against fresh provider state. */
  readonly run: () => Promise<void>
}

/** Supplies fresh provider state and selected provider limits to Cache conformance. */
export interface CacheConformanceSubject<T extends Cache = Cache> {
  /** Creates one synchronous, I/O-free Cache attached to isolated backend state. */
  readonly createCache: () => T
  /** Creates two clients for one isolated shared backend when cross-client checks apply. */
  readonly createSharedCaches?: () => readonly [T, T]
  /** Runs one case while the provider owns any setup and cleanup outside the Cache contract. */
  readonly useCache?: (cache: T, run: (cache: T) => PromiseLike<void>) => PromiseLike<void>
  /** Advances a deterministic provider clock; real providers may omit this hook. */
  readonly advanceTime?: (milliseconds: number) => void | PromiseLike<void>
  /** Bounds each operation and eventual convergence; defaults to 5,000 milliseconds. */
  readonly convergenceTimeoutMs?: number
  /** Selects one supported TTL used by expiry conformance. */
  readonly ttlMs?: number
}

interface CapturedSubject<T extends Cache> {
  readonly receiver: CacheConformanceSubject<T>
  readonly createCache: CacheConformanceSubject<T>["createCache"]
  readonly createSharedCaches: CacheConformanceSubject<T>["createSharedCaches"]
  readonly useCache: CacheConformanceSubject<T>["useCache"]
  readonly advanceTime: CacheConformanceSubject<T>["advanceTime"]
  readonly convergenceTimeoutMs: number
  readonly ttlMs: number | null
}

const DefaultConvergenceTimeoutMs = 5_000
const MaximumTimerMs = 2_147_483_647
const PollIntervalMs = 10

/** Fails one conformance assertion with a stable provider-neutral diagnostic. */
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Cache conformance failed: ${message}`)
}

/** Reports whether a value can structurally carry Cache methods. */
function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** Validates one positive bounded conformance duration. */
function timeout(value: number | undefined): number {
  const selected = value ?? DefaultConvergenceTimeoutMs
  if (!Number.isInteger(selected) || selected < 1 || selected > MaximumTimerMs) {
    throw new RangeError("Cache conformance convergenceTimeoutMs is invalid")
  }
  return selected
}

/** Validates one structural provider-neutral Cache. */
function validateCache(value: Cache): void {
  if (
    !isObjectLike(value) ||
    typeof value.get !== "function" ||
    typeof value.put !== "function" ||
    typeof value.delete !== "function" ||
    typeof value.string !== "function"
  ) {
    throw new TypeError("Cache conformance factory must return a Cache")
  }
}

/** Captures and validates one conformance subject before publishing cases. */
function captureSubject<T extends Cache>(value: CacheConformanceSubject<T>): CapturedSubject<T> {
  if (!isObjectLike(value) || typeof value.createCache !== "function") {
    throw new TypeError("Cache conformance subject is invalid")
  }
  if (value.createSharedCaches !== undefined && typeof value.createSharedCaches !== "function") {
    throw new TypeError("Cache conformance createSharedCaches must be callable")
  }
  if (value.useCache !== undefined && typeof value.useCache !== "function") {
    throw new TypeError("Cache conformance useCache must be callable")
  }
  const convergenceTimeoutMs = timeout(value.convergenceTimeoutMs)
  const ttlMs = value.ttlMs ?? null
  if (ttlMs !== null) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MaximumTimerMs) {
      throw new RangeError("Cache conformance ttlMs is invalid")
    }
    if (value.advanceTime === undefined && ttlMs >= convergenceTimeoutMs) {
      throw new RangeError("Cache conformance ttlMs must fit the convergence timeout")
    }
  } else if (value.advanceTime !== undefined) {
    throw new TypeError("Cache conformance advanceTime requires ttlMs")
  }
  return Object.freeze({
    receiver: value,
    createCache: value.createCache,
    createSharedCaches: value.createSharedCaches,
    useCache: value.useCache,
    advanceTime: value.advanceTime,
    convergenceTimeoutMs,
    ttlMs
  })
}

/** Returns one fresh structurally valid Cache from an unbound subject factory. */
function freshCache<T extends Cache>(subject: CapturedSubject<T>): T {
  const cache = subject.createCache.call(subject.receiver)
  validateCache(cache)
  return cache
}

/** Returns two distinct structurally valid clients for one fresh shared backend. */
function freshSharedCaches<T extends Cache>(subject: CapturedSubject<T>): readonly [T, T] {
  const factory = subject.createSharedCaches
  if (factory === undefined) throw new TypeError("shared Cache factory is missing")
  const caches = factory.call(subject.receiver)
  if (!Array.isArray(caches) || caches.length !== 2) {
    throw new TypeError("shared Cache factory must return exactly two Caches")
  }
  const first = caches[0]
  const second = caches[1]
  if (first === undefined || second === undefined || first === second) {
    throw new TypeError("shared Cache factory must return two distinct Caches")
  }
  validateCache(first)
  validateCache(second)
  return [first, second]
}

/** Normalizes an untrusted conformance rejection without stringifying it. */
function normalizeError(value: unknown): Error {
  return value instanceof Error
    ? value
    : Object.freeze(new Error("Cache conformance observed a non-Error rejection"))
}

/** Runs one operation under a portable conformance-owned Context deadline. */
async function bounded<T>(
  timeoutMs: number,
  operation: (ctx: Context) => PromiseLike<T>
): Promise<T> {
  const timed = withTimeout(background(), timeoutMs)
  try {
    const promise = Promise.resolve().then(function invoke(): PromiseLike<T> {
      return operation(timed[0])
    })
    return await waitForContext(timed[0], promise)
  } finally {
    timed[1]()
  }
}

/** Runs one Cache under provider-specific setup and cleanup when supplied. */
async function useCache<T extends Cache>(
  subject: CapturedSubject<T>,
  cache: T,
  run: (cache: T) => PromiseLike<void>
): Promise<void> {
  if (subject.useCache === undefined) {
    await run(cache)
    return
  }
  await subject.useCache.call(subject.receiver, cache, run)
}

/** Runs one started Cache case while preserving ordered cleanup failures. */
async function withCache<T extends Cache>(
  subject: CapturedSubject<T>,
  cleanupKey: string,
  run: (cache: T) => PromiseLike<void>
): Promise<void> {
  await useCache(subject, freshCache(subject), async function verify(cache): Promise<void> {
    let primary: Error | null = null
    try {
      await run(cache)
    } catch (value) {
      primary = normalizeError(value)
    }
    let cleanup: Error | null = null
    try {
      await bounded(subject.convergenceTimeoutMs, function remove(ctx): Promise<void> {
        return cache.delete(ctx, cleanupKey)
      })
    } catch (value) {
      cleanup = normalizeError(value)
    }
    if (primary !== null && cleanup !== null) {
      throw Object.freeze(
        new AggregateError([primary, cleanup], "Cache conformance cleanup failed")
      )
    }
    if (primary !== null) throw primary
    if (cleanup !== null) throw cleanup
  })
}

/** Releases one short polling turn without retaining provider state. */
function convergenceTurn(): Promise<void> {
  return new Promise<void>(function release(resolve): void {
    setTimeout(resolve, PollIntervalMs)
  })
}

/** Waits until one Cache observes a requested value or absence. */
async function waitForValue(
  cache: Cache,
  key: string,
  expected: number | null,
  timeoutMs: number
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const value = await bounded(timeoutMs, function read(ctx): Promise<Uint8Array | null> {
      return cache.get(ctx, key)
    })
    if ((value === null && expected === null) || value?.[0] === expected) return
    await convergenceTurn()
  }
  throw new Error("Cache conformance timed out waiting for backend convergence")
}

/** Advances deterministic time or waits against one real provider clock. */
async function expire<T extends Cache>(
  subject: CapturedSubject<T>,
  milliseconds: number
): Promise<void> {
  if (subject.advanceTime !== undefined) {
    await subject.advanceTime.call(subject.receiver, milliseconds)
    return
  }
  await new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, milliseconds + 1)
  })
}

/** Builds stable diagnostic-name conformance. */
function identityCase<T extends Cache>(subject: CapturedSubject<T>): CacheConformanceCase {
  return Object.freeze({
    name: "string returns one stable provider name",
    async run(): Promise<void> {
      const cache = freshCache(subject)
      const name = cache.string()
      ensure(typeof name === "string" && name.length > 0, "Cache.string returned an empty name")
      ensure(cache.string() === name, "Cache.string was not stable")
    }
  })
}

/** Builds missing-value, CRUD, overwrite, and defensive-copy conformance. */
function crudCase<T extends Cache>(subject: CapturedSubject<T>): CacheConformanceCase {
  return Object.freeze({
    name: "get put and delete preserve byte ownership",
    async run(): Promise<void> {
      const key = "conformance/crud"
      await withCache(subject, key, async function verify(cache): Promise<void> {
        ensure((await cache.get(background(), key)) === null, "missing get did not return null")
        const input = new Uint8Array([1, 2])
        await cache.put(background(), key, input)
        input[0] = 9
        const first = await cache.get(background(), key)
        ensure(first?.[0] === 1, "put retained caller-owned bytes")
        if (first !== null) first[0] = 8
        const second = await cache.get(background(), key)
        ensure(second?.[0] === 1, "get exposed provider-owned bytes")
        await cache.put(background(), key, new Uint8Array([3]))
        ensure((await cache.get(background(), key))?.[0] === 3, "put did not replace the value")
        await cache.delete(background(), key)
        ensure((await cache.get(background(), key)) === null, "delete did not remove the value")
        await cache.delete(background(), key)
      })
    }
  })
}

/** Builds conditional TTL support and expiry visibility conformance. */
function ttlCase<T extends Cache>(subject: CapturedSubject<T>): CacheConformanceCase {
  return Object.freeze({
    name: "ttl is explicit and expiry is a miss",
    async run(): Promise<void> {
      const key = "conformance/ttl"
      await withCache(subject, key, async function verify(cache): Promise<void> {
        if (subject.ttlMs === null) {
          let rejected = false
          try {
            await cache.put(background(), key, new Uint8Array([1]), expiresIn(1))
          } catch {
            rejected = true
          }
          ensure(rejected, "unsupported ttl was accepted")
          ensure((await cache.get(background(), key)) === null, "rejected ttl mutated state")
          return
        }
        const ttlMs = subject.ttlMs
        ensure(ttlMs !== null, "Cache ttl test duration was missing")
        await cache.put(background(), key, new Uint8Array([1]), expiresIn(ttlMs))
        ensure(
          (await cache.get(background(), key)) !== null,
          "ttl value was not immediately visible"
        )
        await expire(subject, ttlMs)
        ensure((await cache.get(background(), key)) === null, "expired value remained visible")
        await cache.delete(background(), key)
      })
    }
  })
}

/** Builds pre-canceled operation admission conformance. */
function cancellationCase<T extends Cache>(subject: CapturedSubject<T>): CacheConformanceCase {
  return Object.freeze({
    name: "pre-canceled operations fail before mutating provider state",
    async run(): Promise<void> {
      const key = "conformance/canceled"
      await withCache(subject, key, async function verify(cache): Promise<void> {
        const canceledContext = withCancel(background())
        canceledContext[1]()
        const expected = cause(canceledContext[0]) ?? canceledContext[0].err()
        let observed: unknown = null
        try {
          await cache.put(canceledContext[0], key, new Uint8Array([1]))
        } catch (value) {
          observed = value
        }
        ensure(observed === expected, "pre-canceled put did not preserve Context cause")
        ensure((await cache.get(background(), key)) === null, "pre-canceled put mutated state")
      })
    }
  })
}

/** Builds cross-client visibility conformance for shared-writer providers. */
function sharedWriterCase<T extends Cache>(subject: CapturedSubject<T>): CacheConformanceCase {
  return Object.freeze({
    name: "shared writers observe put and delete across clients",
    async run(): Promise<void> {
      const caches = freshSharedCaches(subject)
      await useCache(subject, caches[0], async function firstActive(first): Promise<void> {
        await useCache(subject, caches[1], async function secondActive(second): Promise<void> {
          await first.put(background(), "conformance/shared", new Uint8Array([7]))
          await waitForValue(second, "conformance/shared", 7, subject.convergenceTimeoutMs)
          await second.delete(background(), "conformance/shared")
          await waitForValue(first, "conformance/shared", null, subject.convergenceTimeoutMs)
          await first.delete(background(), "conformance/shared")
        })
      })
    }
  })
}

/** Returns the complete immutable provider-neutral Cache conformance suite. */
export function cacheConformanceCases<T extends Cache>(
  subject: CacheConformanceSubject<T>
): readonly CacheConformanceCase[] {
  const captured = captureSubject(subject)
  const cases: CacheConformanceCase[] = [
    identityCase(captured),
    crudCase(captured),
    ttlCase(captured),
    cancellationCase(captured)
  ]
  if (captured.createSharedCaches !== undefined) cases.push(sharedWriterCase(captured))
  return Object.freeze(cases)
}

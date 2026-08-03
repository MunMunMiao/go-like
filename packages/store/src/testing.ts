import { background, cause, withCancel, withTimeout, type Context } from "@likego/context"

import { expiresIn, ifAbsent, ifRevision, limit, prefix, cursor as resume } from "./options"
import type { Store, StoreRecord, StoreRecordInput } from "./types"

/** Defines one runner-neutral executable Store conformance case. */
export interface StoreConformanceCase {
  readonly name: string
  /** Runs one isolated semantic assertion against fresh provider state. */
  readonly run: () => Promise<void>
}

/** Describes provider semantics used only to select portable conformance cases. */
export interface StoreConformanceLimits {
  readonly ttl: {
    readonly minimumMs: number
    readonly maximumMs: number
  } | null
  readonly cas: boolean
  readonly sharedWriters: boolean
}

/** Supplies fresh provider state and test-only limits to Store conformance. */
export interface StoreConformanceSubject {
  readonly limits: StoreConformanceLimits
  /** Creates one synchronous, I/O-free Store attached to isolated backend state. */
  readonly createStore: () => Store
  /** Creates two synchronous clients for one isolated backend when sharedWriters is true. */
  readonly createSharedStores?: () => readonly [Store, Store]
  /** Prepares one provider that owns resources outside the Store contract. */
  readonly prepareStore?: (ctx: Context, store: Store) => PromiseLike<void>
  /** Releases resources prepared for one Store after cleanup. */
  readonly releaseStore?: (ctx: Context, store: Store) => PromiseLike<void>
  /** Bounds each operation and eventual convergence; defaults to 5,000 milliseconds. */
  readonly convergenceTimeoutMs?: number
  /** Selects one supported TTL used by expiry conformance. */
  readonly ttlMs?: number
}

interface CapturedSubject {
  readonly receiver: StoreConformanceSubject
  readonly limits: StoreConformanceLimits
  readonly createStore: StoreConformanceSubject["createStore"]
  readonly createSharedStores: StoreConformanceSubject["createSharedStores"]
  readonly prepareStore: StoreConformanceSubject["prepareStore"]
  readonly releaseStore: StoreConformanceSubject["releaseStore"]
  readonly convergenceTimeoutMs: number
  readonly ttlMs: number | null
}

const DefaultConvergenceTimeoutMs = 5_000
const MaximumTimerMs = 2_147_483_647
const PollIntervalMs = 10

/** Fails one conformance assertion with a stable provider-neutral diagnostic. */
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Store conformance failed: ${message}`)
}

/** Reports whether a value can structurally carry Store methods. */
function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** Validates one positive bounded conformance duration. */
function timeout(value: number | undefined): number {
  const selected = value ?? DefaultConvergenceTimeoutMs
  if (!Number.isInteger(selected) || selected < 1 || selected > MaximumTimerMs) {
    throw new RangeError("Store conformance convergenceTimeoutMs is invalid")
  }
  return selected
}

/** Validates and freezes the provider limits supplied to conformance. */
function captureLimits(value: StoreConformanceLimits): StoreConformanceLimits {
  if (
    !isObjectLike(value) ||
    typeof value.cas !== "boolean" ||
    typeof value.sharedWriters !== "boolean"
  ) {
    throw new TypeError("Store conformance limits are invalid")
  }
  if (value.ttl === null) {
    return Object.freeze({ ttl: null, cas: value.cas, sharedWriters: value.sharedWriters })
  }
  if (
    !isObjectLike(value.ttl) ||
    !Number.isSafeInteger(value.ttl.minimumMs) ||
    !Number.isSafeInteger(value.ttl.maximumMs) ||
    value.ttl.minimumMs < 1 ||
    value.ttl.minimumMs > value.ttl.maximumMs
  ) {
    throw new RangeError("Store conformance ttl limits are invalid")
  }
  return Object.freeze({
    ttl: Object.freeze({
      minimumMs: value.ttl.minimumMs,
      maximumMs: value.ttl.maximumMs
    }),
    cas: value.cas,
    sharedWriters: value.sharedWriters
  })
}

/** Validates one structural Store without starting provider I/O. */
function validateStore(value: Store): void {
  if (
    !isObjectLike(value) ||
    typeof value.read !== "function" ||
    typeof value.write !== "function" ||
    typeof value.delete !== "function" ||
    typeof value.list !== "function" ||
    typeof value.string !== "function"
  ) {
    throw new TypeError("Store conformance factory must return a Store")
  }
}

/** Captures and validates one conformance subject before publishing cases. */
function captureSubject(value: StoreConformanceSubject): CapturedSubject {
  if (!isObjectLike(value) || typeof value.createStore !== "function") {
    throw new TypeError("Store conformance subject is invalid")
  }
  const limits = captureLimits(value.limits)
  if (limits.sharedWriters && typeof value.createSharedStores !== "function") {
    throw new TypeError("shared-writer conformance requires createSharedStores")
  }
  if (value.prepareStore !== undefined && typeof value.prepareStore !== "function") {
    throw new TypeError("Store conformance prepareStore must be a function")
  }
  if (value.releaseStore !== undefined && typeof value.releaseStore !== "function") {
    throw new TypeError("Store conformance releaseStore must be a function")
  }
  let ttlMs: number | null = null
  if (limits.ttl !== null) {
    ttlMs = value.ttlMs ?? limits.ttl.minimumMs
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < limits.ttl.minimumMs ||
      ttlMs > limits.ttl.maximumMs
    ) {
      throw new RangeError("Store conformance ttlMs is outside provider bounds")
    }
  } else if (value.ttlMs !== undefined) {
    throw new TypeError("Store conformance ttlMs requires TTL support")
  }
  return Object.freeze({
    receiver: value,
    limits,
    createStore: value.createStore,
    createSharedStores: value.createSharedStores,
    prepareStore: value.prepareStore,
    releaseStore: value.releaseStore,
    convergenceTimeoutMs: timeout(value.convergenceTimeoutMs),
    ttlMs
  })
}

/** Returns one fresh structurally valid Store from an unbound subject factory. */
function freshStore(subject: CapturedSubject): Store {
  const store = subject.createStore.call(subject.receiver)
  validateStore(store)
  return store
}

/** Returns two distinct structurally valid clients for one fresh shared backend. */
function freshSharedStores(subject: CapturedSubject): readonly [Store, Store] {
  const factory = subject.createSharedStores
  if (factory === undefined) throw new TypeError("shared Store factory is missing")
  const stores = factory.call(subject.receiver)
  if (!Array.isArray(stores) || stores.length !== 2) {
    throw new TypeError("shared Store factory must return exactly two Stores")
  }
  const first = stores[0]
  const second = stores[1]
  if (first === undefined || second === undefined || first === second) {
    throw new TypeError("shared Store factory must return two distinct Stores")
  }
  validateStore(first)
  validateStore(second)
  return Object.freeze([first, second])
}

/** Normalizes an untrusted conformance rejection without stringifying it. */
function normalizeError(value: unknown): Error {
  return value instanceof Error
    ? value
    : Object.freeze(new Error("Store conformance observed a non-Error rejection"))
}

/** Runs one operation under a portable conformance-owned Context deadline. */
async function bounded<T>(
  timeoutMs: number,
  operation: (ctx: Context) => PromiseLike<T>
): Promise<T> {
  const [ctx, cancel] = withTimeout(background(), timeoutMs)
  try {
    return await Promise.resolve().then(() => operation(ctx))
  } finally {
    cancel()
  }
}

/** Runs one started Store case while preserving ordered cleanup failures. */
async function withStore(
  subject: CapturedSubject,
  cleanupKeys: readonly string[],
  run: (store: Store) => PromiseLike<void>
): Promise<void> {
  const store = freshStore(subject)
  if (subject.prepareStore !== undefined) {
    await bounded(
      subject.convergenceTimeoutMs,
      (ctx) => subject.prepareStore?.call(subject.receiver, ctx, store) ?? Promise.resolve()
    )
  }
  let primary: Error | null = null
  try {
    await run(store)
  } catch (value) {
    primary = normalizeError(value)
  }
  const cleanup: Error[] = []
  for (const key of cleanupKeys) {
    try {
      await bounded(subject.convergenceTimeoutMs, (ctx) => store.delete(ctx, key))
    } catch (value) {
      cleanup.push(normalizeError(value))
    }
  }
  if (subject.releaseStore !== undefined) {
    try {
      await bounded(
        subject.convergenceTimeoutMs,
        (ctx) => subject.releaseStore?.call(subject.receiver, ctx, store) ?? Promise.resolve()
      )
    } catch (value) {
      cleanup.push(normalizeError(value))
    }
  }
  if (primary !== null && cleanup.length > 0) {
    const failures: Error[] = [primary]
    for (const failure of cleanup) failures.push(failure)
    throw Object.freeze(new AggregateError(failures, "Store conformance cleanup failed"))
  }
  if (primary !== null) throw primary
  if (cleanup.length === 1 && cleanup[0] !== undefined) throw cleanup[0]
  if (cleanup.length > 1) {
    throw Object.freeze(new AggregateError(cleanup, "Store conformance cleanup failed"))
  }
}

/** Asserts one stable framework-owned error code. */
async function rejectsCode(operation: () => PromiseLike<unknown>, code: string): Promise<void> {
  let observed: unknown = null
  try {
    await operation()
  } catch (value) {
    observed = value
  }
  ensure(isObjectLike(observed) && "code" in observed && observed.code === code, `expected ${code}`)
  ensure(Object.isFrozen(observed), `${code} was not immutable`)
}

/** Asserts that a provider rejects an unsupported option before silently weakening it. */
async function rejectsTypeError(operation: () => PromiseLike<unknown>): Promise<void> {
  let observed: unknown = null
  try {
    await operation()
  } catch (value) {
    observed = value
  }
  ensure(observed instanceof TypeError, "unsupported Store option did not reject with TypeError")
}

/** Creates one small deterministic write input. */
function input(
  key: string,
  value: Uint8Array = new Uint8Array([1]),
  metadata: Readonly<Record<string, string>> = {}
): StoreRecordInput {
  return { key, value, metadata }
}

/** Waits one short portable turn before rechecking backend convergence. */
function convergenceTurn(): Promise<void> {
  return new Promise<void>(
    /** Releases one conformance polling turn. */
    function release(resolve): void {
      setTimeout(resolve, PollIntervalMs)
    }
  )
}

/** Waits until one read observes the requested revision or absence. */
async function waitForRecord(
  store: Store,
  key: string,
  revision: string | null,
  timeoutMs: number
): Promise<StoreRecord | null> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const record = await bounded(timeoutMs, (ctx) => store.read(ctx, key))
    if ((record === null && revision === null) || record?.revision === revision) return record
    await convergenceTurn()
  }
  throw new Error("Store conformance timed out waiting for backend convergence")
}

/** Builds exact CRUD, revision, and defensive-copy conformance. */
function crudCase(subject: CapturedSubject): StoreConformanceCase {
  return Object.freeze({
    name: "missing reads and CRUD return immutable defensive record snapshots",
    async run(): Promise<void> {
      await withStore(subject, ["conformance/crud"], async (store) => {
        const name = store.string()
        ensure(typeof name === "string" && name.length > 0, "Store.string returned an empty name")
        ensure(store.string() === name, "Store.string was not stable")
        const key = "conformance/crud"
        ensure(
          (await bounded(subject.convergenceTimeoutMs, (ctx) => store.read(ctx, key))) === null,
          "missing read did not return null"
        )
        const bytes = new Uint8Array([1, 2])
        const metadata = { owner: "first" }
        const written = await bounded(subject.convergenceTimeoutMs, (ctx) =>
          store.write(ctx, input(key, bytes, metadata))
        )
        bytes[0] = 9
        metadata.owner = "changed"
        ensure(Object.isFrozen(written), "written record was mutable")
        ensure(Object.isFrozen(written.metadata), "written metadata was mutable")
        ensure(written.value[0] === 1, "write retained caller bytes")
        ensure(written.metadata.owner === "first", "write retained caller metadata")
        const exposed = written.value
        exposed[0] = 8
        ensure(written.value[0] === 1, "record value getter exposed retained bytes")
        ensure(!Reflect.set(written.metadata, "owner", "mutated"), "record metadata was writable")
        const read = await bounded(subject.convergenceTimeoutMs, (ctx) => store.read(ctx, key))
        ensure(read?.value[0] === 1, "read observed caller mutation")
        const replaced = await bounded(subject.convergenceTimeoutMs, (ctx) =>
          store.write(ctx, input(key, new Uint8Array([3])))
        )
        ensure(replaced.revision !== written.revision, "overwrite did not advance revision")
        ensure(
          await bounded(subject.convergenceTimeoutMs, (ctx) => store.delete(ctx, key)),
          "delete did not report the removed record"
        )
        ensure(
          !(await bounded(subject.convergenceTimeoutMs, (ctx) => store.delete(ctx, key))),
          "second unconditional delete did not return false"
        )
      })
    }
  })
}

/** Builds prefix, Unicode ordering, page-limit, and cursor conformance. */
function listCase(subject: CapturedSubject): StoreConformanceCase {
  return Object.freeze({
    name: "list applies prefix, code-point ordering, limit, and opaque cursor",
    async run(): Promise<void> {
      const keys = ["list/z", "list/\u{10000}", "other/a", "list/a", "list/\u{e000}"]
      await withStore(subject, keys, async (store) => {
        for (const key of keys) {
          await bounded(subject.convergenceTimeoutMs, (ctx) => store.write(ctx, input(key)))
        }
        const expected = ["list/a", "list/z", "list/\u{e000}", "list/\u{10000}"]
        const observed: string[] = []
        let token: string | null = null
        for (;;) {
          const page = await bounded(subject.convergenceTimeoutMs, (ctx) =>
            token === null
              ? store.list(ctx, prefix("list/"), limit(2))
              : store.list(ctx, prefix("list/"), limit(2), resume(token))
          )
          ensure(Object.isFrozen(page), "Store page was mutable")
          ensure(Object.isFrozen(page.records), "Store page records were mutable")
          ensure(page.records.length <= 2, "Store page exceeded the requested limit")
          for (const record of page.records) observed.push(record.key)
          token = page.cursor
          if (token === null) break
          ensure(observed.length < 10, "Store cursor did not make progress")
        }
        ensure(JSON.stringify(observed) === JSON.stringify(expected), "Store list order differed")
      })
    }
  })
}

/** Builds conditional TTL support and expiry visibility conformance. */
function ttlCase(subject: CapturedSubject): StoreConformanceCase {
  return Object.freeze({
    name: "ttl support is explicit and expired records are invisible",
    async run(): Promise<void> {
      await withStore(subject, ["conformance/ttl"], async (store) => {
        const key = "conformance/ttl"
        if (subject.limits.ttl === null) {
          await rejectsTypeError(() =>
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              store.write(ctx, input(key), expiresIn(1))
            )
          )
          return
        }
        const ttlMs = subject.ttlMs
        ensure(ttlMs !== null, "Store ttl test duration was missing")
        const written = await bounded(subject.convergenceTimeoutMs, (ctx) =>
          store.write(ctx, input(key), expiresIn(ttlMs))
        )
        ensure(written.expiresAt !== null, "ttl write omitted expiresAt")
        ensure(
          (await bounded(subject.convergenceTimeoutMs, (ctx) => store.read(ctx, key))) !== null,
          "ttl record was not immediately visible"
        )
        await waitForRecord(store, key, null, subject.convergenceTimeoutMs)
        const expiredPage = await bounded(subject.convergenceTimeoutMs, (ctx) =>
          store.list(ctx, prefix(key))
        )
        ensure(expiredPage.records.length === 0, "expired ttl record remained list-visible")
        ensure(
          !(await bounded(subject.convergenceTimeoutMs, (ctx) => store.delete(ctx, key))),
          "expired ttl record remained delete-visible"
        )
      })
    }
  })
}

/** Builds conditional write/delete compare-and-swap conformance. */
function casCase(subject: CapturedSubject): StoreConformanceCase {
  return Object.freeze({
    name: "compare-and-swap support is explicit for write and delete",
    async run(): Promise<void> {
      await withStore(subject, ["conformance/cas"], async (store) => {
        const key = "conformance/cas"
        const initial = subject.limits.cas
          ? await bounded(subject.convergenceTimeoutMs, (ctx) =>
              store.write(ctx, input(key), ifAbsent())
            )
          : await bounded(subject.convergenceTimeoutMs, (ctx) => store.write(ctx, input(key)))
        if (!subject.limits.cas) {
          await rejectsTypeError(() =>
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              store.write(ctx, input(`${key}/absent`), ifAbsent())
            )
          )
          await rejectsTypeError(() =>
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              store.write(ctx, input(key), ifRevision(initial.revision))
            )
          )
          await rejectsTypeError(() =>
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              store.delete(ctx, key, ifRevision(initial.revision))
            )
          )
          await bounded(subject.convergenceTimeoutMs, (ctx) => store.delete(ctx, key))
          return
        }
        await rejectsCode(
          () =>
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              store.write(ctx, input(key, new Uint8Array([2])), ifAbsent())
            ),
          "LIKEGO_STORE_CONFLICT"
        )
        const stale = `stale:${initial.revision}`
        await rejectsCode(
          () =>
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              store.write(ctx, input(key, new Uint8Array([2])), ifRevision(stale))
            ),
          "LIKEGO_STORE_CONFLICT"
        )
        const updated = await bounded(subject.convergenceTimeoutMs, (ctx) =>
          store.write(ctx, input(key, new Uint8Array([2])), ifRevision(initial.revision))
        )
        ensure(updated.revision !== initial.revision, "successful CAS did not advance revision")
        await rejectsCode(
          () =>
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              store.delete(ctx, key, ifRevision(initial.revision))
            ),
          "LIKEGO_STORE_CONFLICT"
        )
        ensure(
          await bounded(subject.convergenceTimeoutMs, (ctx) =>
            store.delete(ctx, key, ifRevision(updated.revision))
          ),
          "delete CAS did not remove its exact revision"
        )
      })
    }
  })
}

/** Builds pre-canceled operation conformance. */
function cancellationCase(subject: CapturedSubject): StoreConformanceCase {
  return Object.freeze({
    name: "pre-canceled operations fail before mutating provider state",
    async run(): Promise<void> {
      await withStore(subject, ["conformance/canceled"], async (store) => {
        const key = "conformance/canceled"
        const [ctx, cancel] = withCancel(background())
        cancel()
        const expected = cause(ctx) ?? ctx.err()
        let observed: unknown = null
        try {
          await Promise.resolve().then(() => store.write(ctx, input(key)))
        } catch (value) {
          observed = value
        }
        ensure(observed === expected, "pre-canceled write did not preserve Context cause")
        ensure(
          (await bounded(subject.convergenceTimeoutMs, (readCtx) => store.read(readCtx, key))) ===
            null,
          "pre-canceled write mutated provider state"
        )
      })
    }
  })
}

/** Builds cross-client visibility plus the provider's declared mutation semantics. */
function sharedWriterCase(subject: CapturedSubject): StoreConformanceCase {
  return Object.freeze({
    name: "shared writers observe revisions and honor declared CAS across clients",
    async run(): Promise<void> {
      const stores = freshSharedStores(subject)
      const first = stores[0]
      const second = stores[1]
      if (subject.prepareStore !== undefined) {
        await bounded(
          subject.convergenceTimeoutMs,
          (ctx) => subject.prepareStore?.call(subject.receiver, ctx, first) ?? Promise.resolve()
        )
        await bounded(
          subject.convergenceTimeoutMs,
          (ctx) => subject.prepareStore?.call(subject.receiver, ctx, second) ?? Promise.resolve()
        )
      }
      let primary: Error | null = null
      try {
        const key = "conformance/shared"
        let initial: StoreRecord
        if (subject.limits.cas) {
          const attempts = await Promise.allSettled([
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              first.write(ctx, input(key, new Uint8Array([1])), ifAbsent())
            ),
            bounded(subject.convergenceTimeoutMs, (ctx) =>
              second.write(ctx, input(key, new Uint8Array([2])), ifAbsent())
            )
          ])
          const successes = attempts.filter((result) => result.status === "fulfilled")
          const failures = attempts.filter((result) => result.status === "rejected")
          ensure(successes.length === 1, "concurrent ifAbsent admitted more than one writer")
          ensure(failures.length === 1, "concurrent ifAbsent did not reject one writer")
          const success = successes[0]
          const failure = failures[0]
          ensure(
            success?.status === "fulfilled" && failure?.status === "rejected",
            "ifAbsent settlement was invalid"
          )
          ensure(
            isObjectLike(failure.reason) &&
              "code" in failure.reason &&
              failure.reason.code === "LIKEGO_STORE_CONFLICT" &&
              "expectedRevision" in failure.reason &&
              failure.reason.expectedRevision === null,
            "concurrent ifAbsent did not expose an absence conflict"
          )
          initial = success.value
        } else {
          initial = await bounded(subject.convergenceTimeoutMs, (ctx) =>
            first.write(ctx, input(key))
          )
        }
        await waitForRecord(second, key, initial.revision, subject.convergenceTimeoutMs)
        const updated = subject.limits.cas
          ? await bounded(subject.convergenceTimeoutMs, (ctx) =>
              second.write(ctx, input(key, new Uint8Array([2])), ifRevision(initial.revision))
            )
          : await bounded(subject.convergenceTimeoutMs, (ctx) =>
              second.write(ctx, input(key, new Uint8Array([2])))
            )
        await waitForRecord(first, key, updated.revision, subject.convergenceTimeoutMs)
        if (subject.limits.cas) {
          await bounded(subject.convergenceTimeoutMs, (ctx) =>
            first.delete(ctx, key, ifRevision(updated.revision))
          )
        } else {
          await bounded(subject.convergenceTimeoutMs, (ctx) => first.delete(ctx, key))
        }
        await waitForRecord(second, key, null, subject.convergenceTimeoutMs)
      } catch (value) {
        primary = normalizeError(value)
      }
      const cleanup: Error[] = []
      try {
        await bounded(subject.convergenceTimeoutMs, (ctx) =>
          first.delete(ctx, "conformance/shared")
        )
      } catch (value) {
        cleanup.push(normalizeError(value))
      }
      if (subject.releaseStore !== undefined) {
        for (const store of [second, first]) {
          try {
            await bounded(
              subject.convergenceTimeoutMs,
              (ctx) => subject.releaseStore?.call(subject.receiver, ctx, store) ?? Promise.resolve()
            )
          } catch (value) {
            cleanup.push(normalizeError(value))
          }
        }
      }
      if (primary !== null && cleanup.length > 0) {
        const failures: Error[] = [primary]
        for (const failure of cleanup) failures.push(failure)
        throw Object.freeze(new AggregateError(failures, "shared Store conformance cleanup failed"))
      }
      if (primary !== null) throw primary
      if (cleanup.length === 1 && cleanup[0] !== undefined) throw cleanup[0]
      if (cleanup.length > 1) {
        throw Object.freeze(new AggregateError(cleanup, "shared Store conformance cleanup failed"))
      }
    }
  })
}

/** Returns the complete immutable provider-neutral Store conformance suite. */
export function storeConformanceCases(
  subject: StoreConformanceSubject
): readonly StoreConformanceCase[] {
  const captured = captureSubject(subject)
  const cases: StoreConformanceCase[] = [
    crudCase(captured),
    listCase(captured),
    ttlCase(captured),
    casCase(captured),
    cancellationCase(captured)
  ]
  if (captured.limits.sharedWriters) cases.push(sharedWriterCase(captured))
  return Object.freeze(cases)
}

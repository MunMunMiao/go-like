import {
  jsonDecoder,
  objectSource,
  type ConfigDecoder,
  type ConfigSource,
  type ConfigSourceSnapshot,
  type ConfigSourceWatcher
} from "@go-like/core/config"
import { cause, type Context } from "@go-like/core/context"
import { newConfigSourceMissingError } from "@go-like/core/config/provider"
import { waitForContext } from "@go-like/core/context"

import {
  kvCursor,
  queryKv,
  resetKvCursor,
  retryableKvFailure,
  type ConsulConsistency,
  type KvCursor,
  type KvQueryResult
} from "../client/blocking"
import { openConsulClient, type ConsulClient } from "../client/client"
import type { Connection } from "../client/options"

export type { ConsulConsistency }

/** consulSource options. Connection fields live on ConsulClientOptions. */
export interface ConsulSourceOptions {
  /** Exact KV key; "." and ".." segments are rejected. */
  readonly key: string
  /** Source name, default "consul". */
  readonly name?: string
  readonly consistency?: ConsulConsistency
  /** Blocking-query wait 1..600000, default 300000. */
  readonly waitMs?: number
  /** Minimum time between two KV queries 1..60000, default 1000. */
  readonly minimumQueryIntervalMs?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** Default jsonDecoder. */
  readonly decode?: ConfigDecoder
  /** When true an absent key loads as {}; default false rejects with ConfigSourceMissingError. */
  readonly optional?: boolean
}

/** Performs one captured raw KV query with an optional blocking cursor. */
type ConsulQuery = (signal: AbortSignal | null, index: string | null) => Promise<KvQueryResult>

const WatcherStopped = Object.freeze(new Error("Consul watcher has stopped"))

/** Returns the caller's exact Context cancellation cause when terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Waits for one rate-limit interval while remaining abortable by Context or watcher stop. */
function waitForInterval(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  /** Owns one timer and one abort listener until exactly one wins. */
  function executor(resolve: () => void, reject: (error: unknown) => void): void {
    /** Resolves the interval and detaches its abort listener. */
    function elapsed(): void {
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    /** Rejects the interval with the owning cancellation reason. */
    function aborted(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(elapsed, timeoutMs)
    signal.addEventListener("abort", aborted, { once: true })
  }
  return new Promise<void>(executor)
}

/** Encodes an exact Consul KV key while rejecting URL-normalized dot path segments. */
function encodedKey(key: string): string {
  const parts = key.split("/")
  const encoded: string[] = []
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new TypeError("Consul key cannot contain a dot path segment")
    }
    encoded.push(encodeURIComponent(part))
  }
  return encoded.join("/")
}

/** Creates one source-owned blocking-query watcher with Context-aware stop. */
function createWatcher(
  query: ConsulQuery,
  revision: string | null,
  minimumQueryIntervalMs: number,
  retryInitialMs: number,
  retryMaximumMs: number
): ConfigSourceWatcher {
  let current: KvCursor = revision === null ? resetKvCursor() : kvCursor(revision)
  let active: Promise<void> | null = null
  let waiting = false
  let stopped = false
  let shutdown: Promise<void> | null = null
  const controller = new AbortController()

  /** Converts a successful next result into the neutral active-operation barrier. */
  function ignoreNextValue(): void {}

  /** Converts a failed next result into the neutral active-operation barrier. */
  function ignoreNextFailure(_error: unknown): void {}

  /** Waits for one interval and maps cancellation through the current Context and owner state. */
  function watcherInterval(ctx: Context, signal: AbortSignal, timeoutMs: number): Promise<void> {
    /** Rejects with the highest-authority failure visible after an interval interruption. */
    function rejectInterval(error: unknown): Promise<never> {
      const failure = contextFailure(ctx)
      return Promise.reject(failure ?? (stopped ? WatcherStopped : error))
    }
    return waitForInterval(signal, timeoutMs).catch(rejectInterval)
  }

  /** Runs blocking queries until the index truly changes, honoring reset and zero rules. */
  async function runNext(ctx: Context): Promise<void> {
    const initialFailure = contextFailure(ctx)
    if (initialFailure !== null) throw initialFailure
    const callerSignal = ctx.done()
    const signal =
      callerSignal === null ? controller.signal : AbortSignal.any([callerSignal, controller.signal])
    let retryDelayMs = retryInitialMs
    let recovering = false
    try {
      while (true) {
        const startedAt = Date.now()
        let result: KvQueryResult
        try {
          result = await query(signal, current.text)
          const operationFailure = contextFailure(ctx)
          if (operationFailure !== null) throw operationFailure
          if (stopped) throw WatcherStopped
        } catch (error) {
          const failure = contextFailure(ctx)
          if (failure !== null) throw failure
          if (stopped) throw WatcherStopped
          if (!retryableKvFailure(error)) throw error
          recovering = true
          await watcherInterval(ctx, signal, retryDelayMs)
          retryDelayMs = Math.min(retryMaximumMs, retryDelayMs * 2)
          continue
        }
        retryDelayMs = retryInitialMs
        if (recovering) {
          current = result.cursor
          return
        }
        if (result.cursor.value < current.value) {
          current = resetKvCursor()
        } else if (result.cursor.value > current.value) {
          current = result.cursor
          return
        }
        const remaining = minimumQueryIntervalMs - (Date.now() - startedAt)
        if (remaining > 0) await watcherInterval(ctx, signal, remaining)
      }
    } finally {
      waiting = false
    }
  }

  return Object.freeze({
    /** Waits until Consul reports an index change rather than a mere long-poll timeout. */
    next(ctx: Context): Promise<void> {
      if (stopped) return Promise.reject(WatcherStopped)
      if (waiting) return Promise.reject(new Error("Consul watcher is already waiting"))
      waiting = true
      const operation = runNext(ctx)
      active = operation.then(ignoreNextValue, ignoreNextFailure)
      return operation
    },
    /** Aborts and drains the active blocking request. */
    stop(ctx: Context): Promise<void> {
      if (shutdown === null) {
        stopped = true
        controller.abort(WatcherStopped)
        shutdown = active ?? Promise.resolve()
      }
      return waitForContext(ctx, shutdown)
    }
  })
}

/**
 * Creates a Consul KV source on a shared client.
 *
 * The exact key is loaded as one complete document. An absent key rejects unless optional is set.
 * The watcher uses blocking queries; a transition between present and absent is a change.
 */
export function consulSource(client: ConsulClient, options: ConsulSourceOptions): ConfigSource {
  const connection: Connection = openConsulClient(client)
  if (options === null || typeof options !== "object") {
    throw new TypeError("Consul options must be an object")
  }
  const key = options.key
  const name = options.name ?? "consul"
  const consistency = options.consistency ?? "default"
  const waitMs = options.waitMs ?? 300_000
  const minimumQueryIntervalMs = options.minimumQueryIntervalMs ?? 1_000
  const retryInitialMs = options.retryInitialMs ?? 250
  const retryMaximumMs = options.retryMaximumMs ?? Math.max(30_000, retryInitialMs)
  const decode = options.decode ?? jsonDecoder
  const optional = options.optional === true
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("Consul key must be non-empty")
  }
  const keyPath = encodedKey(key)
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Consul source name must be non-empty")
  }
  if (consistency !== "default" && consistency !== "consistent" && consistency !== "stale") {
    throw new TypeError("invalid Consul consistency mode")
  }
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 600_000) {
    throw new TypeError("Consul waitMs must be an integer from 1 through 600000")
  }
  if (
    !Number.isInteger(minimumQueryIntervalMs) ||
    minimumQueryIntervalMs < 1 ||
    minimumQueryIntervalMs > 60_000
  ) {
    throw new TypeError("Consul minimumQueryIntervalMs must be an integer from 1 through 60000")
  }
  if (!Number.isInteger(retryInitialMs) || retryInitialMs < 1 || retryInitialMs > 60_000) {
    throw new TypeError("Consul retryInitialMs must be an integer from 1 through 60000")
  }
  if (
    !Number.isInteger(retryMaximumMs) ||
    retryMaximumMs < retryInitialMs ||
    retryMaximumMs > 600_000
  ) {
    throw new TypeError(
      "Consul retryMaximumMs must be an integer from retryInitialMs through 600000"
    )
  }
  if (typeof decode !== "function") throw new TypeError("Consul decoder must be callable")

  /** Performs one raw KV request with status-authoritative and abort-bounded body handling. */
  function query(signal: AbortSignal | null, index: string | null): Promise<KvQueryResult> {
    return queryKv(
      { connection, keyPath, consistency, waitMs },
      signal,
      index,
      index === null ? "config.load" : "config.watch"
    )
  }

  return Object.freeze({
    name,
    /** Loads, decodes, validates, and snapshots the exact current KV value. */
    async load(ctx: Context): Promise<ConfigSourceSnapshot> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      try {
        const result = await query(ctx.done(), null)
        const queryFailure = contextFailure(ctx)
        if (queryFailure !== null) throw queryFailure
        if (result.missing) {
          if (!optional) throw newConfigSourceMissingError(name)
          const stable = await objectSource(name, {}).load(ctx)
          const finalFailure = contextFailure(ctx)
          if (finalFailure !== null) throw finalFailure
          return Object.freeze({ value: stable.value, revision: result.cursor.text })
        }
        const decoded = decode(result.text, key)
        const stable = await objectSource(name, decoded).load(ctx)
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        return Object.freeze({ value: stable.value, revision: result.cursor.text })
      } catch (error) {
        throw contextFailure(ctx) ?? error
      }
    },
    /** Opens a source-owned Consul blocking-query watcher from the candidate revision. */
    watch(ctx: Context, revision: string | null): Promise<ConfigSourceWatcher> {
      try {
        const failure = contextFailure(ctx)
        return failure === null
          ? Promise.resolve(
              createWatcher(query, revision, minimumQueryIntervalMs, retryInitialMs, retryMaximumMs)
            )
          : Promise.reject(failure)
      } catch (error) {
        return Promise.reject(error)
      }
    }
  })
}

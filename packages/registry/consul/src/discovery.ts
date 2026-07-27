import { background, cause, type Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"
import { type ServiceInstance, type Watcher } from "@likego/registry"
import {
  newRegistryProtocolError,
  newWatcherOverflowError,
  newWatcherStoppedError,
  snapshotServiceInstances
} from "@likego/registry/provider"

import { decodeHealthResponse, type DecodedRegistration } from "./codec"
import { boundaryError } from "./errors"
import { consulUrl, queryText, retryable } from "./http"
import type { CapturedOptions, OperationOptions } from "./options"
import { contextFailure, ignoreFailure, operationLease, waitForSignal } from "./runtime"

interface CursorSnapshot {
  readonly cursor: bigint
  readonly instances: readonly ServiceInstance[]
}

interface SnapshotWaiter {
  /** Resolves this exact caller wait. */
  readonly resolve: (value: readonly ServiceInstance[]) => void
  /** Rejects this exact caller wait. */
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal | null
  /** Removes and rejects this exact wait after caller cancellation. */
  readonly aborted: () => void
}

/** Reads Registry data and creates replacement-snapshot watchers. */
export interface DiscoveryManager {
  /** Reads complete passing instances for one service name. */
  getService(
    ctx: Context,
    name: string,
    options: OperationOptions
  ): Promise<readonly ServiceInstance[]>
  /** Opens one owned watcher after establishing its initial snapshot. */
  watch(
    ctx: Context,
    name: string,
    provider: CapturedOptions,
    options: OperationOptions
  ): Promise<Watcher>
}

/** Validates one service name before placing it into a URL path. */
function serviceName(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Consul service name must be non-empty")
  }
  return value
}

/** Builds one passing health URL, optionally as a blocking query. */
function healthUrl(
  options: OperationOptions,
  name: string,
  index: bigint | null,
  waitMs: number
): URL {
  const url = consulUrl(options, `/v1/health/service/${encodeURIComponent(name)}`, true)
  url.searchParams.set("passing", "true")
  if (index !== null) {
    url.searchParams.set("index", String(index))
    url.searchParams.set("wait", `${waitMs}ms`)
  }
  return url
}

/** Parses one mandatory Consul blocking index and clamps zero to one. */
function cursor(value: string | null): bigint {
  if (value === null || !/^[0-9]+$/.test(value)) {
    throw newRegistryProtocolError("Consul response requires a decimal X-Consul-Index")
  }
  const parsed = BigInt(value)
  return parsed === 0n ? 1n : parsed
}

/** Converts verified records into one deterministic replacement snapshot. */
function instances(records: readonly DecodedRegistration[]): readonly ServiceInstance[] {
  const logical = new Map<string, DecodedRegistration>()
  for (const record of records) {
    const previous = logical.get(record.identity)
    if (previous === undefined) logical.set(record.identity, record)
    else if (previous.content !== record.content) {
      throw newRegistryProtocolError("Consul ServiceInstance identity collision")
    }
  }
  const values: ServiceInstance[] = []
  for (const record of logical.values()) values.push(record.instance)
  values.sort(
    /** Sorts complete instances by stable public identity. */
    function byIdentity(left, right): number {
      const nameOrder = Number(left.name > right.name) - Number(left.name < right.name)
      if (nameOrder !== 0) return nameOrder
      const versionOrder =
        Number(left.version > right.version) - Number(left.version < right.version)
      if (versionOrder !== 0) return versionOrder
      return Number(left.id > right.id) - Number(left.id < right.id)
    }
  )
  return snapshotServiceInstances(values)
}

/** Executes one passing health query and verifies every managed record. */
async function healthQuery(
  options: OperationOptions,
  name: string,
  index: bigint | null,
  waitMs: number,
  signal: AbortSignal
): Promise<CursorSnapshot> {
  const result = await queryText(
    options,
    index === null ? "get" : "watch",
    healthUrl(options, name, index, waitMs),
    signal,
    false
  )
  return Object.freeze({
    cursor: cursor(result[1]),
    instances: instances(await decodeHealthResponse(result[0], name))
  })
}

/** Compares two complete replacement snapshots by their canonical public bytes. */
function sameSnapshot(
  left: readonly ServiceInstance[],
  right: readonly ServiceInstance[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Creates one resident Consul replacement-snapshot watcher. */
function replacementWatcher(
  provider: CapturedOptions,
  options: OperationOptions,
  name: string,
  bufferSize: number,
  initial: CursorSnapshot
): Watcher {
  const owner = new AbortController()
  const queue: (readonly ServiceInstance[])[] =
    initial.instances.length === 0 ? [] : [initial.instances]
  const waiters: SnapshotWaiter[] = []
  let current = initial.instances
  let currentCursor = initial.cursor
  let failure: Error | null = null
  let stopped = false
  let shutdown: Promise<void> | null = null

  /** Rejects and detaches one pending next waiter. */
  function rejectWaiter(waiter: SnapshotWaiter, error: Error): void {
    if (waiter.signal !== null) waiter.signal.removeEventListener("abort", waiter.aborted)
    waiter.reject(error)
  }

  /** Terminates the watcher with one stable failure identity. */
  function fail(error: Error): void {
    if (failure !== null || stopped) return
    failure = error
    owner.abort(error)
    queue.length = 0
    for (const waiter of waiters.splice(0)) rejectWaiter(waiter, error)
  }

  /** Enqueues or directly delivers one complete replacement snapshot. */
  function emit(value: readonly ServiceInstance[]): void {
    if (failure !== null || stopped) return
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      if (waiter.signal !== null) waiter.signal.removeEventListener("abort", waiter.aborted)
      waiter.resolve(value)
      return
    }
    if (queue.length >= bufferSize) {
      fail(newWatcherOverflowError(bufferSize))
      return
    }
    queue.push(value)
  }

  /** Runs blocking health queries until stopped or terminally failed. */
  async function pump(): Promise<void> {
    let retryMs = provider.retryInitialMs
    while (!owner.signal.aborted) {
      const lease = operationLease(
        background(),
        owner.signal,
        provider.waitMs + provider.minimumQueryIntervalMs + 5_000
      )
      try {
        const snapshot = await healthQuery(
          options,
          name,
          currentCursor,
          provider.waitMs,
          lease.signal
        )
        if (snapshot.cursor < currentCursor) {
          currentCursor = 0n
          continue
        }
        currentCursor = snapshot.cursor
        if (!sameSnapshot(current, snapshot.instances)) {
          current = snapshot.instances
          emit(current)
        }
        retryMs = provider.retryInitialMs
      } catch (value) {
        if (owner.signal.aborted) break
        if (!retryable(value)) {
          fail(boundaryError(value, "Consul watcher rejected with a non-Error value"))
          break
        }
        try {
          await waitForSignal(owner.signal, retryMs)
        } catch {
          break
        }
        retryMs = Math.min(provider.retryMaximumMs, retryMs * 2)
      } finally {
        lease.release()
      }
    }
  }

  const pumping = pump()

  return Object.freeze({
    /** Waits for one complete replacement snapshot under only the caller Context. */
    next(ctx: Context): Promise<readonly ServiceInstance[]> {
      if (failure !== null) return Promise.reject(failure)
      if (stopped) return Promise.reject(newWatcherStoppedError())
      const contextError = contextFailure(ctx)
      if (contextError !== null) return Promise.reject(contextError)
      const queued = queue.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise<readonly ServiceInstance[]>(
        /** Captures one caller-owned pending next wait. */
        function wait(resolve, reject): void {
          const signal = ctx.done()
          let waiter: SnapshotWaiter
          /** Removes only this caller wait and preserves the resident watcher. */
          function aborted(): void {
            signal?.removeEventListener("abort", aborted)
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(cause(ctx) ?? ctx.err() ?? new Error("Consul watcher wait was canceled"))
          }
          waiter = { resolve, reject, signal, aborted }
          waiters.push(waiter)
          signal?.addEventListener("abort", aborted, { once: true })
          if (signal?.aborted === true) aborted()
        }
      )
    },
    /** Stops the owner pump and drains its active blocking request. */
    stop(ctx: Context): Promise<void> {
      if (shutdown === null) {
        stopped = true
        const stoppedError = newWatcherStoppedError()
        owner.abort(stoppedError)
        queue.length = 0
        for (const waiter of waiters.splice(0)) rejectWaiter(waiter, stoppedError)
        shutdown = pumping
        void shutdown.catch(ignoreFailure)
      }
      return waitForContext(ctx, shutdown)
    }
  })
}

/** Creates the portable Consul query and watch manager. */
export function newDiscoveryManager(): DiscoveryManager {
  return Object.freeze({
    /** Reads one passing ServiceInstance snapshot. */
    async getService(
      ctx: Context,
      name: string,
      options: OperationOptions
    ): Promise<readonly ServiceInstance[]> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const lease = operationLease(ctx, null, options.timeoutMs)
      return healthQuery(options, serviceName(name), null, options.waitMs, lease.signal)
        .then(
          /** Returns one verified health snapshot after its caller remains active. */
          function found(snapshot): readonly ServiceInstance[] {
            const finalFailure = contextFailure(ctx)
            if (finalFailure !== null) throw finalFailure
            return snapshot.instances
          }
        )
        .catch(
          /** Normalizes every query rejection at the public boundary. */
          function failed(value): Promise<never> {
            return Promise.reject(
              contextFailure(ctx) ??
                boundaryError(value, "Consul get rejected with a non-Error value")
            )
          }
        )
        .finally(lease.release)
    },
    /** Establishes a service snapshot before transferring ownership to one watcher. */
    async watch(
      ctx: Context,
      name: string,
      provider: CapturedOptions,
      options: OperationOptions
    ): Promise<Watcher> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const validName = serviceName(name)
      const lease = operationLease(ctx, null, options.timeoutMs)
      return healthQuery(options, validName, null, options.waitMs, lease.signal)
        .then(
          /** Admits one resident watcher after its initial snapshot remains valid. */
          function admitted(initial): Watcher {
            const finalFailure = contextFailure(ctx)
            if (finalFailure !== null) throw finalFailure
            return replacementWatcher(
              provider,
              options,
              validName,
              provider.watchBufferSize,
              initial
            )
          }
        )
        .catch(
          /** Normalizes every watch admission rejection at the public boundary. */
          function failed(value): Promise<never> {
            return Promise.reject(
              contextFailure(ctx) ??
                boundaryError(value, "Consul watch admission rejected with a non-Error value")
            )
          }
        )
        .finally(lease.release)
    }
  })
}

import { background, cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import { type ServiceInstance, type Watcher } from "@go-like/registry"
import {
  newRegistryProtocolError,
  newWatcherOverflowError,
  newWatcherStoppedError
} from "@go-like/registry/provider"

import type { ChangeBus } from "./changes"
import { servicePath, servicesPath } from "./codec"
import { boundaryError, isRetryable } from "./errors"
import { clientOptions, type CapturedOptions, type OperationOptions } from "./options"
import { instances } from "./records"
import { contextFailure, ignoreFailure, operationLease, waitForSignal } from "./runtime"
import { readServiceRecords, type ChildReader } from "./tree"
import type { ZookeeperChildren, ZookeeperClient, ZookeeperClientState } from "./types"

interface SnapshotWaiter {
  readonly resolve: (value: readonly ServiceInstance[]) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal | null
  readonly aborted: () => void
}

/** Reads Registry data and creates complete replacement-snapshot watchers. */
export interface DiscoveryManager {
  getService(
    ctx: Context,
    name: string,
    options: OperationOptions
  ): Promise<readonly ServiceInstance[]>
  watch(
    ctx: Context,
    name: string,
    provider: CapturedOptions,
    options: OperationOptions
  ): Promise<Watcher>
}

/** Validates one service name before it becomes part of a znode path. */
function serviceName(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("ZooKeeper service name must be non-empty")
  }
  return value
}

/** Closes one transient client best effort within the normal operation timeout. */
async function closeClient(client: ZookeeperClient, timeoutMs: number): Promise<void> {
  const lease = operationLease(background(), null, timeoutMs)
  try {
    await client.close(lease.signal)
  } catch (value) {
    ignoreFailure(value)
  } finally {
    lease.release()
  }
}

/** Executes one discovery read through a short-lived owned session. */
async function withClient<T>(
  ctx: Context,
  options: OperationOptions,
  operation: (client: ZookeeperClient, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const initialFailure = contextFailure(ctx)
  if (initialFailure !== null) throw initialFailure
  const lease = operationLease(ctx, null, options.timeoutMs)
  const client = options.clientFactory(clientOptions(options))
  try {
    await client.connect(lease.signal)
    const result = await operation(client, lease.signal)
    const finalFailure = contextFailure(ctx)
    if (finalFailure !== null) throw finalFailure
    return result
  } catch (value) {
    throw contextFailure(ctx) ?? boundaryError(value, "ZooKeeper discovery operation failed")
  } finally {
    lease.release()
    await closeClient(client, options.timeoutMs)
  }
}

/** Compares two complete canonical replacement snapshots. */
function sameSnapshot(
  left: readonly ServiceInstance[],
  right: readonly ServiceInstance[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Creates one watcher with recursively re-armed one-shot service-child watches. */
async function replacementWatcher(
  changes: ChangeBus,
  provider: CapturedOptions,
  options: OperationOptions,
  client: ZookeeperClient,
  name: string,
  bufferSize: number,
  initial: readonly ServiceInstance[]
): Promise<Watcher> {
  const owner = new AbortController()
  const queue: (readonly ServiceInstance[])[] = initial.length === 0 ? [] : [initial]
  const waiters: SnapshotWaiter[] = []
  let current = initial
  let activeClient = client
  let armed = false
  let failure: Error | null = null
  let stopped = false
  let recovering = false
  let serial = Promise.resolve()
  let recoveryTask = Promise.resolve()
  let shutdown: Promise<void> | null = null
  let unsubscribeState: (() => void) | null = null

  /** Rejects and detaches one pending caller wait. */
  function rejectWaiter(waiter: SnapshotWaiter, error: Error): void {
    waiter.signal?.removeEventListener("abort", waiter.aborted)
    waiter.reject(error)
  }

  /** Transitions this watcher to one stable terminal failure. */
  function fail(error: Error): void {
    if (failure !== null || stopped) return
    failure = error
    owner.abort(error)
    queue.length = 0
    for (const waiter of waiters.splice(0)) rejectWaiter(waiter, error)
  }

  /** Enqueues or directly delivers one complete snapshot. */
  function emit(value: readonly ServiceInstance[]): void {
    if (failure !== null || stopped) return
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.aborted)
      waiter.resolve(value)
      return
    }
    if (queue.length >= bufferSize) {
      fail(newWatcherOverflowError(bufferSize))
      return
    }
    queue.push(value)
  }

  /** Reads children while maintaining one outstanding one-shot watch. */
  function watchedChildren(path: string, signal: AbortSignal): Promise<ZookeeperChildren> {
    if (armed) return activeClient.children(path, signal)
    armed = true
    return activeClient
      .watchChildren(
        path,
        function changed(): void {
          armed = false
          void schedule().catch(ignoreFailure)
        },
        signal
      )
      .catch(function failed(value: unknown): never {
        armed = false
        throw value
      })
  }

  /** Relists one complete service snapshot and re-arms its one-shot watch. */
  async function reconcile(): Promise<void> {
    if (failure !== null || stopped || recovering) return
    const lease = operationLease(background(), owner.signal, options.timeoutMs)
    try {
      const reader: ChildReader = function childReader(path): Promise<ZookeeperChildren> {
        return watchedChildren(path, lease.signal)
      }
      const next = instances(
        await readServiceRecords(activeClient, options, name, lease.signal, reader),
        name
      )
      if (!sameSnapshot(current, next)) {
        current = next
        emit(current)
      }
    } catch (value) {
      if (owner.signal.aborted || isRetryable(value)) return
      fail(boundaryError(value, "ZooKeeper watcher reconciliation failed"))
    } finally {
      lease.release()
    }
  }

  /** Serializes reconciliations so one-shot watch state stays coherent. */
  function schedule(): Promise<void> {
    const next = serial.then(reconcile, reconcile)
    serial = next.catch(ignoreFailure)
    return next
  }

  /** Replaces an expired native session and restores the service watch. */
  async function recover(): Promise<void> {
    if (recovering || stopped || failure !== null) return
    recovering = true
    armed = false
    unsubscribeState?.()
    unsubscribeState = null
    await closeClient(activeClient, options.timeoutMs)
    let retryMs = provider.retryInitialMs
    while (!owner.signal.aborted) {
      const candidate = options.clientFactory(clientOptions(options))
      const lease = operationLease(background(), owner.signal, options.timeoutMs)
      try {
        await candidate.connect(lease.signal)
        await candidate.mkdirp(servicePath(options.root, name), lease.signal)
        activeClient = candidate
        subscribeState(candidate)
        recovering = false
        await reconcile()
        return
      } catch (value) {
        await closeClient(candidate, options.timeoutMs)
        const error = boundaryError(value, "ZooKeeper watcher recovery failed")
        if (!isRetryable(error)) {
          recovering = false
          fail(error)
          return
        }
      } finally {
        lease.release()
      }
      try {
        await waitForSignal(owner.signal, retryMs)
      } catch {
        break
      }
      retryMs = Math.min(provider.retryMaximumMs, retryMs * 2)
    }
    recovering = false
  }

  /** Reacts only to terminal native states requiring provider action. */
  function stateChanged(state: ZookeeperClientState): void {
    if (state === "expired" && !recovering && !stopped && failure === null) {
      recoveryTask = recover()
      void recoveryTask.catch(ignoreFailure)
    } else if (state === "authentication-failed") {
      fail(newRegistryProtocolError("ZooKeeper watcher authentication failed"))
    } else if (state === "connected") {
      void schedule().catch(ignoreFailure)
    }
  }

  /** Replaces the exact active client's state subscription. */
  function subscribeState(value: ZookeeperClient): void {
    unsubscribeState?.()
    unsubscribeState = value.onState(stateChanged)
  }

  subscribeState(activeClient)
  const unsubscribeChanges = changes.subscribe(schedule)
  const timer = setInterval(function periodic(): void {
    void schedule().catch(ignoreFailure)
  }, provider.reconcileIntervalMs)
  await schedule()

  /** Releases the watcher session after all already-scheduled work settles. */
  async function drain(): Promise<void> {
    clearInterval(timer)
    unsubscribeChanges()
    unsubscribeState?.()
    unsubscribeState = null
    await Promise.all([serial, recoveryTask])
    const cleanup = new AbortController()
    await activeClient.close(cleanup.signal)
  }

  return Object.freeze({
    /** Waits for one complete replacement snapshot under only the caller Context. */
    next(ctx: Context): Promise<readonly ServiceInstance[]> {
      if (failure !== null) return Promise.reject(failure)
      if (stopped) return Promise.reject(newWatcherStoppedError())
      const contextError = contextFailure(ctx)
      if (contextError !== null) return Promise.reject(contextError)
      const queued = queue.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise<readonly ServiceInstance[]>(function wait(resolve, reject): void {
        const signal = ctx.done()
        let waiter: SnapshotWaiter
        function aborted(): void {
          signal?.removeEventListener("abort", aborted)
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(cause(ctx) ?? ctx.err() ?? new Error("ZooKeeper watcher wait was canceled"))
        }
        waiter = { resolve, reject, signal, aborted }
        waiters.push(waiter)
        signal?.addEventListener("abort", aborted, { once: true })
        if (signal?.aborted === true) aborted()
      })
    },
    /** Stops the resident watch while only this caller may abandon its wait. */
    stop(ctx: Context): Promise<void> {
      if (shutdown === null) {
        stopped = true
        const stoppedError = newWatcherStoppedError()
        owner.abort(stoppedError)
        queue.length = 0
        for (const waiter of waiters.splice(0)) rejectWaiter(waiter, stoppedError)
        shutdown = drain()
      }
      return waitForContext(ctx, shutdown)
    }
  })
}

/** Creates one read/watch manager sharing local post-commit notifications. */
export function newDiscoveryManager(changes: ChangeBus): DiscoveryManager {
  return Object.freeze({
    /** Reads one complete verified ServiceInstance snapshot. */
    getService(
      ctx: Context,
      name: string,
      options: OperationOptions
    ): Promise<readonly ServiceInstance[]> {
      const validName = serviceName(name)
      return withClient(ctx, options, async function read(client, signal) {
        return instances(await readServiceRecords(client, options, validName, signal), validName)
      })
    },
    /** Establishes the one-shot service watch before transferring resident ownership. */
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
      const client = options.clientFactory(clientOptions(options))
      try {
        await client.connect(lease.signal)
        await client.mkdirp(servicesPath(options.root), lease.signal)
        await client.mkdirp(servicePath(options.root, validName), lease.signal)
        const initial = instances(
          await readServiceRecords(client, options, validName, lease.signal),
          validName
        )
        const finalFailure = contextFailure(ctx)
        if (finalFailure !== null) throw finalFailure
        return await replacementWatcher(
          changes,
          provider,
          options,
          client,
          validName,
          provider.watchBufferSize,
          initial
        )
      } catch (value) {
        await closeClient(client, options.timeoutMs)
        throw contextFailure(ctx) ?? boundaryError(value, "ZooKeeper watch admission failed")
      } finally {
        lease.release()
      }
    }
  })
}

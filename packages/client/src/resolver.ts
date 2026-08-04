import {
  background,
  canceled,
  cause,
  withCancelCause,
  withoutCancel,
  type Context
} from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import type { Discovery, ServiceInstance, Watcher } from "@go-like/registry"
import { retry } from "@go-like/resilience"

const watcherRetryDelayMs = 1_000
const watcherRollbackCleanups = new WeakMap<object, unknown>()

interface ServiceState {
  snapshot: readonly ServiceInstance[]
  ready: boolean
  version: number
  notification: Promise<void>
  notify: () => void
  watcher: ActiveWatcher | null
  terminalFailure: { readonly value: unknown } | null
  pump: Promise<void>
}

interface ActiveWatcher {
  readonly receiver: Watcher
  readonly stop: Watcher["stop"]
  shutdown: Promise<void> | null
}

/** Resolves cached service snapshots and owns every lazily opened watcher. */
export interface DiscoveryResolver {
  getService(ctx: Context, name: string, block?: boolean): Promise<readonly ServiceInstance[]>
  close(ctx: Context): Promise<void>
}

/** Reports whether one raw discovery snapshot contains any callable endpoint. */
function hasEndpoint(snapshot: readonly ServiceInstance[]): boolean {
  for (const instance of snapshot) {
    if (instance.endpoints.length !== 0) return true
  }
  return false
}

/** Advances one replaceable notification without losing already admitted waiters. */
function notifyState(state: ServiceState): void {
  const notify = state.notify
  const next = Promise.withResolvers<void>()
  state.version += 1
  state.notification = next.promise
  state.notify = next.resolve
  notify()
}

/** Publishes one authoritative snapshot and records first endpoint readiness monotonically. */
function publishSnapshot(state: ServiceState, snapshot: readonly ServiceInstance[]): void {
  state.snapshot = snapshot
  if (!state.ready && hasEndpoint(snapshot)) state.ready = true
  notifyState(state)
}

/** Preserves the primary admission failure while still reporting watcher rollback failure. */
async function rollbackWatcher(watcher: Watcher, ctx: Context, primary: unknown): Promise<never> {
  const stop = watcher.stop
  try {
    await stop.call(watcher, withoutCancel(ctx))
  } catch (cleanup) {
    const failure = new AggregateError([primary, cleanup], "discovery admission and cleanup failed")
    watcherRollbackCleanups.set(failure, cleanup)
    throw failure
  }
  throw primary
}

/** Creates one resident, per-service discovery cache over the existing Registry contract. */
export function newDiscoveryResolver(discovery: Discovery): DiscoveryResolver {
  const getService = discovery.getService
  const watch = discovery.watch
  const [owner, cancelOwner] = withCancelCause(background())
  const states = new Map<string, Promise<ServiceState>>()
  const activeStates = new Set<ServiceState>()
  const closedError = new Error("client is closed")
  let closed = false
  let closing: Promise<void> | null = null

  /** Starts one watcher shutdown exactly once, independently of any close caller. */
  function stopWatcher(state: ServiceState, watcher: ActiveWatcher): Promise<void> {
    if (watcher.shutdown !== null) return watcher.shutdown
    try {
      watcher.shutdown = Promise.resolve(watcher.stop.call(watcher.receiver, withoutCancel(owner)))
    } catch (failure) {
      watcher.shutdown = Promise.reject(failure)
    }
    void watcher.shutdown.then(
      () => {
        if (state.watcher === watcher) state.watcher = null
      },
      () => {}
    )
    return watcher.shutdown
  }

  /** Consumes one watcher until it fails or the resolver owner is canceled. */
  async function consume(
    state: ServiceState,
    watcher: Watcher,
    name: string,
    reconcileFirst: boolean
  ): Promise<void> {
    const next = watcher.next
    const stop = watcher.stop
    const active: ActiveWatcher = { receiver: watcher, stop, shutdown: null }
    state.watcher = active
    try {
      if (reconcileFirst) {
        await next.call(watcher, owner)
        publishSnapshot(state, await getService.call(discovery, owner, name))
      }
      while (true) publishSnapshot(state, await next.call(watcher, owner))
    } catch (primary) {
      const ownerError = owner.err()
      const runtimeFailure =
        ownerError === null || (primary !== cause(owner) && primary !== ownerError)
      try {
        await stopWatcher(state, active)
      } catch (cleanup) {
        if (!runtimeFailure) {
          state.terminalFailure = Object.freeze({ value: cleanup })
          notifyState(state)
          throw cleanup
        }
        const terminal = new AggregateError(
          [primary, cleanup],
          "discovery watcher failed and cleanup failed"
        )
        state.terminalFailure = Object.freeze({ value: terminal })
        notifyState(state)
        throw terminal
      }
      throw primary
    }
  }

  /** Keeps the last complete snapshot while rebuilding a terminal watcher after backoff. */
  function startPump(name: string, state: ServiceState, initial: Watcher): Promise<void> {
    let admitted: Watcher | null = initial
    return retry<void>(
      owner,
      async function watchService(): Promise<void> {
        const reconcileFirst = admitted !== null
        const watcher = admitted ?? (await watch.call(discovery, owner, name))
        admitted = null
        await consume(state, watcher, name, reconcileFirst)
      },
      {
        authorization: "caller-approved",
        maxAttempts: Number.MAX_SAFE_INTEGER,
        shouldRetry: () => state.terminalFailure === null,
        backoff: () => watcherRetryDelayMs
      }
    ).catch(function ignoreResolverShutdown(): void {})
  }

  /** Opens the watcher before reading so a concurrent registry transition cannot be lost. */
  async function open(name: string): Promise<ServiceState> {
    let watcher: Watcher | null = null
    try {
      watcher = await watch.call(discovery, owner, name)
      const snapshot = await getService.call(discovery, owner, name)
      if (closed) throw closedError
      const notification = Promise.withResolvers<void>()
      const state: ServiceState = {
        snapshot,
        ready: hasEndpoint(snapshot),
        version: 0,
        notification: notification.promise,
        notify: notification.resolve,
        watcher: null,
        terminalFailure: null,
        pump: Promise.resolve()
      }
      activeStates.add(state)
      state.pump = startPump(name, state, watcher)
      return state
    } catch (failure) {
      if (watcher !== null) return await rollbackWatcher(watcher, owner, failure)
      throw failure
    }
  }

  /** Starts and memoizes the resolver owner drain. */
  function beginClose(): Promise<void> {
    if (closing !== null) return closing
    closed = true
    closing = (async function drain(): Promise<void> {
      const stops: Array<readonly [ServiceState, Promise<void>]> = []
      for (const state of activeStates) {
        notifyState(state)
        if (state.watcher !== null) stops.push([state, stopWatcher(state, state.watcher)])
      }
      cancelOwner(closedError)
      const settled = await Promise.allSettled(states.values())
      const stopped = await Promise.allSettled(stops.map(([, stop]) => stop))
      const pumps: Promise<void>[] = []
      for (const result of settled) {
        if (result.status === "fulfilled") pumps.push(result.value.pump)
      }
      await Promise.allSettled(pumps)
      const stoppedFailures = new Map<ServiceState, unknown>()
      for (const [index, result] of stopped.entries()) {
        if (result.status === "rejected") {
          const state = stops[index]?.[0]
          if (state !== undefined) stoppedFailures.set(state, result.reason)
        }
      }
      const failures: unknown[] = []
      for (const state of activeStates) {
        if (state.terminalFailure !== null) failures.push(state.terminalFailure.value)
        else if (stoppedFailures.has(state)) failures.push(stoppedFailures.get(state))
      }
      for (const result of settled) {
        if (result.status !== "rejected") continue
        const reason = result.reason
        if (typeof reason === "object" && reason !== null && watcherRollbackCleanups.has(reason)) {
          failures.push(watcherRollbackCleanups.get(reason))
        }
      }
      activeStates.clear()
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, "client discovery cleanup failed")
      }
    })()
    void closing.catch(() => {})
    return closing
  }

  return Object.freeze({
    /** Returns the latest complete snapshot, lazily opening one watcher per service name. */
    async getService(
      ctx: Context,
      name: string,
      block = false
    ): Promise<readonly ServiceInstance[]> {
      if (closed) throw closedError
      const callerFailure = ctx.err()
      if (callerFailure !== null) throw cause(ctx) ?? callerFailure
      let pending = states.get(name)
      if (pending === undefined) {
        pending = open(name)
        states.set(name, pending)
        void pending.catch(() => {
          if (states.get(name) === pending) states.delete(name)
        })
      }
      const state = await waitForContext(ctx, pending)
      if (closed) throw closedError
      while (block && !state.ready) {
        const version = state.version
        const notification = state.notification
        if (closed) throw closedError
        const terminalFailure = state.terminalFailure
        if (terminalFailure !== null) throw terminalFailure.value
        if (state.ready || state.version !== version) continue
        await waitForContext(ctx, notification)
        if (closed) throw closedError
      }
      return state.snapshot
    },

    /** Starts one owner drain and lets only this caller Context bound its wait. */
    async close(ctx: Context): Promise<void> {
      await waitForContext(ctx, beginClose())
    }
  })
}

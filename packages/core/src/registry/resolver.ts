import { cause, withCancelCause, withoutCancel, type Context } from "../context"
import { waitForContext } from "../context"
import { newWakeup, runResident } from "../resident"
import { detachSpan, enterRoot, recordEvent, withOperation } from "../telemetry/internal/instrument"
import type { Discovery, ServiceInstance, Watcher } from "./types"

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
  name: string
  watchCtx: Context
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
  recordEvent(state.watchCtx, {
    kind: "registry.watch.updated",
    service: state.name,
    instances: snapshot.length
  })
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
  const states = new Map<string, Promise<ServiceState>>()
  const cancels = new Set<(error: Error) => void>()
  const activeStates = new Set<ServiceState>()
  const closedError = new Error("client is closed")
  let closed = false
  let closing: Promise<void> | null = null

  /** Starts one watcher shutdown exactly once, independently of any close caller. */
  function stopWatcher(state: ServiceState, watcher: ActiveWatcher): Promise<void> {
    if (watcher.shutdown !== null) return watcher.shutdown
    try {
      watcher.shutdown = Promise.resolve(
        watcher.stop.call(watcher.receiver, withoutCancel(state.watchCtx))
      )
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

  /** Stops a failed watcher and keeps the last snapshot unless cleanup itself fails. */
  async function failWatcher(
    state: ServiceState,
    active: ActiveWatcher,
    primary: unknown
  ): Promise<never> {
    const ownerError = state.watchCtx.err()
    const runtimeFailure =
      ownerError === null || (primary !== cause(state.watchCtx) && primary !== ownerError)
    if (runtimeFailure) {
      recordEvent(state.watchCtx, {
        kind: "registry.watch.failed",
        service: state.name,
        error: primary
      })
    }
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

  /** Keeps the last complete snapshot while rebuilding a terminal watcher after backoff. */
  function startPump(name: string, state: ServiceState, initial: Watcher): Promise<void> {
    let admitted: Watcher | null = initial
    let phase: "reopen" | "discard" | "follow" = "discard"
    const wakeup = newWakeup()
    return enterRoot(state.watchCtx, () =>
      runResident<readonly ServiceInstance[]>(
        state.watchCtx,
        {
          intervalMs: 0,
          /** Rebuilds a failed watcher after the fixed discovery backoff. */
          backoff: () => watcherRetryDelayMs,
          /** Keeps the last snapshot until cleanup records a terminal failure. */
          retryable: () => state.terminalFailure === null,
          /** failWatcher records a terminal failure before this non-retryable callback. */
          terminal(): void {},
          /** Reads one watcher snapshot. A rebuilt watch refreshes before its next event. */
          async poll(ctx: Context): Promise<readonly ServiceInstance[]> {
            let active = state.watcher
            try {
              if (admitted === null) {
                admitted = await watch.call(discovery, ctx, name)
                phase = "reopen"
              }
              const watcher = admitted
              if (active === null || active.receiver !== watcher) {
                active = { receiver: watcher, stop: watcher.stop, shutdown: null }
                state.watcher = active
              }
              const ownerError = ctx.err()
              if (ownerError !== null) throw cause(ctx) ?? ownerError
              if (phase === "reopen") {
                phase = "discard"
                return await getService.call(discovery, ctx, name)
              }
              if (phase === "discard") {
                await watcher.next.call(watcher, ctx)
                phase = "follow"
                return await getService.call(discovery, ctx, name)
              }
              return await watcher.next.call(watcher, ctx)
            } catch (primary) {
              const failed = state.watcher
              admitted = null
              phase = "reopen"
              if (failed === null) throw primary
              return await failWatcher(state, failed, primary)
            }
          },
          /** Publishes one watch-loop snapshot. The initial open snapshot is not included. */
          result(snapshot: readonly ServiceInstance[]): void {
            publishSnapshot(state, snapshot)
          }
        },
        wakeup
      )
    )
  }

  /** Opens the watcher before reading so a concurrent registry transition cannot be lost. */
  async function open(name: string, watchCtx: Context): Promise<ServiceState> {
    let watcher: Watcher | null = null
    try {
      watcher = await watch.call(discovery, watchCtx, name)
      const snapshot = await getService.call(discovery, watchCtx, name)
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
        pump: Promise.resolve(),
        name,
        watchCtx
      }
      activeStates.add(state)
      state.pump = startPump(name, state, watcher)
      return state
    } catch (failure) {
      if (watcher !== null) return await rollbackWatcher(watcher, watchCtx, failure)
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
      for (const cancel of cancels) cancel(closedError)
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
        const [watchCtx, cancelWatch] = withCancelCause(
          withOperation(detachSpan(withoutCancel(ctx)), `registry watch ${name}`)
        )
        cancels.add(cancelWatch)
        // Admission includes the initial watch await, so the root scope cannot wait for the pump.
        pending = enterRoot(watchCtx, () => open(name, watchCtx))
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

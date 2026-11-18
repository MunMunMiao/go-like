import {
  afterFunc,
  cause,
  canceled,
  withCancelCause,
  withoutCancel,
  type Context
} from "../context"
import { waitForContext } from "../context"
import { isError, toError } from "../internal/errors"
import type { Backoff } from "../resilience"
import { newWakeup, runResident } from "../resident/index"
import { detachSpan, enterRoot } from "../telemetry/internal/instrument"

import { newWatcherOverflowError, newWatcherStoppedError } from "./errors"
import { snapshotServiceInstances } from "./snapshot"
import type { ServiceInstance, Watcher } from "./types"

/** Options for one shared replacement-snapshot watcher. */
export interface SnapshotWatcherOptions {
  /** Snapshot established at watch admission; queued for the first next only when non-empty. */
  readonly initial: readonly ServiceInstance[]
  /** Queue bound, integer 1..4096. Overflow is a terminal WatcherOverflowError. */
  readonly bufferSize: number
  /**
   * One step of the resident loop. Resolves with the next complete snapshot, or null when nothing
   * changed. Omit for push-only watchers.
   */
  readonly poll?: (ctx: Context) => Promise<readonly ServiceInstance[] | null>
  /** Delay before the poll after the n-th consecutive failure. Required with poll. */
  readonly backoff?: Backoff
  /** Failures after which the loop backs off and polls again. Default: none. */
  readonly retryable?: (error: unknown) => boolean
  /** Minimum milliseconds between the starts of two polls. wake() ends the wait early. Default 0. */
  readonly intervalMs?: number
  /** Releases plug resources once, inside the first stop, after the loop has exited. */
  readonly release?: (ctx: Context) => Promise<void>
}

interface SnapshotWaiter {
  resolve: (snapshot: readonly ServiceInstance[]) => void
  reject: (error: Error) => void
  stop: () => void
}

/** Handle a plug keeps while the caller owns `watcher`. */
export interface SnapshotWatcher {
  /** Returned to the caller of Discovery.watch. */
  readonly watcher: Watcher
  /** Loop Context: values of the watch Context without its span. */
  readonly ctx: Context
  /** Publishes one complete snapshot. An equal consecutive snapshot is dropped. */
  publish(snapshot: readonly ServiceInstance[]): void
  /** Ends the current interval wait early. */
  wake(): void
  /** Terminates the watcher. Pending and later next calls reject with `error`. */
  fail(error: Error): void
}

/** Creates the watcher every registry plug returns. Throws when `ctx` has already ended. */
export function newSnapshotWatcher(ctx: Context, options: SnapshotWatcherOptions): SnapshotWatcher {
  const failure = cause(ctx)
  if (failure !== null) throw failure
  const bufferSize = options.bufferSize
  if (!Number.isInteger(bufferSize) || bufferSize < 1 || bufferSize > 4_096) {
    throw new RangeError("watcher bufferSize must be an integer from 1 through 4096")
  }
  if (options.poll !== undefined && typeof options.poll !== "function") {
    throw new TypeError("snapshot watcher poll must be a function")
  }
  if (options.poll !== undefined && typeof options.backoff !== "function") {
    throw new TypeError("snapshot watcher backoff is required with poll")
  }
  if (options.retryable !== undefined && typeof options.retryable !== "function") {
    throw new TypeError("snapshot watcher retryable must be a function")
  }
  if (options.release !== undefined && typeof options.release !== "function") {
    throw new TypeError("snapshot watcher release must be a function")
  }
  const intervalMs = options.intervalMs ?? 0
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
    throw new RangeError("snapshot watcher intervalMs must be an integer from 0 through 2147483647")
  }
  const initial = snapshotServiceInstances(options.initial)
  const [owner, cancelOwner] = withCancelCause(detachSpan(withoutCancel(ctx)))
  const wakeup = newWakeup()
  const queue: Array<readonly ServiceInstance[]> = []
  const waiters: SnapshotWaiter[] = []
  let last: readonly ServiceInstance[] | null = null
  let terminal: Error | null = null
  let stopped = false
  let releaseStarted = false
  let stopping: Promise<void> | null = null
  if (initial.length > 0) {
    queue.push(initial)
    last = initial
  }

  /** Rejects every pending next with `error`. */
  function rejectWaiters(error: Error): void {
    const pending = waiters.splice(0)
    for (const waiter of pending) {
      waiter.stop()
      waiter.reject(error)
    }
  }

  const handle: SnapshotWatcher = {
    ctx: owner,
    watcher: {
      /** Returns the next snapshot, or rejects when the watcher has failed or stopped. */
      next(nextCtx: Context): Promise<readonly ServiceInstance[]> {
        const ended = cause(nextCtx)
        if (ended !== null) return Promise.reject(ended)
        if (terminal !== null) return Promise.reject(terminal)
        if (stopped) return Promise.reject(newWatcherStoppedError())
        const queued = queue.shift()
        if (queued !== undefined) return Promise.resolve(queued)
        return new Promise<readonly ServiceInstance[]>((resolve, reject) => {
          const waiter: SnapshotWaiter = { resolve, reject, stop: () => {} }
          waiters.push(waiter)
          /** Drops this waiter when its Context ends before a snapshot arrives. */
          const abandon = (): void => {
            const index = waiters.indexOf(waiter)
            if (index < 0) return
            waiters.splice(index, 1)
            reject(cause(nextCtx) ?? nextCtx.err() ?? canceled)
          }
          try {
            waiter.stop = afterFunc(nextCtx, abandon)
          } catch (error) {
            waiter.stop()
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(isError(error) ? error : toError(error, "snapshot watcher next failed"))
          }
        })
      },
      /** Stops the loop, releases plug resources once, and rejects pending next calls. */
      stop(stopCtx: Context): Promise<void> {
        if (stopping === null) {
          stopped = true
          if (terminal === null) cancelOwner(canceled)
          stopping = finish(stopCtx)
        }
        return waitForContext(stopCtx, stopping)
      }
    },
    /** Validates and queues one snapshot, or hands it to a waiting next. */
    publish(snapshot: readonly ServiceInstance[]): void {
      if (stopped || terminal !== null) return
      const frozen = snapshotServiceInstances(snapshot)
      if (last !== null && sameInstances(last, frozen)) return
      last = frozen
      const waiter = waiters.shift()
      if (waiter !== undefined) {
        waiter.stop()
        waiter.resolve(frozen)
        return
      }
      if (queue.length >= bufferSize) {
        handle.fail(newWatcherOverflowError(bufferSize))
        return
      }
      queue.push(frozen)
    },
    /** Ends the current poll interval early. */
    wake(): void {
      wakeup.wake()
    },
    /** Makes every current and future next reject with `error`. */
    fail(error: Error): void {
      if (terminal !== null || stopped) return
      terminal = isError(error) ? error : toError(error, "snapshot watcher failed")
      cancelOwner(terminal)
      rejectWaiters(terminal)
    }
  }

  const loop =
    options.poll === undefined
      ? Promise.resolve()
      : Promise.resolve(
          enterRoot(owner, () =>
            runResident(
              owner,
              {
                poll: options.poll as (ctx: Context) => Promise<readonly ServiceInstance[] | null>,
                /** Publishes a non-null poll result. A thrown validation becomes terminal. */
                result(value: readonly ServiceInstance[] | null): void {
                  if (value === null || terminal !== null || stopped) return
                  try {
                    handle.publish(value)
                  } catch (error) {
                    handle.fail(isError(error) ? error : toError(error, "snapshot publish failed"))
                  }
                },
                backoff: options.backoff as Backoff,
                retryable: options.retryable ?? (() => false),
                intervalMs,
                /** Ends the watcher when a poll failure is not retryable. */
                terminal(error: Error): void {
                  handle.fail(error)
                }
              },
              wakeup
            )
          )
        ).catch((error: unknown) => {
          if (terminal === null && !stopped) {
            handle.fail(isError(error) ? error : toError(error, "snapshot watcher failed"))
          }
        })

  /** Waits for the loop, then runs release once. */
  async function finish(stopCtx: Context): Promise<void> {
    await loop
    if (releaseStarted || options.release === undefined) {
      rejectWaiters(terminal ?? newWatcherStoppedError())
      return
    }
    releaseStarted = true
    try {
      await options.release(stopCtx)
    } finally {
      rejectWaiters(terminal ?? newWatcherStoppedError())
    }
  }

  return handle
}

/** Reports whether two published snapshots contain the same instances in the same order. */
function sameInstances(
  left: readonly ServiceInstance[],
  right: readonly ServiceInstance[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return false
  }
  return true
}

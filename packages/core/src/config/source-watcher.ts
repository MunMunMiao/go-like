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

import type { ConfigSourceWatcher } from "./config"

const stoppedError = Object.freeze(new Error("configuration source watcher stopped"))
const busyError = Object.freeze(new Error("configuration source watcher next is already waiting"))

/** Options for one configuration source watcher. */
export interface SourceWatcherOptions {
  /**
   * One step of the resident loop. Resolves true when the document changed since the previous
   * successful step. Omit for push-only watchers. A successful step after failures counts as a change.
   */
  readonly poll?: (ctx: Context) => Promise<boolean>
  /** Delay before the step after the n-th consecutive failure. Required with poll. */
  readonly backoff?: Backoff
  /** Failures after which the loop backs off and polls again. Default: none. */
  readonly retryable?: (error: unknown) => boolean
  /** Minimum milliseconds between the starts of two steps. Default 0. */
  readonly intervalMs?: number
  /** True when the source already knows it changed between load and watch. */
  readonly dirty?: boolean
  /** Releases plug resources once, inside the first stop, after the loop has exited. */
  readonly release?: (ctx: Context) => Promise<void>
}

interface SourceWaiter {
  resolve: () => void
  reject: (error: Error) => void
  stop: () => void
}

/** Handle a plug keeps while Config owns `watcher`. */
export interface SourceWatcher {
  /** Returned from ConfigSource.watch. */
  readonly watcher: ConfigSourceWatcher
  /** Loop Context: values of the watch Context without its span. */
  readonly ctx: Context
  /** Records one change. Coalesced until the next next(). No-op after stop. */
  changed(): void
  /** Ends the current interval wait early. */
  wake(): void
  /** Terminal failure: the pending and every later next() reject with error. */
  fail(error: Error): void
}

/** Creates one source watcher. Throws when `ctx` has already ended. */
export function newSourceWatcher(ctx: Context, options: SourceWatcherOptions = {}): SourceWatcher {
  const failure = cause(ctx)
  if (failure !== null) throw failure
  if (options.poll !== undefined && typeof options.poll !== "function") {
    throw new TypeError("source watcher poll must be a function")
  }
  if (options.poll !== undefined && typeof options.backoff !== "function") {
    throw new TypeError("source watcher backoff is required with poll")
  }
  if (options.retryable !== undefined && typeof options.retryable !== "function") {
    throw new TypeError("source watcher retryable must be a function")
  }
  if (options.release !== undefined && typeof options.release !== "function") {
    throw new TypeError("source watcher release must be a function")
  }
  const intervalMs = options.intervalMs ?? 0
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
    throw new RangeError("source watcher intervalMs must be an integer from 0 through 2147483647")
  }
  const [owner, cancelOwner] = withCancelCause(detachSpan(withoutCancel(ctx)))
  const wakeup = newWakeup()
  let dirty = options.dirty === true
  let terminal: Error | null = null
  let stopped = false
  let waiter: SourceWaiter | null = null
  let releaseStarted = false
  let stopping: Promise<void> | null = null

  /** Settles a pending next when a change, failure, or stop is already known. */
  function settle(): void {
    if (waiter === null) return
    if (terminal !== null) {
      const pending = waiter
      waiter = null
      pending.stop()
      pending.reject(terminal)
      return
    }
    if (stopped) {
      const pending = waiter
      waiter = null
      pending.stop()
      pending.reject(stoppedError)
      return
    }
    if (dirty) {
      dirty = false
      const pending = waiter
      waiter = null
      pending.stop()
      pending.resolve()
    }
  }

  const handle: SourceWatcher = {
    ctx: owner,
    watcher: {
      /** Waits for one coalesced change. A second concurrent call is rejected. */
      next(nextCtx: Context): Promise<void> {
        const ended = cause(nextCtx)
        if (ended !== null) return Promise.reject(ended)
        if (terminal !== null) return Promise.reject(terminal)
        if (stopped) return Promise.reject(stoppedError)
        if (waiter !== null) return Promise.reject(busyError)
        if (dirty) {
          dirty = false
          return Promise.resolve()
        }
        return new Promise<void>((resolve, reject) => {
          const pending: SourceWaiter = { resolve, reject, stop: () => {} }
          waiter = pending
          /** Rejects this next when its Context ends before a change arrives. */
          const abandon = (): void => {
            if (waiter !== pending) return
            waiter = null
            reject(cause(nextCtx) ?? nextCtx.err() ?? canceled)
          }
          try {
            pending.stop = afterFunc(nextCtx, abandon)
          } catch (error) {
            pending.stop()
            if (waiter === pending) waiter = null
            reject(isError(error) ? error : toError(error, "source watcher next failed"))
          }
        })
      },
      /** Stops the loop and releases plug resources once. */
      stop(stopCtx: Context): Promise<void> {
        if (stopping === null) {
          stopped = true
          if (terminal === null) cancelOwner(canceled)
          stopping = finish(stopCtx)
        }
        return waitForContext(stopCtx, stopping)
      }
    },
    /** Records one change and wakes a waiting next. */
    changed(): void {
      if (stopped || terminal !== null) return
      dirty = true
      settle()
    },
    /** Ends the current poll interval early. */
    wake(): void {
      wakeup.wake()
    },
    /** Rejects the pending and every later next with `error`. */
    fail(error: Error): void {
      if (terminal !== null || stopped) return
      terminal = isError(error) ? error : toError(error, "source watcher failed")
      cancelOwner(terminal)
      settle()
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
                poll: options.poll as (ctx: Context) => Promise<boolean>,
                /** A true result, or the first success after failures, is one change. */
                result(changed: boolean, recovered: boolean): void {
                  if (changed || recovered) handle.changed()
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
            handle.fail(isError(error) ? error : toError(error, "source watcher failed"))
          }
        })

  /** Waits for the loop, then runs release once and rejects a pending next. */
  async function finish(stopCtx: Context): Promise<void> {
    await loop
    if (!releaseStarted && options.release !== undefined) {
      releaseStarted = true
      try {
        await options.release(stopCtx)
      } catch {
        // Release failure does not replace the stop result.
      }
    }
    settle()
  }

  return handle
}

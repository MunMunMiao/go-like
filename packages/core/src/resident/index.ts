import { afterFunc, cause, withCancelCause, withoutCancel, type Context } from "../context/index"
import { isError, toError } from "../internal/errors"
import { waitForDelay } from "../internal/context"
import { detachSpan, enterRoot } from "../telemetry/internal/state"

/** Delay, in milliseconds, before the next resident attempt. */
export type Backoff = (attempt: number) => number

/**
 * Wait that `wake` can end early.
 * A wake with no waiter is remembered once.
 */
export interface Wakeup {
  /** Ends the current wait, or remembers one wake when nobody is waiting. */
  wake(): void
  /** Resolves after `ms` or a wake. Rejects when `ctx` ends. */
  wait(ctx: Context, ms: number): Promise<void>
}

/** One resident iteration. The consecutive-failure count resets after a successful poll. */
export interface ResidentLoop<T> {
  readonly poll: (ctx: Context) => Promise<T>
  readonly result: (value: T, recovered: boolean) => void
  readonly backoff: Backoff
  readonly retryable: (error: unknown) => boolean
  readonly intervalMs: number
  readonly terminal: (error: Error) => void
}

/** Creates a wakeup. Timers stay referenced so the process remains alive while a resident is scheduled. */
export function newWakeup(): Wakeup {
  let pending = false
  let current: (() => void) | null = null
  return {
    /** Releases the current waiter, or stores a single wake. */
    wake(): void {
      if (current !== null) {
        const resolve = current
        current = null
        resolve()
      } else {
        pending = true
      }
    },
    /** Waits for `ms`, a stored wake, or the end of `ctx`. */
    wait(ctx: Context, ms: number): Promise<void> {
      const failure = cause(ctx)
      if (failure !== null) return Promise.reject(failure)
      if (pending) {
        pending = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const stop = afterFunc(ctx, () => {
          if (timer !== null) clearTimeout(timer)
          current = null
          reject(cause(ctx) ?? ctx.err())
        })
        /** Clears the timer and resolves the wait. */
        const finish = (): void => {
          if (timer !== null) clearTimeout(timer)
          stop()
          current = null
          resolve()
        }
        current = finish
        timer = setTimeout(finish, ms)
      })
    }
  }
}

/** Runs until `ctx` ends or a poll fails and is not retryable. */
export async function runResident<T>(
  ctx: Context,
  loop: ResidentLoop<T>,
  wakeup: Wakeup
): Promise<void> {
  let failures = 0
  while (ctx.err() === null) {
    const startedAt = performance.now()
    let value: T
    try {
      value = await loop.poll(ctx)
    } catch (error) {
      if (ctx.err() !== null) return
      if (!loop.retryable(error)) {
        loop.terminal(
          isError(error) ? error : toError(error, "resident poll failed with a non-Error value")
        )
        return
      }
      failures += 1
      try {
        await waitForDelay(ctx, loop.backoff(failures))
      } catch {
        return
      }
      continue
    }
    const recovered = failures > 0
    failures = 0
    loop.result(value, recovered)
    const remaining = loop.intervalMs - (performance.now() - startedAt)
    if (remaining > 0) {
      try {
        await wakeup.wait(ctx, remaining)
      } catch {
        return
      }
    }
  }
}

/**
 * Owner context for a resident shell.
 * Values are kept, the span is dropped, and cancellation follows `ctx` without sharing its deadline.
 */
export function residentOwner(ctx: Context): Context {
  const failure = cause(ctx)
  if (failure !== null) throw failure
  const [owner, cancel] = withCancelCause(detachSpan(withoutCancel(ctx)))
  afterFunc(ctx, () => {
    cancel(cause(ctx))
  })
  return owner
}

/** Runs `loop` under `residentOwner` and a reset implicit trace context. */
export function spawnResident<T>(
  ctx: Context,
  loop: ResidentLoop<T>,
  wakeup?: Wakeup
): Promise<void> {
  const owner = residentOwner(ctx)
  const selected = wakeup ?? newWakeup()
  return Promise.resolve(enterRoot(owner, () => runResident(owner, loop, selected)))
}

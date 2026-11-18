import { newCancelContext, type CancelHandle } from "./cancel"
import { canceled, deadlineExceeded } from "./errors"
import {
  inspectContext,
  snapshotDeadline,
  snapshotDone,
  validateErrorOrNull,
  type ContextMethods
} from "./internal"
import type { CancelFunc, Context } from "./errors"

const maximumTimerDelay = 2_147_483_647
const maximumTimeClip = 8_640_000_000_000_000

/** Validates and snapshots a Date deadline without trusting overridden instance methods. */
function snapshotRequestedDeadline(deadline: Date): number {
  let epoch: number
  try {
    epoch = Date.prototype.getTime.call(deadline)
  } catch {
    throw new TypeError("deadline must be a Date")
  }
  if (!Number.isFinite(epoch)) throw new RangeError("deadline must be a valid finite Date")
  return epoch
}

/** Reads Date.now() and rejects values outside the ECMAScript TimeClip range. */
function snapshotWallNow(): number {
  const wallNow = Date.now()
  if (!Number.isFinite(wallNow) || wallNow < -maximumTimeClip || wallNow > maximumTimeClip) {
    throw new RangeError("Date.now() must return a valid TimeClip value")
  }
  return wallNow
}

/** Arms a monotonic timer that cancels handle when its own wall-clock deadline arrives. */
function startDeadlineTimer(
  handle: CancelHandle,
  requestedEpoch: number,
  wallNow: number,
  cause: Error
): void {
  if (handle.context.err() !== null) return
  if (requestedEpoch <= wallNow) {
    handle.cancel(deadlineExceeded, cause)
    return
  }

  const monotonicNow = performance.now()
  const monotonicTarget = monotonicNow + (requestedEpoch - wallNow)
  if (!Number.isFinite(monotonicNow)) {
    handle.cancel(canceled, canceled)
    throw new RangeError("performance.now() must produce a finite monotonic target")
  }
  if (handle.context.err() !== null) return

  let active = true
  let timerId: ReturnType<typeof setTimeout> | null = null

  /** Schedules the next bounded timer segment toward the monotonic deadline. */
  const arm = (remaining: number): void => {
    const delay = Math.min(maximumTimerDelay, Math.max(0, remaining))
    const id = setTimeout(wake, delay)
    if (active) timerId = id
    else clearTimeout(id)
  }

  /** Re-arms early timer wakes or cancels the context once the deadline is reached. */
  const wake = (): void => {
    if (!active) return
    timerId = null
    const current = performance.now()
    if (current < monotonicTarget) {
      arm(monotonicTarget - current)
      return
    }
    handle.cancel(deadlineExceeded, cause)
  }

  handle.addCleanup(() => {
    active = false
    if (timerId !== null) {
      clearTimeout(timerId)
      timerId = null
    }
  })

  try {
    arm(requestedEpoch - wallNow)
  } catch (error) {
    handle.cancel(canceled, canceled)
    throw error
  }
}

/** Creates either Go's WithCancel(parent) fast path or one owned timer context. */
function newTimedContext(
  methods: ContextMethods,
  requestedEpoch: number,
  parentEpoch: number | null,
  requestedCause: Error | null
): CancelHandle {
  const parentSignal = snapshotDone(methods)
  if (parentEpoch !== null && parentEpoch < requestedEpoch) {
    return newCancelContext(methods, null, parentSignal)
  }
  const handle = newCancelContext(methods, requestedEpoch, parentSignal)
  let wallNow: number
  try {
    wallNow = snapshotWallNow()
  } catch (error) {
    handle.cancel(canceled, canceled)
    throw error
  }
  startDeadlineTimer(handle, requestedEpoch, wallNow, requestedCause ?? deadlineExceeded)
  return handle
}

/** Validates a Date deadline and creates the corresponding timed child context. */
function newDeadlineContext(parent: Context, deadline: Date, cause: Error | null): CancelHandle {
  const methods = inspectContext(parent)
  const requestedEpoch = snapshotRequestedDeadline(deadline)
  const requestedCause = validateErrorOrNull(cause, "deadline cause must be an Error or null")
  const parentEpoch = snapshotDeadline(methods)
  return newTimedContext(methods, requestedEpoch, parentEpoch, requestedCause)
}

/** Validates a timeout duration and creates a timed child context relative to the current wall clock. */
function newTimeoutContext(parent: Context, timeoutMs: number, cause: Error | null): CancelHandle {
  const methods = inspectContext(parent)
  if (!Number.isFinite(timeoutMs)) throw new RangeError("timeoutMs must be finite")
  const requestedCause = validateErrorOrNull(cause, "timeout cause must be an Error or null")
  const wallNow = snapshotWallNow()
  const rawRequestedEpoch = wallNow + timeoutMs
  if (
    !Number.isFinite(rawRequestedEpoch) ||
    rawRequestedEpoch < -maximumTimeClip ||
    rawRequestedEpoch > maximumTimeClip
  ) {
    throw new RangeError("timeout deadline is outside the TimeClip range")
  }
  const requestedEpoch = Math.trunc(rawRequestedEpoch)
  const parentEpoch = snapshotDeadline(methods)
  return newTimedContext(methods, requestedEpoch, parentEpoch, requestedCause)
}

/** Pairs a cancel handle's context with an idempotent explicit cancellation callback. */
function cancelTuple(handle: CancelHandle): readonly [Context, CancelFunc] {
  return [
    handle.context,
    () => {
      handle.cancel(canceled, canceled)
    }
  ]
}

/** Returns a child context canceled when deadline is reached or its returned function is invoked. */
export function withDeadline(parent: Context, deadline: Date): readonly [Context, CancelFunc] {
  return cancelTuple(newDeadlineContext(parent, deadline, null))
}

/** Returns a deadline-bound child context that preserves cause when its own deadline wins. */
export function withDeadlineCause(
  parent: Context,
  deadline: Date,
  cause: Error | null
): readonly [Context, CancelFunc] {
  return cancelTuple(newDeadlineContext(parent, deadline, cause))
}

/** Returns a child context that expires after timeoutMs or when explicitly canceled. */
export function withTimeout(parent: Context, timeoutMs: number): readonly [Context, CancelFunc] {
  return cancelTuple(newTimeoutContext(parent, timeoutMs, null))
}

/** Returns a timeout-bound child context that records cause if its own timeout expires first. */
export function withTimeoutCause(
  parent: Context,
  timeoutMs: number,
  cause: Error | null
): readonly [Context, CancelFunc] {
  return cancelTuple(newTimeoutContext(parent, timeoutMs, cause))
}

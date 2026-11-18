import { canceled } from "./errors"
import { registerContextAfterFunc } from "./after-func"
import {
  inspectContext,
  readCause,
  readParentFailure,
  registerCancelNode,
  registerCause,
  resolveDeadline,
  resolveValue,
  snapshotDone,
  validateErrorOrNull,
  type ContextMethods,
  type SignalMethods
} from "./internal"
import type { CancelCauseFunc, CancelFunc, Context, ContextError } from "./errors"

/** Represents one deferred parent-to-child cancellation transition. */
type ParentCancellationTask = (wave: CancellationWave) => void

/** Tracks one node's cleanup callbacks without reversing their registration order. */
interface CancellationCleanupFrame {
  /** Contains cleanup callbacks in registration order. */
  readonly callbacks: readonly (() => void)[]
  /** Points to the next callback admitted from this frame. */
  cursor: number
}

/** Holds one synchronous cancellation boundary and its post-order cleanup phase. */
interface CancellationWave {
  readonly tasks: ParentCancellationTask[]
  /** Runs descendant cleanup groups before ancestors while preserving each node's cleanup order. */
  readonly cleanupFrames: CancellationCleanupFrame[]
  taskCursor: number
}

let activeCancellationWave: CancellationWave | null = null

/** Drains descendants before cleanup, while prioritizing work added by cleanup re-entry. */
function drainCancellationWave(wave: CancellationWave): void {
  while (wave.taskCursor < wave.tasks.length || wave.cleanupFrames.length > 0) {
    while (wave.taskCursor < wave.tasks.length) {
      const current = wave.tasks[wave.taskCursor]
      wave.taskCursor += 1
      if (current !== undefined) current(wave)
    }
    const frame = wave.cleanupFrames.at(-1)
    if (frame === undefined) continue
    const cleanup = frame.callbacks[frame.cursor]
    if (cleanup === undefined) {
      wave.cleanupFrames.pop()
      continue
    }
    frame.cursor += 1
    try {
      cleanup()
    } catch {
      // Cleanup failures are isolated so every deferred cleanup remains reachable.
    }
  }
}

/** Runs one independently synchronous cancellation wave, including under outer re-entry. */
function runCancellationWave(task: ParentCancellationTask): void {
  const previous = activeCancellationWave
  const wave: CancellationWave = {
    tasks: [task],
    cleanupFrames: [],
    taskCursor: 0
  }
  activeCancellationWave = wave
  try {
    drainCancellationWave(wave)
  } finally {
    activeCancellationWave = previous
  }
}

/** Runs parent-to-child cancellation tasks iteratively to avoid recursive AbortSignal chains. */
function enqueueParentCancellation(task: ParentCancellationTask): void {
  if (activeCancellationWave === null) runCancellationWave(task)
  else activeCancellationWave.tasks.push(task)
}

export interface CancelHandle {
  readonly context: Context
  /** Performs the handle's single terminal cancellation transition. */
  cancel(err: ContextError, cause: Error): boolean
  /** Registers cleanup work to run when the handle reaches cancellation. */
  addCleanup(cleanup: () => void): void
}

/**
 * Creates a derived context with its own cancellation state and optional parent listener.
 *
 * Its handle exposes the context, the terminal cancellation transition, and cleanup
 * registration used by deadline timers.
 */
export function newCancelContext(
  parent: ContextMethods,
  deadlineEpoch: number | null,
  parentSignal: SignalMethods | null
): CancelHandle {
  const controller = new AbortController()
  const cleanups = new Set<() => void>()
  let observedErr: ContextError | null = null
  let observedCause: Error | null = null

  /** Settles this node's Done before running cleanup code that may re-enter the Context. */
  const settle = (err: ContextError, cancellationCause: Error, wave: CancellationWave): boolean => {
    if (observedErr !== null) return false
    observedErr = err
    observedCause = cancellationCause
    const pendingCleanups = Array.from(cleanups)
    cleanups.clear()
    controller.abort(err)
    if (pendingCleanups.length > 0) {
      wave.cleanupFrames.push({ callbacks: pendingCleanups, cursor: 0 })
    }
    return true
  }

  /** Runs one independent wave so this CancelFunc returns only after its descendants settle. */
  const cancel = (err: ContextError, cancellationCause: Error): boolean => {
    if (observedErr !== null) return false
    let settled = false
    runCancellationWave((wave) => {
      settled = settle(err, cancellationCause, wave)
    })
    return settled
  }

  let registeringParent = true
  /** Propagates the parent's normalized terminal error and cause into the child. */
  const cancelFromParent = (): void => {
    if (registeringParent) {
      const failure = readParentFailure(parent)
      runCancellationWave((wave) => {
        settle(failure.err, failure.cause, wave)
      })
      return
    }
    enqueueParentCancellation((wave) => {
      const failure = readParentFailure(parent)
      settle(failure.err, failure.cause, wave)
    })
  }

  const context: Context = Object.freeze({
    /** Returns the inherited effective deadline, or no-deadline when absent. */
    deadline(): readonly [Date, boolean] {
      return deadlineEpoch === null ? resolveDeadline(parent) : [new Date(deadlineEpoch), true]
    },
    /** Returns this derived context's cancellation signal. */
    done(): AbortSignal {
      return controller.signal
    },
    /** Returns the terminal cancellation error after cancellation. */
    err(): ContextError | null {
      return observedErr
    },
    /** Delegates value lookup to the parent context. */
    value(key: unknown): unknown {
      return resolveValue(inspectContext(context), key)
    }
  })
  const handle: CancelHandle = Object.freeze({
    context,
    cancel,
    /** Registers work that is run exactly once when this handle is canceled. */
    addCleanup(cleanup: () => void): void {
      cleanups.add(cleanup)
    }
  })
  registerCause(context, () => observedCause)
  registerCancelNode(context, parent, controller.signal, deadlineEpoch, () => observedErr)

  if (parentSignal === null) return handle
  const stopParent = registerContextAfterFunc(parent, parentSignal, cancelFromParent, false)
  registeringParent = false
  if (observedErr === null) cleanups.add(stopParent)
  else stopParent()
  return handle
}

/** Snapshots a parent Context before creating its cancelable child. */
function newCancelContextFromParent(parent: Context): CancelHandle {
  const methods = inspectContext(parent)
  const signal = snapshotDone(methods)
  return newCancelContext(methods, null, signal)
}

/** Returns a child context and a cancellation callback using the standard canceled error. */
export function withCancel(parent: Context): readonly [Context, CancelFunc] {
  const handle = newCancelContextFromParent(parent)
  return [
    handle.context,
    () => {
      handle.cancel(canceled, canceled)
    }
  ]
}

/** Returns a child context and a callback that records a caller-supplied cancellation cause. */
export function withCancelCause(parent: Context): readonly [Context, CancelCauseFunc] {
  const handle = newCancelContextFromParent(parent)
  return [
    handle.context,
    (cancellationCause) => {
      const validatedCause = validateErrorOrNull(
        cancellationCause,
        "cancel cause must be an Error or null"
      )
      handle.cancel(canceled, validatedCause ?? canceled)
    }
  ]
}

/** Returns the recorded terminal cause for context, or its cancellation error when no cause was recorded. */
export function cause(context: Context): Error | null {
  return readCause(inspectContext(context))
}

import { canceled, type Context, type ContextError } from "@go-like/context"

export interface ContextState {
  readonly context: Context
  readonly err: Context["err"]
  readonly signal: AbortSignal | null
}

/** Reports whether a value can carry structural Context methods. */
function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** Recognizes standard Error objects across realms without depending on one runtime's globals. */
function isError(value: unknown): value is ContextError {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  const candidate: unknown = descriptor?.value
  if (typeof candidate === "function") return candidate(value) === true
  return value instanceof Error
}

/** Snapshots the Context methods used by resilience operations and validates their runtime shape. */
export function inspectContext(ctx: Context): ContextState {
  if (!isObject(ctx)) throw new TypeError("ctx must be a Context")
  const err = ctx.err
  const done = ctx.done
  if (typeof err !== "function" || typeof done !== "function") {
    throw new TypeError("ctx must implement the Context method shape")
  }
  const signal = done.call(ctx)
  if (signal !== null) {
    if (
      !isObject(signal) ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    ) {
      throw new TypeError("Context.done() must return an AbortSignal or null")
    }
  }
  return { context: ctx, err, signal }
}

/** Reads the Context's terminal error and closes a signal-to-error race with canceled. */
export function readContextFailure(state: ContextState): ContextError | null {
  const failure = state.err.call(state.context)
  if (failure !== null) {
    if (!isError(failure)) throw new TypeError("Context.err() must return an Error or null")
    return failure
  }
  return state.signal?.aborted === true ? canceled : null
}

/** Validates a Context and throws its terminal error before admitting new work. */
export function activeContext(ctx: Context): ContextState {
  const state = inspectContext(ctx)
  const failure = readContextFailure(state)
  if (failure !== null) throw failure
  return state
}

/** Reads the standard monotonic clock used for elapsed circuit-breaker durations. */
export function monotonicNow(): number {
  const value = performance.now()
  if (!Number.isFinite(value)) throw new RangeError("performance.now() must return a finite number")
  return value
}

/** Waits for a retry delay while making Context cancellation release the timer and listener. */
export function waitForDelay(ctx: Context, delayMs: number): Promise<void> {
  const state = activeContext(ctx)
  if (delayMs === 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let listening = false

    /** Releases the timer and abort listener without replacing the selected outcome. */
    function cleanup(): void {
      if (timer !== null) {
        const pendingTimer = timer
        timer = null
        try {
          clearTimeout(pendingTimer)
        } catch {
          // Timer cleanup is best-effort after the outcome has already been selected.
        }
      }
      if (listening && state.signal !== null) {
        listening = false
        try {
          state.signal.removeEventListener("abort", cancelDelay)
        } catch {
          // Listener cleanup is best-effort after the outcome has already been selected.
        }
      }
    }

    /** Completes the requested delay once. */
    function finishDelay(): void {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    /** Rejects the delay with the Context's terminal error once. */
    function cancelDelay(): void {
      if (settled) return
      settled = true
      let failure: ContextError
      try {
        failure = readContextFailure(state) ?? canceled
      } catch (error) {
        cleanup()
        reject(error)
        return
      }
      cleanup()
      reject(failure)
    }

    try {
      if (state.signal !== null) {
        listening = true
        state.signal.addEventListener("abort", cancelDelay, { once: true })
        if (settled) return
        if (state.signal.aborted) {
          cancelDelay()
          return
        }
      }
      timer = setTimeout(finishDelay, delayMs)
      if (settled) cleanup()
    } catch (error) {
      settled = true
      cleanup()
      reject(error)
    }
  })
}

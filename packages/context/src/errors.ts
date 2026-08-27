/** Describes the stable cancellation error exposed by a Context. */
export interface ContextError extends Error {}

/** Describes a deadline error with Go-compatible timeout predicates. */
export interface TimeoutContextError extends ContextError {
  /** Reports whether the error was caused by a deadline or timeout. */
  timeout(): boolean
  /** Reports whether retrying the timed-out operation may succeed. */
  temporary(): boolean
}

/** Carries deadlines, cancellation, errors, and request-scoped values across API boundaries. */
export interface Context {
  /** Returns the effective deadline and whether one is present. */
  deadline(): readonly [Date, boolean]
  /** Returns the cancellation signal, or null when cancellation is disabled. */
  done(): AbortSignal | null
  /** Returns the terminal cancellation error, or null while the context is active. */
  err(): ContextError | null
  /** Returns the value associated with key, or null when no value is present. */
  value(key: unknown): unknown
}

/** Cancels a derived context without supplying a custom cause. */
export type CancelFunc = () => void
/** Cancels a derived context and records an optional caller-supplied cause. */
export type CancelCauseFunc = (cause: Error | null) => void
/** Stops pending work and reports whether it was prevented from starting. */
export type StopFunc = () => boolean

/** Creates an immutable ContextError with the package's stable name and message. */
function newContextError(message: string, name: string): ContextError {
  const error = new Error(message)
  error.name = name
  return Object.freeze(error)
}

/** Creates an immutable timeout ContextError with Go-compatible timeout and temporary predicates. */
function newTimeoutContextError(message: string, name: string): TimeoutContextError {
  const error = Object.assign(new Error(message), {
    name,
    /** Reports that this error represents deadline expiration. */
    timeout(): boolean {
      return true
    },
    /** Reports that callers may treat deadline expiration as temporary. */
    temporary(): boolean {
      return true
    }
  })
  return Object.freeze(error)
}

export const canceled = newContextError("context canceled", "Canceled")
export const deadlineExceeded = newTimeoutContextError(
  "context deadline exceeded",
  "DeadlineExceeded"
)

import { afterFunc, canceled, cause, type Context, type StopFunc } from "@go-like/context"

/** Resolves the effective cancellation Error for an externally supplied Context. */
function cancellationError(ctx: Context): Error {
  return cause(ctx) ?? ctx.err() ?? canceled
}

/** Rejects a waiter with cancellation while preserving Context inspection failures. */
function rejectCancellation(ctx: Context, reject: (reason?: unknown) => void): void {
  try {
    reject(cancellationError(ctx))
  } catch (error) {
    reject(error)
  }
}

/** Releases a Context callback without replacing an operation that already won the race. */
function stopWithoutReplacingWinner(stop: StopFunc): boolean {
  try {
    return stop()
  } catch {
    return true
  }
}

/** Waits for an operation while allowing only the caller Context to abandon its own wait. */
export function waitForContext<T>(ctx: Context, operation: PromiseLike<T>): Promise<T> {
  const operationPromise = Promise.resolve(operation)
  return new Promise<T>((resolve, reject) => {
    let initialError: Error | null
    try {
      initialError = ctx.err()
    } catch (error) {
      void operationPromise.catch(() => {})
      reject(error)
      return
    }
    if (initialError !== null) {
      void operationPromise.catch(() => {})
      rejectCancellation(ctx, reject)
      return
    }

    let settled = false
    let stop: StopFunc
    try {
      stop = afterFunc(ctx, () => {
        settled = true
        rejectCancellation(ctx, reject)
      })
    } catch (error) {
      void operationPromise.catch(() => {})
      reject(error)
      return
    }

    operationPromise.then(
      (value) => {
        if (settled || !stopWithoutReplacingWinner(stop)) return
        settled = true
        resolve(value)
      },
      (error: unknown) => {
        if (settled || !stopWithoutReplacingWinner(stop)) return
        settled = true
        reject(error)
      }
    )
  })
}

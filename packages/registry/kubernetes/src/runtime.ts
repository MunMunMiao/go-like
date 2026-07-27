import { cause, deadlineExceeded, type Context } from "@likego/context"

import { boundaryError } from "./errors"

/** Owns one joined caller, owner, and deadline signal. */
export interface OperationLease {
  readonly signal: AbortSignal
  /** Releases linked listeners and the operation timer. */
  release(): void
}

/** Observes one intentionally detached rejection. */
export function ignoreFailure(_value: unknown): void {}

/** Returns the exact terminal Context cause, or null while active. */
export function contextFailure(ctx: Context): Error | null {
  return cause(ctx)
}

/** Links caller cancellation, optional owner cancellation, and one operation timeout. */
export function operationLease(
  ctx: Context,
  owner: AbortSignal | null,
  timeoutMs: number
): OperationLease {
  const controller = new AbortController()
  const caller = ctx.done()
  /** Propagates one linked signal's exact reason. */
  function abortFrom(signal: AbortSignal): void {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  /** Propagates caller cancellation. */
  function callerAborted(): void {
    if (!controller.signal.aborted) {
      controller.abort(contextFailure(ctx) ?? caller?.reason)
    }
  }
  /** Propagates owner cancellation. */
  function ownerAborted(): void {
    if (owner !== null) abortFrom(owner)
  }
  if (caller?.aborted === true) callerAborted()
  else caller?.addEventListener("abort", callerAborted, { once: true })
  if (owner?.aborted === true) ownerAborted()
  else owner?.addEventListener("abort", ownerAborted, { once: true })
  const timer = setTimeout(
    /** Aborts this exact operation at its common deadline. */
    function timedOut(): void {
      if (!controller.signal.aborted) controller.abort(deadlineExceeded)
    },
    timeoutMs
  )
  return Object.freeze({
    signal: controller.signal,
    /** Releases every operation-owned listener and timer. */
    release(): void {
      clearTimeout(timer)
      caller?.removeEventListener("abort", callerAborted)
      owner?.removeEventListener("abort", ownerAborted)
    }
  })
}

/** Converts an aborted signal into its exact Error identity. */
export function signalFailure(signal: AbortSignal, message: string): Error {
  return boundaryError(signal.reason, message)
}

/** Waits one timer interval while respecting an owner signal. */
export function waitForSignal(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signalFailure(signal, "Kubernetes wait was aborted"))
  return new Promise<void>(
    /** Owns the timer and its matching abort listener. */
    function wait(resolve, reject): void {
      /** Resolves the timer and releases the abort listener. */
      function elapsed(): void {
        signal.removeEventListener("abort", aborted)
        resolve()
      }
      /** Rejects the timer with the exact owner cause. */
      function aborted(): void {
        clearTimeout(timer)
        reject(signalFailure(signal, "Kubernetes wait was aborted"))
      }
      const timer = setTimeout(elapsed, timeoutMs)
      signal.addEventListener("abort", aborted, { once: true })
    }
  )
}

/// <reference lib="es2024.promise" />

import { cause, deadlineExceeded, type Context } from "@likego/context"

import { boundaryError } from "./errors"

/** Carries a stable externally observable terminal promise. */
export interface Completion {
  readonly promise: Promise<void>
  /** Resolves the terminal barrier once. */
  resolve(): void
  /** Rejects the terminal barrier once. */
  reject(error: Error): void
}

/** Owns one joined caller/owner/deadline AbortSignal. */
export interface OperationLease {
  readonly signal: AbortSignal
  /** Releases the operation timer and linked abort listeners. */
  release(): void
}

/** Observes an intentionally detached rejection. */
export function ignoreFailure(_value: unknown): void {}

/** Creates one stable terminal completion. */
export function completion(): Completion {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  void promise.catch(ignoreFailure)
  return Object.freeze({ promise, resolve, reject })
}

/** Returns the exact terminal Context cause, or null while active. */
export function contextFailure(ctx: Context): Error | null {
  return cause(ctx)
}

/** Links caller cancellation, owner cancellation, and an operation timeout. */
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
    if (caller !== null) abortFrom(caller)
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

/** Converts an aborted operation into its exact Error identity. */
export function signalFailure(signal: AbortSignal, message: string): Error {
  return boundaryError(signal.reason, message)
}

/** Waits one timer interval while respecting an owner signal. */
export function waitForSignal(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signalFailure(signal, "Consul wait was aborted"))
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
        reject(signalFailure(signal, "Consul wait was aborted"))
      }
      const timer = setTimeout(elapsed, timeoutMs)
      signal.addEventListener("abort", aborted, { once: true })
    }
  )
}

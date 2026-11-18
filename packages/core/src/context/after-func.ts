import {
  hasLocalCancelSignal,
  inspectContext,
  snapshotDone,
  type ContextMethods,
  type SignalMethods
} from "./internal"
import type { Context, StopFunc } from "./errors"

type OnceState = "pending" | "admitted" | "stopped" | "invalid"

/** Describes an optional context-owned hook for registering cancellation work. */
type AfterFuncDelegate = (this: Context, callback: () => void) => unknown

/** Queues an admitted callback after the current synchronous cancellation work finishes. */
function queueCallback(fn: () => void): void {
  queueMicrotask(fn)
}

/** Identifies an optional context hook that can register a cancellation callback. */
function isAfterFuncDelegate(value: unknown): value is AfterFuncDelegate {
  return typeof value === "function"
}

/** Reads a custom hook while excluding properties inherited only from Object.prototype. */
function readAfterFuncDelegate(context: Context): unknown {
  if (Object.getOwnPropertyDescriptor(Object.prototype, "afterFunc") === undefined) {
    return Reflect.get(context, "afterFunc", context)
  }

  let owner: object | null = context
  while (owner !== null && owner !== Object.prototype) {
    if (Object.getOwnPropertyDescriptor(owner, "afterFunc") !== undefined) {
      return Reflect.get(context, "afterFunc", context)
    }
    owner = Object.getPrototypeOf(owner)
  }
  return undefined
}

/**
 * Adapts a custom context after-function hook to the once-only StopFunc contract.
 *
 * The returned callback stops only a still-pending registration; it never races an
 * already admitted callback back into the pending state.
 */
function delegateAfterFunc(
  methods: ContextMethods,
  delegate: AfterFuncDelegate,
  fn: () => void,
  queued: boolean
): StopFunc {
  let state: OnceState = "pending"
  let ready = false
  let bufferedAdmission = false
  let stopAttempted = false

  /** Admits the delegated callback once registration has returned successfully. */
  const admit = (): void => {
    if (!ready) {
      bufferedAdmission = true
      return
    }
    if (state !== "pending") return
    state = "admitted"
    if (queued) queueCallback(fn)
    else fn()
  }

  let delegateStop: unknown
  try {
    delegateStop = delegate.call(methods.context, admit)
  } catch (error) {
    state = "invalid"
    bufferedAdmission = false
    throw error
  }
  if (typeof delegateStop !== "function") {
    state = "invalid"
    bufferedAdmission = false
    throw new TypeError("custom afterFunc must return a callable StopFunc")
  }

  ready = true
  if (bufferedAdmission) admit()

  return () => {
    if (state !== "pending" || stopAttempted) return false
    stopAttempted = true
    let stopped: unknown
    try {
      stopped = delegateStop()
    } catch (error) {
      if (state === "pending") state = "stopped"
      throw error
    }
    if (state !== "pending") return false
    if (stopped !== true) return false
    state = "stopped"
    return true
  }
}

/** Registers a callback against a context signal and returns its once-only stopper. */
function signalAfterFunc(
  signalMethods: SignalMethods | null,
  fn: () => void,
  queued: boolean,
  initialState: "aborted" | "open" = "open"
): StopFunc {
  let state: OnceState = "pending"
  let listening = false

  /** Removes the abort listener once admission, stopping, or setup failure occurs. */
  const removeListener = (): void => {
    if (!listening || signalMethods === null) return
    listening = false
    try {
      signalMethods.removeEventListener.call(signalMethods.signal, "abort", admit)
    } catch {
      // Listener cleanup cannot block callback admission or replace a registration failure.
    }
  }

  /** Admits the signal-backed callback exactly once and releases its listener. */
  const admit = (): void => {
    if (state !== "pending") return
    state = "admitted"
    removeListener()
    if (queued) queueCallback(fn)
    else fn()
  }

  if (signalMethods === null) {
    return () => {
      if (state !== "pending") return false
      state = "stopped"
      return true
    }
  }

  if (initialState === "aborted") {
    admit()
  } else {
    listening = true
    try {
      signalMethods.addEventListener.call(signalMethods.signal, "abort", admit, { once: true })
      if (signalMethods.signal.aborted) admit()
    } catch (error) {
      removeListener()
      throw error
    }
  }

  return () => {
    if (state !== "pending") return false
    state = "stopped"
    removeListener()
    return true
  }
}

/** Applies Go's Done, local-cancel, custom-hook, then signal registration order. */
export function registerContextAfterFunc(
  methods: ContextMethods,
  signalMethods: SignalMethods | null,
  fn: () => void,
  queued: boolean
): StopFunc {
  if (signalMethods === null) return signalAfterFunc(null, fn, queued)
  if (signalMethods.signal.aborted) return signalAfterFunc(signalMethods, fn, queued, "aborted")
  if (hasLocalCancelSignal(methods, signalMethods.signal)) {
    return signalAfterFunc(signalMethods, fn, queued, "open")
  }
  const delegate = readAfterFuncDelegate(methods.context)
  if (isAfterFuncDelegate(delegate)) {
    return delegateAfterFunc(methods, delegate, fn, queued)
  }
  return signalAfterFunc(signalMethods, fn, queued, "open")
}

/**
 * Arranges for fn to run asynchronously once context is canceled.
 *
 * A callable afterFunc method is used for an open non-local signal, including normal
 * inherited and prototype methods. Otherwise the Context's AbortSignal is observed
 * directly. The returned StopFunc reports whether it prevented callback admission.
 */
export function afterFunc(context: Context, fn: () => void): StopFunc {
  const methods = inspectContext(context)
  if (typeof fn !== "function") throw new TypeError("afterFunc callback must be callable")

  return registerContextAfterFunc(methods, snapshotDone(methods), fn, true)
}

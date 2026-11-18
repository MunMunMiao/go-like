import {
  inspectContext,
  noDeadline,
  registerValueNode,
  registerWithoutCancelNode,
  resolveDeadline,
  resolveDone,
  resolveErr,
  resolveValue,
  type ContextMethods
} from "./internal"
import type { Context } from "./errors"

/** Creates a context that carries one key/value binding while delegating cancellation to its parent. */
function newValueContext(parent: ContextMethods, key: unknown, storedValue: unknown): Context {
  const context: Context = Object.freeze({
    /** Delegates deadline lookup dynamically through built-in value nodes. */
    deadline(): readonly [Date, boolean] {
      return resolveDeadline(parent)
    },
    /** Delegates cancellation-signal lookup to the parent context. */
    done(): AbortSignal | null {
      return resolveDone(parent)
    },
    /** Delegates cancellation-error lookup to the parent context. */
    err() {
      return resolveErr(parent)
    },
    /** Returns the nearest matching value binding or delegates the lookup to the parent. */
    value(requestedKey: unknown): unknown {
      return requestedKey === key ? storedValue : resolveValue(parent, requestedKey)
    }
  })
  registerValueNode(context, parent, key, storedValue)
  return context
}

/** Creates a context that preserves values but intentionally hides its parent's cancellation state. */
function newWithoutCancelContext(parent: ContextMethods): Context {
  const context: Context = Object.freeze({
    /** Reports that withoutCancel contexts have no deadline. */
    deadline(): readonly [Date, boolean] {
      return noDeadline()
    },
    /** Reports that withoutCancel contexts cannot be canceled. */
    done(): null {
      return null
    },
    /** Reports that withoutCancel contexts never expose cancellation errors. */
    err(): null {
      return null
    },
    /** Delegates value lookup to the original parent context. */
    value(key: unknown): unknown {
      return resolveValue(inspectContext(context), key)
    }
  })
  registerWithoutCancelNode(context, parent)
  return context
}

/** Returns a child context carrying value for key while retaining its parent's cancellation behavior. */
export function withValue(parent: Context, key: unknown, value: unknown): Context {
  const methods = inspectContext(parent)
  if (key === null || key === undefined)
    throw new TypeError("context value key must not be null or undefined")
  return newValueContext(methods, key, value)
}

/** Returns a child context that retains values while removing deadline and cancellation propagation. */
export function withoutCancel(parent: Context): Context {
  return newWithoutCancelContext(inspectContext(parent))
}

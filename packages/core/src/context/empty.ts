import type { Context } from "./errors"
import { noDeadline } from "./internal"

/** Creates an immutable root context with no deadline, signal, error, or values. */
function newEmptyContext(): Context {
  return Object.freeze({
    /** Reports that the root context has no deadline. */
    deadline(): readonly [Date, boolean] {
      return noDeadline()
    },
    /** Reports that the root context cannot be canceled. */
    done(): null {
      return null
    },
    /** Reports that the root context has not failed. */
    err(): null {
      return null
    },
    /** Reports that the root context does not carry values. */
    value(_key: unknown): null {
      return null
    }
  })
}

const backgroundContext = newEmptyContext()
const todoContext = newEmptyContext()

/** Returns the immutable root context used as a normal request ancestry. */
export function background(): Context {
  return backgroundContext
}

/** Returns the immutable root context used when the caller has not selected a parent yet. */
export function todo(): Context {
  return todoContext
}

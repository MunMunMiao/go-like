import { canceled, deadlineExceeded } from "./errors"
import type { Context, ContextError } from "./errors"

export interface ContextMethods {
  readonly context: Context
  readonly deadline: Context["deadline"]
  readonly done: Context["done"]
  readonly err: Context["err"]
  readonly value: Context["value"]
}

export interface SignalMethods {
  readonly signal: AbortSignal
  readonly addEventListener: AbortSignal["addEventListener"]
  readonly removeEventListener: AbortSignal["removeEventListener"]
}

type LocalContextNode =
  | {
      readonly kind: "cancel"
      readonly parent: ContextMethods
      readonly signal: AbortSignal
      readonly deadlineEpoch: number | null
      /** Reads the exact public cancellation sentinel for this local node. */
      readonly readErr: () => ContextError | null
    }
  | {
      readonly kind: "value"
      readonly parent: ContextMethods
      readonly key: unknown
      readonly storedValue: unknown
    }
  | {
      readonly kind: "without-cancel"
      readonly parent: ContextMethods
    }

const goZeroTimeEpoch = -62_135_596_800_000
const cancelContextKey = Object.freeze({})
const causeReaders = new WeakMap<object, () => Error | null>()
const localContextNodes = new WeakMap<object, LocalContextNode>()

/** Returns whether value can carry Context methods or act as a WeakMap key. */
function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** Recognizes Error objects across realms while retaining a same-realm fallback. */
function isError(value: unknown): value is Error {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  const candidate: unknown = descriptor?.value
  if (typeof candidate === "function") return candidate(value) === true
  return value instanceof Error
}

/** Returns an Error-or-null boundary value without changing a valid Error's identity. */
export function validateErrorOrNull(value: unknown, message: string): Error | null {
  if (value === null || isError(value)) return value
  throw new TypeError(message)
}

/** Validates a Context's method shape and snapshots its methods with their receiver. */
export function inspectContext(value: Context): ContextMethods {
  if (!isObject(value)) throw new TypeError("parent must be a Context")

  const deadline = value.deadline
  const done = value.done
  const err = value.err
  const contextValue = value.value
  if (
    typeof deadline !== "function" ||
    typeof done !== "function" ||
    typeof err !== "function" ||
    typeof contextValue !== "function"
  ) {
    throw new TypeError("parent must implement the Context method shape")
  }
  return { context: value, deadline, done, err, value: contextValue }
}

/** Returns a fresh Date corresponding to Go's zero time and a false presence flag. */
export function noDeadline(): readonly [Date, false] {
  return [new Date(goZeroTimeEpoch), false]
}

/** Records one local cancel node for iterative delegation and private cause lookup. */
export function registerCancelNode(
  context: Context,
  parent: ContextMethods,
  signal: AbortSignal,
  deadlineEpoch: number | null,
  readErr: () => ContextError | null
): void {
  localContextNodes.set(context, { kind: "cancel", parent, signal, deadlineEpoch, readErr })
}

/** Records one local value node so deep built-in chains can be traversed iteratively. */
export function registerValueNode(
  context: Context,
  parent: ContextMethods,
  key: unknown,
  storedValue: unknown
): void {
  localContextNodes.set(context, { kind: "value", parent, key, storedValue })
}

/** Records a local cancellation barrier while preserving iterative value delegation. */
export function registerWithoutCancelNode(context: Context, parent: ContextMethods): void {
  localContextNodes.set(context, { kind: "without-cancel", parent })
}

/** Resolves a deadline without recursively invoking built-in wrapper methods. */
export function resolveDeadline(methods: ContextMethods): readonly [Date, boolean] {
  let current = methods
  for (;;) {
    const node = localContextNodes.get(current.context)
    if (node === undefined) return current.deadline.call(current.context)
    if (node.kind === "without-cancel") return noDeadline()
    if (node.kind === "cancel" && node.deadlineEpoch !== null) {
      return [new Date(node.deadlineEpoch), true]
    }
    current = node.parent
  }
}

/** Resolves a cancellation signal without recursively invoking built-in value wrappers. */
export function resolveDone(methods: ContextMethods): AbortSignal | null {
  let current = methods
  for (;;) {
    const node = localContextNodes.get(current.context)
    if (node === undefined) return current.done.call(current.context)
    if (node.kind === "without-cancel") return null
    if (node.kind === "cancel") return node.signal
    current = node.parent
  }
}

/** Resolves a cancellation error without recursively invoking built-in value wrappers. */
export function resolveErr(methods: ContextMethods): ContextError | null {
  let current = methods
  for (;;) {
    const node = localContextNodes.get(current.context)
    if (node === undefined) {
      const observed: unknown = current.err.call(current.context)
      return validateErrorOrNull(observed, "Context.err() must return an Error or null")
    }
    if (node.kind === "without-cancel") return null
    if (node.kind === "cancel") return node.readErr()
    current = node.parent
  }
}

/** Resolves one value through built-in nodes iteratively and custom Contexts structurally. */
export function resolveValue(methods: ContextMethods, key: unknown): unknown {
  let current = methods
  for (;;) {
    const node = localContextNodes.get(current.context)
    if (node === undefined) return current.value.call(current.context, key)
    if (node.kind === "value") {
      if (node.key === key) return node.storedValue
      current = node.parent
      continue
    }
    if (node.kind === "cancel") {
      if (key === cancelContextKey) return current.context
      current = node.parent
      continue
    }
    if (key === cancelContextKey) return null
    current = node.parent
  }
}

/** Reads and validates the parent's deadline as an epoch, or returns null for no deadline. */
export function snapshotDeadline(methods: ContextMethods): number | null {
  const result = resolveDeadline(methods)
  if (!Array.isArray(result) || result.length !== 2 || typeof result[1] !== "boolean") {
    throw new TypeError("Context.deadline() must return a [Date, boolean] tuple")
  }
  if (!result[1]) return null

  let epoch: number
  try {
    epoch = Date.prototype.getTime.call(result[0])
  } catch {
    throw new TypeError("Context.deadline() must return a Date when a deadline exists")
  }
  if (!Number.isFinite(epoch)) throw new RangeError("parent deadline must be a valid finite Date")
  return epoch
}

/** Reads and validates the parent's cancellation signal and listener methods. */
export function snapshotDone(methods: ContextMethods): SignalMethods | null {
  const signal = resolveDone(methods)
  if (signal === null) return null
  if (!isObject(signal)) throw new TypeError("Context.done() must return an AbortSignal or null")

  const addEventListener = signal.addEventListener
  const removeEventListener = signal.removeEventListener
  if (
    typeof signal.aborted !== "boolean" ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function"
  ) {
    throw new TypeError("Context.done() must return an AbortSignal or null")
  }
  return { signal, addEventListener, removeEventListener }
}

/** Associates a locally derived context with its terminal-cause reader. */
export function registerCause(ctx: Context, reader: () => Error | null): void {
  causeReaders.set(ctx, reader)
}

/** Reports whether methods expose one local cancel node through the same Done signal. */
export function hasLocalCancelSignal(methods: ContextMethods, signal: AbortSignal): boolean {
  const carrier = resolveValue(methods, cancelContextKey)
  if (!isObject(carrier)) return false
  const node = localContextNodes.get(carrier)
  return node?.kind === "cancel" && node.signal === signal
}

/** Resolves a non-null observed error through a private local cause carrier. */
function causeFromObservedError(methods: ContextMethods, observed: ContextError): Error {
  const carrier = resolveValue(methods, cancelContextKey)
  if (isObject(carrier)) {
    const reader = causeReaders.get(carrier)
    if (reader !== undefined) return reader() ?? observed
  }
  return observed
}

/** Reads Err before private values, matching Go Cause suppression through outer wrappers. */
export function readCause(methods: ContextMethods): Error | null {
  const observed = resolveErr(methods)
  if (observed === null) return null
  return causeFromObservedError(methods, observed)
}

/** Normalizes a parent's terminal state for propagation into a derived cancel context. */
export function readParentFailure(methods: ContextMethods): {
  readonly err: ContextError
  readonly cause: Error
} {
  const observed = resolveErr(methods)
  const err = observed === deadlineExceeded ? deadlineExceeded : canceled
  return { err, cause: observed === null ? err : causeFromObservedError(methods, observed) }
}

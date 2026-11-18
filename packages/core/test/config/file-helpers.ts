export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

/** Creates a manually controlled Promise without a type assertion. */
export function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = missingResolve
  let rejectValue: (error: unknown) => void = missingReject
  /** Captures the native Promise settlement callbacks synchronously. */
  function executor(resolve: (value: T) => void, reject: (error: unknown) => void): void {
    resolveValue = resolve
    rejectValue = reject
  }
  return { promise: new Promise<T>(executor), resolve: resolveValue, reject: rejectValue }
}

/** Rejects impossible resolver use before Promise construction. */
function missingResolve(_value: unknown): void {
  throw new Error("resolver unavailable")
}

/** Rejects impossible rejecter use before Promise construction. */
function missingReject(_error: unknown): void {
  throw new Error("rejecter unavailable")
}

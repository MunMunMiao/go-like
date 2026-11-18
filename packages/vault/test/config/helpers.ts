export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

/** Creates one manually controlled Promise without type assertions. */
export function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = missingResolve
  let rejectValue: (error: unknown) => void = missingReject
  /** Captures native settlement callbacks synchronously. */
  function executor(resolve: (value: T) => void, reject: (error: unknown) => void): void {
    resolveValue = resolve
    rejectValue = reject
  }
  return { promise: new Promise<T>(executor), resolve: resolveValue, reject: rejectValue }
}

/** Rejects impossible resolver use before construction. */
function missingResolve(_value: unknown): void {
  throw new Error("resolver unavailable")
}

/** Rejects impossible rejecter use before construction. */
function missingReject(_error: unknown): void {
  throw new Error("rejecter unavailable")
}

/** Allows queued promise continuations to settle deterministically. */
export async function flush(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

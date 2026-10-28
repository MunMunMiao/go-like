export interface Deferred<T> {
  readonly promise: Promise<T>
  /** Resolves the deferred operation. */
  readonly resolve: (value: T) => void
  /** Rejects the deferred operation. */
  readonly reject: (error: unknown) => void
}

/** Creates a manually controlled Promise for lifecycle tests. */
export function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  let rejectPromise: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise })
}

/** Flushes queued Promise continuations without depending on wall-clock time. */
export async function flush(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

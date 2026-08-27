export interface Deferred<T> {
  readonly promise: Promise<T>
  /** Resolves the deferred Promise. */
  readonly resolve: (value: T) => void
  /** Rejects the deferred Promise. */
  readonly reject: (reason: unknown) => void
}

/** Creates a manually controlled Promise for concurrency tests. */
export function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  let rejectPromise: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise })
}

/** Flushes queued Promise continuations without waiting for wall-clock time. */
export async function flush(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

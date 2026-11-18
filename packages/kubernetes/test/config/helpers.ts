/** Creates one externally controlled promise for stream lifecycle tests. */
export function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolvePromise: (value: T) => void = function missingResolve(): void {
    throw new Error("deferred resolve was not initialized")
  }
  let rejectPromise: (error: unknown) => void = function missingReject(): void {
    throw new Error("deferred reject was not initialized")
  }
  const promise = new Promise<T>(function capture(resolve, reject) {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise })
}

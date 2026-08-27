export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

export async function turn(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

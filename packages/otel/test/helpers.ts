import type { OtelProviderLike } from "../src/runtime"

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

/** Creates one externally controlled Promise for shutdown interleavings. */
export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((reason: unknown) => void) | null = null
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({
    promise,
    resolve(value: T): void {
      if (resolvePromise === null) throw new Error("deferred resolve is unavailable")
      resolvePromise(value)
    },
    reject(reason: unknown): void {
      if (rejectPromise === null) throw new Error("deferred reject is unavailable")
      rejectPromise(reason)
    }
  })
}

export interface ProviderControl {
  readonly tracerProvider: OtelProviderLike
  readonly meterProvider: OtelProviderLike
  readonly traceShutdown: Deferred<void>
  readonly metricShutdown: Deferred<void>
  readonly calls: { trace: number; metric: number }
}

/** Creates two structural native provider lifecycles with controlled shutdown. */
export function providerControl(): ProviderControl {
  const traceShutdown = deferred<void>()
  const metricShutdown = deferred<void>()
  const calls = { trace: 0, metric: 0 }
  const tracerProvider: OtelProviderLike = {
    /** Returns the controlled trace shutdown Promise. */
    shutdown(): Promise<void> {
      calls.trace += 1
      return traceShutdown.promise
    }
  }
  const meterProvider: OtelProviderLike = {
    /** Returns the controlled metric shutdown Promise. */
    shutdown(): Promise<void> {
      calls.metric += 1
      return metricShutdown.promise
    }
  }
  return Object.freeze({
    tracerProvider,
    meterProvider,
    traceShutdown,
    metricShutdown,
    calls
  })
}

/** Allows queued Promise and timer reactions to run. */
export async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Reports whether one operation settles within a test-only bound. */
export async function settlesWithin(operation: Promise<unknown>, timeoutMs = 20): Promise<boolean> {
  return await Promise.race([
    operation.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) =>
      setTimeout(() => {
        resolve(false)
      }, timeoutMs)
    )
  ])
}

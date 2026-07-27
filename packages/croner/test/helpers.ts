import { Cron, type CronCallback, type CronOptions } from "croner"

export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

/** Creates a manually controlled Promise for lifecycle race tests. */
export function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = missingResolve
  let rejectValue: (error: unknown) => void = missingReject
  /** Captures the Promise settlement callbacks synchronously. */
  function executor(resolve: (value: T) => void, reject: (error: unknown) => void): void {
    resolveValue = resolve
    rejectValue = reject
  }
  const promise = new Promise<T>(executor)
  return { promise, resolve: resolveValue, reject: rejectValue }
}

/** Rejects impossible use before a Deferred captures its resolver. */
function missingResolve(_value: unknown): void {
  throw new Error("deferred resolver is unavailable")
}

/** Rejects impossible use before a Deferred captures its rejecter. */
function missingReject(_error: unknown): void {
  throw new Error("deferred rejecter is unavailable")
}

/** Creates one real Croner job whose lifecycle has not started accepting callbacks. */
export function pausedCron<T = undefined>(
  callback: CronCallback<T>,
  options: CronOptions<T> = {}
): Cron<T> {
  options.paused = true
  return new Cron<T>("0 0 0 1 1 * 2099", options, callback)
}

/** Resolves after a real timer turn. */
export function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(function schedule(resolve) {
    setTimeout(resolve, milliseconds)
  })
}

/** Polls a native state until it succeeds or its explicit deadline expires. */
export async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout")
    await delay(10)
  }
}

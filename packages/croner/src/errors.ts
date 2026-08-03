/** Preserves native Error identity and normalizes only out-of-contract thrown values. */
export function normalizeError(value: unknown, boundary: string): Error {
  if (value instanceof Error) return value
  return Object.freeze(new Error(`${boundary} threw a non-Error value`, { cause: value }))
}

/** Creates the immutable one-shot lifecycle error for a consumed Server. */
export function newAlreadyStartedError(): Error {
  const error = new Error("cron server has already started")
  error.name = "CronerAlreadyStartedError"
  return Object.freeze(error)
}

/** Creates one immutable native factory contract violation. */
export function newFactoryContractError(message: string): TypeError {
  return Object.freeze(new TypeError(message))
}

/** Keeps the startup failure first while retaining reverse-order rollback failures. */
export function combineStartupErrors(primary: Error, cleanup: readonly Error[]): Error {
  if (cleanup.length === 0) return primary
  const failures: Error[] = [primary]
  for (const failure of cleanup) failures.push(failure)
  return new AggregateError(failures, "cron server startup and rollback failed", { cause: primary })
}

/** Returns the exact native stop failure or an ordered aggregate when several fail. */
export function combineStopErrors(failures: readonly Error[]): Error | null {
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  const copied: Error[] = []
  for (const failure of failures) copied.push(failure)
  return new AggregateError(copied, "cron server stop failed", { cause: first })
}

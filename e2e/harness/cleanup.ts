import { errorValue } from "./result"

export interface CleanupFailure {
  readonly label: string
  readonly error: Error
}

/** Runs one cleanup exactly once and appends failures without interrupting later cleanup. */
export async function collectCleanupFailure(
  failures: CleanupFailure[],
  label: string,
  cleanup: () => void | Promise<void>
): Promise<void> {
  try {
    await cleanup()
  } catch (error) {
    failures.push(
      Object.freeze({
        label,
        error: errorValue(error, `${label} failed`)
      })
    )
  }
}

/** Throws primary first, followed by cleanup failures in their execution order. */
export function finalizeWithCleanup(
  primary: unknown | null,
  cleanupFailures: readonly CleanupFailure[],
  message: string
): void {
  const primaryError = primary === null ? null : errorValue(primary, "primary operation failed")
  if (primaryError === null && cleanupFailures.length === 0) return
  if (primaryError !== null && cleanupFailures.length === 0) throw primaryError
  if (primaryError === null && cleanupFailures.length === 1) {
    const onlyFailure = cleanupFailures[0]
    if (onlyFailure !== undefined) throw onlyFailure.error
  }
  const failures = cleanupFailures.map((failure) => failure.error)
  if (primaryError !== null) failures.unshift(primaryError)
  throw new AggregateError(failures, message)
}

export type FailureCategory =
  | "primary"
  | "signal"
  | "timeout"
  | "process-cleanup"
  | "stream-drain"
  | "docker"
  | "filesystem"
  | "security"
  | "prerequisite"

export interface FailureRecord {
  readonly code: string
  readonly category: FailureCategory
  readonly summary: string
}

export const ProcessTerminationReserveMs = 7_000
export const DockerCleanupReserveMs = 45_000

/** Preserves Error identity and retains non-Error values as causes. */
export function errorValue(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage, { cause: value })
}

/** Creates one immutable, already-sanitized failure record for a durable boundary. */
export function failureRecord(
  code: string,
  category: FailureCategory,
  summary: string
): FailureRecord {
  return Object.freeze({ code, category, summary })
}

/** Returns one timeout that fits before a shared owner deadline and cleanup reserve. */
export function availableTimeout(
  deadline: number,
  reserveMs: number,
  maximumMs: number,
  label: string,
  monotonicNow: () => number = () => performance.now()
): number {
  const available = Math.floor(deadline - monotonicNow()) - reserveMs
  if (available < 1) {
    throw new Error(`${label} has no time remaining inside the suite owner deadline`)
  }
  return Math.min(maximumMs, available)
}

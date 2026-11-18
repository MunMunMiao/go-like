import type { Schedule } from "./types"

/**
 * Epoch-aligned interval. `10000` is due at :00, :10, :20, and so on.
 * `intervalMs` must be a positive safe integer.
 */
export function newIntervalSchedule(intervalMs: number): Schedule {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError("intervalMs must be a positive safe integer")
  }
  return Object.freeze({
    /** Returns the next epoch-aligned boundary strictly after `afterMs`. */
    next(afterMs: number): number | null {
      if (!Number.isSafeInteger(afterMs) || afterMs < 0) {
        throw new RangeError("afterMs must be a non-negative safe integer")
      }
      const due = (Math.floor(afterMs / intervalMs) + 1) * intervalMs
      if (!Number.isSafeInteger(due)) {
        throw new RangeError("interval schedule cannot represent the next due time")
      }
      return due
    },
    /** Returns the schedule system name. */
    string(): "interval" {
      return "interval"
    }
  })
}

/**
 * Croner schedule plug.
 * Computes cron due times and does not start a native timer or own a run.
 * Pass the result to `newScheduleServer`.
 */
import type { Schedule } from "@go-like/core/job"
import { Cron, type CronOptions } from "croner"

/**
 * Croner options that change the timetable.
 * Runtime options such as paused, catch, protect, and maxRuns belong to the schedule server.
 */
export type CronerScheduleOptions = Pick<
  CronOptions,
  "timezone" | "utcOffset" | "domAndDow" | "dayOffset" | "mode" | "startAt" | "stopAt"
>

const allowed: ReadonlySet<string> = new Set([
  "timezone",
  "utcOffset",
  "domAndDow",
  "dayOffset",
  "mode",
  "startAt",
  "stopAt"
])

/**
 * Creates a pure Croner `Schedule`. `string()` is `"croner"`.
 * The pattern, time zone, and daylight-saving behavior stay Croner's.
 * No callback is passed, so Croner does not schedule (`isRunning()` stays false).
 */
export function newCronerSchedule(pattern: string, options: CronerScheduleOptions = {}): Schedule {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new TypeError("cron pattern must be a non-empty string")
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("cron schedule options must be an object")
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`cron schedule option ${key} is owned by the go-like schedule server`)
    }
  }
  const timetable = new Cron(pattern, { ...options })
  return Object.freeze({
    /** Returns the next due instant strictly after `afterMs`, or null when the timetable is exhausted. */
    next(afterMs: number): number | null {
      if (!Number.isSafeInteger(afterMs) || afterMs < 0) {
        throw new RangeError("afterMs must be a non-negative safe integer")
      }
      const due = timetable.nextRun(new Date(afterMs))
      return due === null ? null : due.getTime()
    },
    /** Returns the stable provider name. */
    string(): "croner" {
      return "croner"
    }
  })
}

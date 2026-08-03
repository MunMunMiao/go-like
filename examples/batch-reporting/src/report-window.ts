const DayMilliseconds = 86_400_000

export interface ReportWindow {
  readonly startMs: number
  readonly endMs: number
  readonly id: string
}

export interface ReportJob {
  readonly window: ReportWindow
}

/** Creates one canonical UTC daily reporting window. */
export function reportWindow(startMs: number): ReportWindow {
  if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs % DayMilliseconds !== 0) {
    throw new RangeError("report window start must be a non-negative UTC day boundary")
  }
  const endMs = startMs + DayMilliseconds
  const id = new Date(startMs)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".000", "")
  return Object.freeze({ startMs, endMs, id })
}

/** Returns the latest UTC day that is fully closed at the supplied time. */
export function latestClosedWindow(nowMs: number): ReportWindow {
  if (!Number.isFinite(nowMs) || nowMs < DayMilliseconds) {
    throw new RangeError("current time must include at least one closed UTC day")
  }
  return reportWindow(Math.floor(nowMs / DayMilliseconds) * DayMilliseconds - DayMilliseconds)
}

/** Selects the next sequential window without advancing beyond the latest closed day. */
export function nextClosedWindow(
  checkpoint: number | null,
  initialStartMs: number,
  nowMs: number
): ReportWindow | null {
  const initial = reportWindow(initialStartMs)
  const latest = latestClosedWindow(nowMs)
  const candidate = checkpoint === null ? initial.startMs : checkpoint + DayMilliseconds
  return candidate <= latest.startMs ? reportWindow(candidate) : null
}

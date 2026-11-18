import type { Context } from "../context/index"
import type { JobQueue, Schedule } from "./types"

/** Payload used by the queue conformance suite. */
export interface JobConformancePayload {
  readonly n: number
}

/** Supplies a fresh started queue to the queue suites. */
export interface JobQueueConformanceSubject {
  /** A fresh, admitted queue on isolated backend state. */
  newQueue(ctx: Context): Promise<JobQueue<JobConformancePayload>>
  /** Stops and removes what newQueue created. */
  close(ctx: Context): Promise<void>
  /** Bounds every wait. Default 10,000 ms. */
  readonly timeoutMs?: number
}

/** Supplies the queue and/or timetable covered by the telemetry suite. */
export interface JobTelemetrySubject {
  readonly queue?: JobQueueConformanceSubject
  readonly schedule?: Schedule
}

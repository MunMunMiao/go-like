/**
 * Background jobs.
 * `Schedule` is a pure timetable. `newScheduleServer` owns timers, overlap, and drain.
 * `JobQueue` is the durable-work socket. Plugs call the provider kit for every run and enqueue.
 */
export type {
  EnqueueOptions,
  EnqueuedJob,
  Job,
  JobBackoff,
  JobDrainTimeoutError,
  JobHandler,
  JobHandlers,
  JobPermanentError,
  JobQueue,
  JobRunnerState,
  JobStateError,
  JobUnknownNameError,
  JobWorkerOptions,
  Schedule,
  ScheduleServer,
  ScheduleServerOptions,
  Tick,
  TickHandler
} from "./types"

export { newPermanentJobError } from "./errors"
export { newIntervalSchedule } from "./interval"
export { newScheduleServer } from "./schedule"

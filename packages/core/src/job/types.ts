import type { Server } from "../lifecycle/index"
import type { Context } from "../context/index"

/** Pure timetable. It calculates due times and owns no timer, I/O, or callback. */
export interface Schedule {
  /** First due time strictly after `afterMs`, or null when the timetable is exhausted. */
  next(afterMs: number): number | null
  /** Stable diagnostic name. Becomes `go_like.job.system` of schedule runs. */
  string(): string
}

/** One schedule run. */
export interface Tick {
  /** Code-defined job name passed to `newScheduleServer`. */
  readonly name: string
  /** Due time this run serves. For `trigger`, the time of the call. */
  readonly scheduledAt: number
  /** True when the run came from `trigger`. */
  readonly manual: boolean
}

/** Handler invoked once per due run. A throw fails that run and the schedule continues. */
export type TickHandler = (ctx: Context, tick: Tick) => void | Promise<void>

/** Options for `newScheduleServer`. */
export interface ScheduleServerOptions {
  /** Graceful wait for the active run before its context is canceled. Default 25000. */
  readonly drainTimeoutMs?: number
}

/** One-shot server that runs a schedule without overlapping itself. */
export interface ScheduleServer extends Server {
  /** Runs the handler once after any active run, and settles with that run's outcome. */
  trigger(ctx: Context): Promise<void>
}

/** Delay before attempt k (k >= 2). Fixed is `delayMs`. Exponential is `delayMs * 2^(k-2)`. */
export interface JobBackoff {
  readonly type: "fixed" | "exponential"
  readonly delayMs: number
}

/** Per-job enqueue options. The retry policy travels with the job. */
export interface EnqueueOptions {
  /** Idempotency key. A matching unfinished job creates no second job. */
  readonly id?: string
  /** Total attempts including the first. Default 1. */
  readonly attempts?: number
  /** Delay between attempts. Default `{ type: "fixed", delayMs: 0 }`. */
  readonly backoff?: JobBackoff
}

/** Result of one enqueue. */
export interface EnqueuedJob {
  /** Caller id when given, including a deduplicated enqueue. Otherwise the provider id. */
  readonly id: string
}

/** One run of a queued job. */
export interface Job<T> {
  readonly queue: string
  readonly name: string
  readonly id: string
  /** 1-based attempt number of this run. */
  readonly attempt: number
  /** Payload after the provider's JSON round trip. */
  readonly payload: T
}

/** Returning succeeds the attempt. Throwing fails it. `newPermanentJobError` is not retried. */
export type JobHandler<T> = (ctx: Context, job: Job<T>) => unknown

/** Handlers keyed by code-defined job name. A missing name fails without retry. */
export type JobHandlers<T> = Readonly<Record<string, JobHandler<T>>>

/** Options for `JobQueue.worker`. */
export interface JobWorkerOptions {
  /** Maximum concurrent runs. Default 1. */
  readonly concurrency?: number
  /** Graceful wait for active runs before their context is canceled. Default 25000. */
  readonly drainTimeoutMs?: number
}

/** Named work queue. Delivery is at least once and the retry policy travels with each job. */
export interface JobQueue<T> {
  /** Code-defined queue name (`go_like.job.queue`). */
  readonly name: string
  /** Enqueues one job after validating. Deduplicates by id while an unfinished job holds it. */
  enqueue(ctx: Context, name: string, payload: T, options?: EnqueueOptions): Promise<EnqueuedJob>
  /** One-shot server that runs handlers for this queue. */
  worker(handlers: JobHandlers<T>, options?: JobWorkerOptions): Server
  /** Stable provider diagnostic name. Becomes `go_like.job.system`. */
  string(): string
}

/** Lifecycle state of a schedule server, queue, or worker. */
export type JobRunnerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

/** The current state does not allow the operation. */
export interface JobStateError extends Error {
  readonly name: "JobStateError"
  readonly code: "GO_LIKE_JOB_STATE"
  readonly operation: string
  readonly state: JobRunnerState
}

/** The owner drain exceeded `drainTimeoutMs`. Active runs are canceled and still awaited. */
export interface JobDrainTimeoutError extends Error {
  readonly name: "JobDrainTimeoutError"
  readonly code: "GO_LIKE_JOB_DRAIN_TIMEOUT"
  /** Queue name or schedule job name. */
  readonly runner: string
  readonly timeoutMs: number
}

/** The delivered job name has no handler. The job fails without retry. */
export interface JobUnknownNameError extends Error {
  readonly name: "JobUnknownNameError"
  readonly code: "GO_LIKE_JOB_UNKNOWN_NAME"
  readonly queue: string
  readonly jobName: string
}

/** The handler declared a permanent failure. Remaining attempts are not used. */
export interface JobPermanentError extends Error {
  readonly name: "JobPermanentError"
  readonly code: "GO_LIKE_JOB_PERMANENT"
  readonly cause: unknown
}

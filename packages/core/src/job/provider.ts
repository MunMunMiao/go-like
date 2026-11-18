import { withCancel, type Context } from "../context/index"
import { beginUnit, injectRecord } from "../telemetry/provider"
import { newJobUnknownNameError } from "./errors"
import { resolveEnqueueOptions, resolveWorkerOptions, snapshotHandlers } from "./names"
import type { ResolvedEnqueueOptions, ResolvedJobWorkerOptions } from "./provider-types"
import type { EnqueueOptions, Job, JobHandlers, JobWorkerOptions } from "./types"

/** Describes one job run for `runJob`. */
export interface JobRunInfo {
  readonly system: string
  readonly name: string
  readonly trigger: "schedule" | "queue"
  readonly id: string | null
  readonly attempt: number
  readonly metadata: Readonly<Record<string, string>> | null
}

/** Describes one enqueue for the `enqueue` kit. */
export interface JobEnqueueInfo {
  readonly system: string
  readonly name: string
  readonly queue: string
}

export type { ResolvedEnqueueOptions, ResolvedJobWorkerOptions } from "./provider-types"

/**
 * Runs one job body in a fresh child of `runnerCtx` and a `job.run` unit.
 * Schedule runs are roots. Queue runs take their parent from `metadata` when it carries one.
 */
export async function runJob<T>(
  runnerCtx: Context,
  info: JobRunInfo,
  body: (ctx: Context) => Promise<T>
): Promise<T> {
  const [runCtx, cancel] = withCancel(runnerCtx)
  const unit = beginUnit(
    runCtx,
    {
      kind: "job.run",
      system: info.system,
      name: info.name,
      trigger: info.trigger,
      id: info.id,
      attempt: info.attempt
    },
    info.trigger === "queue" ? info.metadata : null
  )
  try {
    const result = await unit.run((ctx) => body(ctx))
    unit.end()
    return result
  } catch (error) {
    unit.end({ error })
    throw error
  } finally {
    cancel()
  }
}

/**
 * Runs `send` inside a `job.enqueue` unit.
 * `metadata` is a frozen carrier the provider must store with the job.
 */
export async function enqueue<Result>(
  ctx: Context,
  info: JobEnqueueInfo,
  send: (ctx: Context, metadata: Readonly<Record<string, string>>) => Promise<Result>
): Promise<Result> {
  const unit = beginUnit(ctx, {
    kind: "job.enqueue",
    system: info.system,
    name: info.name,
    queue: info.queue
  })
  try {
    const result = await unit.run((unitCtx) => send(unitCtx, injectRecord(unitCtx, {})))
    unit.end()
    return result
  } catch (error) {
    unit.end({ error })
    throw error
  }
}

/** Validates enqueue options before any I/O. */
export function enqueueOptions(options?: EnqueueOptions): ResolvedEnqueueOptions {
  return resolveEnqueueOptions(options)
}

/** Validates worker options before any I/O. */
export function jobWorkerOptions(options?: JobWorkerOptions): ResolvedJobWorkerOptions {
  return resolveWorkerOptions(options)
}

/** Validates and snapshots a handler table. Lookup uses own properties only. */
export function jobHandlers<T>(handlers: JobHandlers<T>): JobHandlers<T> {
  return snapshotHandlers(handlers)
}

/**
 * Runs a delivered job through `runJob`.
 * An unknown name is recorded as `_OTHER` and rejected with `JobUnknownNameError`.
 */
export async function dispatchJob<T>(
  runnerCtx: Context,
  system: string,
  handlers: JobHandlers<T>,
  job: Job<T>,
  metadata: Readonly<Record<string, string>> | null
): Promise<unknown> {
  const known = Object.hasOwn(handlers, job.name)
  const handler = known ? handlers[job.name] : undefined
  return await runJob(
    runnerCtx,
    {
      system,
      name: known ? job.name : "_OTHER",
      trigger: "queue",
      id: job.id,
      attempt: job.attempt,
      metadata
    },
    async (ctx) => {
      if (handler === undefined) throw newJobUnknownNameError(job.queue, job.name)
      return await handler(ctx, job)
    }
  )
}

export { newJobDrainTimeoutError, newJobStateError } from "./errors"

import {
  cause,
  waitForContext,
  withCancelCause,
  withoutCancel,
  type Context
} from "../context/index"
import type { Server } from "../lifecycle/index"
import { isTerminalJobError, newJobDrainTimeoutError, newJobStateError } from "./errors"
import { jobName, jsonPayload, queueName, resolveEnqueueOptions, retryDelay } from "./names"
import { dispatchJob, enqueue as enqueueJob, jobHandlers, jobWorkerOptions } from "./provider"
import type { JobBackoff, JobHandlers, JobQueue, JobRunnerState, JobWorkerOptions } from "./types"

/** Process-local reference queue. It is not a package export. */
export interface MemoryJobQueue<T> extends JobQueue<T> {
  string(): "memory"
}

interface StoredJob<T> {
  readonly id: string
  readonly name: string
  readonly payload: T
  readonly attempts: number
  attempt: number
  readonly backoff: JobBackoff
  readonly metadata: Readonly<Record<string, string>>
  due: number
  phase: "waiting" | "delayed" | "active" | "done"
  readonly seq: number
}

const maximumTimerMs = 2_147_483_647

/** Returns the caller's cancellation cause when the context is already terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Creates one non-durable in-process queue. Backoff timers exist only while a worker is running. */
export function newMemoryJobQueue<T>(name: string): MemoryJobQueue<T> {
  const queue = queueName(name)
  const jobs = new Map<string, StoredJob<T>>()
  const pumps = new Set<() => void>()
  let sequence = 0
  let identity = 0

  /** Wakes every running worker. Taking a job is synchronous, so two workers cannot take the same one. */
  function wake(): void {
    for (const pump of pumps) pump()
  }

  /** Claims the earliest due unfinished job that is ready now. */
  function claim(now: number): StoredJob<T> | null {
    let best: StoredJob<T> | null = null
    for (const job of jobs.values()) {
      if (job.phase !== "waiting" && job.phase !== "delayed") continue
      if (job.due > now) continue
      if (best === null || job.due < best.due || (job.due === best.due && job.seq < best.seq)) {
        best = job
      }
    }
    if (best === null) return null
    best.phase = "active"
    best.attempt += 1
    return best
  }

  return Object.freeze({
    name: queue,
    /** Validates, then records one `enqueue` unit around the in-memory insert. */
    async enqueue(
      ctx: Context,
      job: string,
      payload: T,
      options?: Parameters<JobQueue<T>["enqueue"]>[3]
    ): Promise<{ readonly id: string }> {
      const failure = contextFailure(ctx)
      if (failure !== null) throw failure
      const selected = jobName(job)
      const body = jsonPayload(payload)
      const resolved = resolveEnqueueOptions(options)
      return enqueueJob(
        ctx,
        { system: "memory", name: selected, queue },
        async (_unitCtx, metadata) => {
          if (resolved.id !== null) {
            const existing = jobs.get(resolved.id)
            if (existing !== undefined && existing.phase !== "done") return { id: existing.id }
          }
          let id = resolved.id
          if (id === null) {
            do {
              identity += 1
              id = `memory:${identity}`
            } while (jobs.has(id))
          }
          jobs.set(id, {
            id,
            name: selected,
            payload: body,
            attempts: resolved.attempts,
            attempt: 0,
            backoff: resolved.backoff,
            metadata,
            due: Date.now(),
            phase: "waiting",
            seq: ++sequence
          })
          wake()
          return { id }
        }
      )
    },
    /** Builds a one-shot worker. Handler and option checks happen before `start`. */
    worker(handlers: JobHandlers<T>, options?: JobWorkerOptions): Server {
      const table = jobHandlers(handlers)
      const resolved = jobWorkerOptions(options)
      let state: JobRunnerState = "idle"
      let slots = 0
      let timer: ReturnType<typeof setTimeout> | null = null
      let runnerCtx: Context | null = null
      let cancelRunner: ((cause: Error | null) => void) | null = null
      let ownerStop: Promise<void> | null = null
      let drainError: Error | null = null
      const active = new Set<Promise<void>>()
      let settleStart: ((error: Error | null) => void) | null = null
      const runtime = new Promise<void>((resolve, reject) => {
        settleStart = (error) => {
          settleStart = null
          if (error === null) resolve()
          else reject(error)
        }
      })
      void runtime.catch(() => {})

      /** Settles `start` once. */
      function settle(error: Error | null): void {
        settleStart?.(error)
      }

      /** Drops this worker's backoff timer. */
      function clearTimer(): void {
        if (timer === null) return
        clearTimeout(timer)
        timer = null
      }

      /** Arms the soonest future due time owned by this running worker. */
      function arm(): void {
        clearTimer()
        if (state !== "running" || slots >= resolved.concurrency) return
        const now = Date.now()
        let next: number | null = null
        for (const job of jobs.values()) {
          if (job.phase !== "waiting" && job.phase !== "delayed") continue
          if (job.due <= now) continue
          if (next === null || job.due < next) next = job.due
        }
        if (next === null) return
        const wait = Math.min(Math.max(0, next - Date.now()), maximumTimerMs)
        timer = setTimeout(() => {
          timer = null
          pump()
        }, wait)
      }

      /** Settles start once no run remains after stop. */
      function finishStopped(): void {
        if (slots > 0 || state !== "stopping") return
        state = "stopped"
        pumps.delete(pump)
        clearTimer()
        settle(drainError)
      }

      /** Runs one claimed job, then retries, completes, or frees its id. */
      function execute(stored: StoredJob<T>): Promise<void> {
        let release!: () => void
        const run = new Promise<void>((resolve) => {
          release = resolve
        })
        active.add(run)
        const task = (async () => {
          if (runnerCtx === null) return
          try {
            await dispatchJob(
              runnerCtx,
              "memory",
              table,
              {
                queue,
                name: stored.name,
                id: stored.id,
                attempt: stored.attempt,
                payload: stored.payload
              },
              stored.metadata
            )
            stored.phase = "done"
          } catch (error) {
            if (isTerminalJobError(error) || stored.attempt >= stored.attempts) {
              stored.phase = "done"
            } else {
              stored.phase = "delayed"
              stored.due = Date.now() + retryDelay(stored.backoff, stored.attempt + 1)
              wake()
            }
          }
        })()
        void task.finally(() => {
          release()
          active.delete(run)
          slots -= 1
          if (state === "running") pump()
          else if (state === "stopping") finishStopped()
        })
        return run
      }

      /** Waits for every run that has been started, including one started after the first snapshot. */
      function whenActive(): Promise<void> {
        const pending = [...active]
        if (pending.length === 0) return Promise.resolve()
        return Promise.all(pending).then(() => whenActive())
      }

      /** Fills free slots from ready jobs. Stop during a handler must not dispatch the next one. */
      function pump(): void {
        while (state === "running" && slots < resolved.concurrency) {
          const job = claim(Date.now())
          if (job === null) {
            arm()
            return
          }
          slots += 1
          void execute(job)
        }
        if (state === "running") clearTimer()
      }

      /** Starts or joins the owner drain. */
      function beginStop(): Promise<void> {
        if (ownerStop !== null) return ownerStop
        pumps.delete(pump)
        clearTimer()
        if (state === "idle") {
          state = "stopped"
          settle(null)
          ownerStop = Promise.resolve()
          return ownerStop
        }
        if (state === "failed" || state === "stopped") {
          const settled = (): undefined => undefined
          ownerStop = runtime.then(settled, settled)
          return ownerStop
        }
        state = "stopping"
        if (slots === 0) {
          state = "stopped"
          settle(null)
          ownerStop = Promise.resolve()
          return ownerStop
        }
        const timeoutError = newJobDrainTimeoutError(queue, resolved.drainTimeoutMs)
        const running = whenActive()
        let timerId: ReturnType<typeof setTimeout> | null = null
        const timed = new Promise<never>((_resolve, reject) => {
          timerId = setTimeout(() => {
            drainError = timeoutError
            cancelRunner?.(timeoutError)
            reject(timeoutError)
          }, resolved.drainTimeoutMs)
        })
        const finished = running.finally(() => {
          if (timerId !== null) clearTimeout(timerId)
        })
        ownerStop = Promise.race([finished.then(() => undefined), timed])
        void ownerStop.catch(() => {})
        void finished.then(() => {
          finishStopped()
        })
        return ownerStop
      }

      return Object.freeze({
        /** Runs until stop. A second call is rejected. */
        start(ctx: Context): Promise<void> {
          if (state !== "idle") return Promise.reject(newJobStateError("start", state))
          const failure = contextFailure(ctx)
          if (failure !== null) {
            state = "failed"
            settle(failure)
            return runtime
          }
          state = "running"
          const [runner, cancel] = withCancelCause(withoutCancel(ctx))
          runnerCtx = runner
          cancelRunner = cancel
          pumps.add(pump)
          pump()
          return runtime
        },
        /** Drains active runs. This caller's context bounds only its wait. */
        stop(ctx: Context): Promise<void> {
          return waitForContext(ctx, beginStop())
        }
      })
    },
    /** Returns the in-memory system name. */
    string(): "memory" {
      return "memory"
    }
  })
}

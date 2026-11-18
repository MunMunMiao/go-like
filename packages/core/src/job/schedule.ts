import {
  cause,
  waitForContext,
  withCancelCause,
  withoutCancel,
  type Context
} from "../context/index"
import { toError } from "../internal/errors"
import { newJobDrainTimeoutError, newJobStateError } from "./errors"
import { drainTimeout, jobName } from "./names"
import { runJob } from "./provider"
import type {
  JobRunnerState,
  Schedule,
  ScheduleServer,
  ScheduleServerOptions,
  Tick,
  TickHandler
} from "./types"

const maximumTimerMs = 2_147_483_647

interface ManualRun {
  readonly tick: Tick
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

/** Returns the caller's cancellation cause when the context is already terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Reads a due time and rejects a corrupt timetable. Null means the schedule is exhausted. */
function readDue(schedule: Schedule, afterMs: number): number | null {
  let due: number | null
  try {
    due = schedule.next(afterMs)
  } catch (error) {
    throw toError(error, "schedule next failed")
  }
  if (due === null) return null
  if (!Number.isSafeInteger(due) || due <= afterMs) {
    throw new Error("schedule returned an illegal due time")
  }
  return due
}

/**
 * Runs `handler` on `schedule` without overlap.
 * A due time that arrives during a run is skipped. The next due time is calculated from now.
 * `start` stays pending until stop finishes, and until the active run settles after a drain timeout.
 */
export function newScheduleServer(
  schedule: Schedule,
  name: string,
  handler: TickHandler,
  options?: ScheduleServerOptions
): ScheduleServer {
  if (typeof schedule !== "object" || schedule === null) {
    throw new TypeError("schedule must be an object")
  }
  if (typeof schedule.next !== "function" || typeof schedule.string !== "function") {
    throw new TypeError("schedule next and string must be callable")
  }
  const job = jobName(name)
  if (typeof handler !== "function") throw new TypeError("schedule handler must be a function")
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new TypeError("schedule server options must be an object")
  }
  const timeoutMs = drainTimeout(options?.drainTimeoutMs)
  const system = schedule.string()
  if (typeof system !== "string" || system.length === 0 || !system.isWellFormed()) {
    throw new TypeError("schedule string() must return a non-empty well-formed string")
  }

  let state: JobRunnerState = "idle"
  let busy = false
  let active: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let runnerCtx: Context | null = null
  let cancelRunner: ((cause: Error | null) => void) | null = null
  let ownerStop: Promise<void> | null = null
  let drainError: Error | null = null
  let terminalError: Error | null = null
  const manuals: ManualRun[] = []
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

  /** Drops the armed timer. */
  function clearTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  /** Rejects manual runs that have not started. */
  function rejectManuals(error: Error): void {
    const pending = manuals.splice(0)
    for (const manual of pending) manual.reject(error)
  }

  /** Fails the server because the timetable itself is unusable. */
  function fail(error: Error): void {
    if (state === "failed" || state === "stopped") return
    state = "failed"
    terminalError = error
    clearTimer()
    rejectManuals(error)
    cancelRunner?.(error)
    if (!busy) settle(error)
  }

  /** Arms a timer for `due`, chaining any delay past the platform maximum. */
  function arm(due: number): void {
    clearTimer()
    if (state !== "running") return
    const delay = Math.max(0, due - Date.now())
    const wait = Math.min(delay, maximumTimerMs)
    timer = setTimeout(() => {
      timer = null
      if (state !== "running") return
      if (Date.now() < due) {
        arm(due)
        return
      }
      onDue(due)
    }, wait)
  }

  /** Calculates the next due time from `afterMs` and arms it. */
  function armNext(afterMs: number): void {
    if (state !== "running") return
    try {
      const due = readDue(schedule, afterMs)
      if (due !== null) arm(due)
    } catch (error) {
      fail(toError(error, "schedule next failed"))
    }
  }

  /** Starts one run. Scheduled failures do not stop the server. Manual runs settle their caller. */
  function begin(tick: Tick, manual: ManualRun | null): void {
    if (runnerCtx === null) return
    clearTimer()
    busy = true
    let release!: () => void
    const execution = new Promise<void>((resolve) => {
      release = resolve
    })
    active = execution
    armNext(Date.now())
    if (state !== "running") {
      busy = false
      active = null
      release()
      if (manual !== null) manual.reject(terminalError ?? newJobStateError("trigger", state))
      if (terminalError !== null) settle(terminalError)
      return
    }
    const finished = runJob(
      runnerCtx,
      {
        system,
        name: job,
        trigger: "schedule",
        id: null,
        attempt: 1,
        metadata: null
      },
      async (ctx) => {
        await handler(ctx, tick)
      }
    ).then(
      () => {
        manual?.resolve()
      },
      (error: unknown) => {
        if (manual !== null) manual.reject(error)
      }
    )
    void finished.finally(() => {
      release()
      busy = false
      active = null
      if (state === "running") pump()
      else if (state === "stopping") finishStopped()
      else if (terminalError !== null) {
        settle(
          drainError === null
            ? terminalError
            : new AggregateError([terminalError, drainError], terminalError.message)
        )
      }
    })
  }

  /** Starts the next manual run, or arms the next scheduled due time. */
  function pump(): void {
    if (busy || state !== "running") return
    const manual = manuals.shift()
    if (manual !== undefined) {
      begin(manual.tick, manual)
      return
    }
    armNext(Date.now())
  }

  /** A scheduled due time arrived. A busy runner skips it and recalculates from now. */
  function onDue(due: number): void {
    if (state !== "running") return
    if (busy) {
      armNext(Date.now())
      return
    }
    begin({ name: job, scheduledAt: due, manual: false }, null)
  }

  /** Settles start after the active run when stop already began. */
  function finishStopped(): void {
    if (busy) return
    if (state !== "stopping" && state !== "stopped") return
    state = "stopped"
    settle(drainError)
  }

  /** Starts or joins the owner drain. The returned promise rejects when the drain budget expires. */
  function beginStop(): Promise<void> {
    if (ownerStop !== null) return ownerStop
    if (state === "idle") {
      state = "stopped"
      settle(null)
      ownerStop = Promise.resolve()
      return ownerStop
    }
    const failed = state === "failed"
    if (state === "stopped" || (failed && !busy)) {
      const settled = (): undefined => undefined
      ownerStop = (active ?? Promise.resolve()).then(() => runtime.then(settled, settled))
      return ownerStop
    }
    if (!failed) {
      state = "stopping"
      clearTimer()
      rejectManuals(newJobStateError("trigger", "stopping"))
      if (!busy) {
        state = "stopped"
        settle(null)
        ownerStop = Promise.resolve()
        return ownerStop
      }
    }
    const timeoutError = newJobDrainTimeoutError(job, timeoutMs)
    const running = active ?? Promise.resolve()
    let timerId: ReturnType<typeof setTimeout> | null = null
    const timed = new Promise<never>((_resolve, reject) => {
      timerId = setTimeout(() => {
        drainError = timeoutError
        cancelRunner?.(timeoutError)
        reject(timeoutError)
      }, timeoutMs)
    })
    const finished = running.finally(() => {
      if (timerId !== null) clearTimeout(timerId)
    })
    const settled = (): undefined => undefined
    ownerStop = Promise.race([
      finished.then(() => (failed ? runtime.then(settled, settled) : undefined)),
      timed
    ])
    void ownerStop.catch(() => {})
    void finished.then(() => {
      if (!failed) finishStopped()
    })
    return ownerStop
  }

  return Object.freeze({
    /** Arms the timetable once. The returned promise stays pending until stop completes. */
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
      armNext(Date.now())
      return runtime
    },
    /** Clears the timer and drains the active run. This caller's context bounds only its wait. */
    stop(ctx: Context): Promise<void> {
      return waitForContext(ctx, beginStop())
    },
    /** Queues one manual run after the active run. The context bounds only this wait. */
    trigger(ctx: Context): Promise<void> {
      if (state !== "running") return Promise.reject(newJobStateError("trigger", state))
      const failure = contextFailure(ctx)
      if (failure !== null) return Promise.reject(failure)
      let resolveRun!: () => void
      let rejectRun!: (error: unknown) => void
      const outcome = new Promise<void>((resolve, reject) => {
        resolveRun = resolve
        rejectRun = reject
      })
      manuals.push({
        tick: { name: job, scheduledAt: Date.now(), manual: true },
        resolve: resolveRun,
        reject: rejectRun
      })
      if (!busy) pump()
      void outcome.catch(() => {})
      return waitForContext(ctx, outcome)
    }
  })
}

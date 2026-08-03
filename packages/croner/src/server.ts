import {
  background,
  canceled,
  cause,
  withCancelCause,
  type CancelCauseFunc,
  type Context
} from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"
import { Cron } from "croner"

import {
  combineStartupErrors,
  combineStopErrors,
  newAlreadyStartedError,
  newFactoryContractError,
  normalizeError
} from "./errors"
import type { CronerFactory, CronerServer } from "./types"

type LifecycleState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

/** Returns the exact cause carried by a terminal Context. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  if (failure === null) return null
  return cause(ctx)
}

/** Rejects before native startup accepts work from an already canceled caller. */
function throwIfCanceled(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Deliberately observes an internally retained rejection. */
function consumeFailure(_error: unknown): void {}

/** Adds one exact native Cron instance to the provisional ownership set. */
function addFactoryJob(
  candidate: unknown,
  index: number,
  provisional: Cron<unknown>[],
  seen: Set<Cron<unknown>>
): void {
  if (!(candidate instanceof Cron)) {
    throw newFactoryContractError(`cron factory result at index ${index} is not a native Cron`)
  }
  if (seen.has(candidate)) {
    throw newFactoryContractError(`cron factory returned duplicate native Cron at index ${index}`)
  }
  seen.add(candidate)
  provisional.push(candidate)
}

/** Snapshots a non-empty native factory result while retaining provisional jobs for rollback. */
function collectFactoryJobs(
  value: unknown,
  provisional: Cron<unknown>[]
): readonly Cron<unknown>[] {
  const seen = new Set<Cron<unknown>>()
  if (value instanceof Cron) {
    addFactoryJob(value, 0, provisional, seen)
  } else if (Array.isArray(value)) {
    if (value.length === 0)
      throw newFactoryContractError("cron factory must return at least one native Cron")
    for (let index = 0; index < value.length; index += 1) {
      addFactoryJob(value[index], index, provisional, seen)
    }
  } else {
    throw newFactoryContractError(
      "cron factory must return a native Cron or a non-empty array of native Cron instances"
    )
  }
  return Object.freeze(provisional.slice())
}

/** Requires every factory-created job to be dormant at the startup acceptance boundary. */
function validatePausedJobs(jobs: readonly Cron<unknown>[]): void {
  let index = 0
  for (const job of jobs) {
    if (job.isStopped()) {
      throw newFactoryContractError(`cron factory result at index ${index} is already stopped`)
    }
    if (job.isBusy()) {
      throw newFactoryContractError(`cron factory result at index ${index} is busy`)
    }
    if (job.options.paused !== true || job.isRunning()) {
      throw newFactoryContractError(
        `cron factory result at index ${index} must be constructed with paused: true`
      )
    }
    index += 1
  }
}

/** Resumes native jobs in order while stopping admission after synchronous reentry. */
function resumeJobs(
  jobs: readonly Cron<unknown>[],
  startupCtx: Context,
  stopRequested: () => boolean
): boolean {
  let index = 0
  for (const job of jobs) {
    const resumed = job.resume()
    if (stopRequested()) return false
    if (!resumed) {
      throw newFactoryContractError(`cron factory result at index ${index} could not resume`)
    }
    const running = job.isRunning()
    if (stopRequested()) return false
    if (!running) {
      throw newFactoryContractError(
        `cron factory result at index ${index} did not enter a running state`
      )
    }
    throwIfCanceled(startupCtx)
    if (stopRequested()) return false
    index += 1
  }
  return true
}

/** Permanently stops native jobs in reverse order and preserves every exact failure. */
function stopJobs(jobs: readonly Cron<unknown>[]): readonly Error[] {
  const failures: Error[] = []
  let index = jobs.length
  for (const job of Array.from(jobs).reverse()) {
    index -= 1
    try {
      job.stop()
    } catch (value) {
      failures.push(normalizeError(value, `native Cron stop at index ${index}`))
    }
  }
  return failures
}

/** Creates a one-shot native Croner structural Server. */
export function newCronerServer<T = undefined>(factory: CronerFactory<T>): CronerServer {
  if (typeof factory !== "function")
    throw new TypeError("cron server requires a native Cron factory")
  const capturedFactory = factory
  let state: LifecycleState = "idle"
  let jobs: readonly Cron<unknown>[] = Object.freeze([])
  let cancelRuntime: CancelCauseFunc | null = null
  let ownerStop: Promise<void> | null = null
  let settleRuntime: ((error: Error | null) => void) | null = null
  const runtime = new Promise<void>(
    /** Captures settlement for the single public running Promise. */
    function waitForRuntime(resolve, reject) {
      settleRuntime =
        /** Publishes the final runtime outcome exactly once. */
        function settle(error: Error | null): void {
          settleRuntime = null
          if (error === null) resolve()
          else reject(error)
        }
    }
  )
  void runtime.catch(consumeFailure)

  /** Settles the one public start Promise exactly once. */
  function settle(error: Error | null): void {
    settleRuntime?.(error)
  }

  /** Reads stopping across factory and native calls that may synchronously reenter the Server. */
  function stopRequested(): boolean {
    return state === "stopping"
  }

  /** Stops owned native jobs only after publishing the stable owner Promise. */
  function finishStop(ownedJobs: readonly Cron<unknown>[]): Promise<void> {
    const failures = stopJobs(ownedJobs)
    cancelRuntime?.(canceled)
    const terminalError = combineStopErrors(failures)
    state = terminalError === null ? "stopped" : "failed"
    settle(terminalError)
    return runtime
  }

  /** Starts the one shared explicit owner stop operation. */
  function beginStop(): Promise<void> {
    if (ownerStop !== null) return ownerStop
    ownerStop = runtime
    if (state === "idle") {
      state = "stopped"
      settle(null)
      return ownerStop
    }
    if (state === "starting") {
      state = "stopping"
      return ownerStop
    }

    state = "stopping"
    return finishStop(jobs)
  }

  /** Creates, validates, resumes, and accepts one native owner runtime. */
  async function startServer(startupCtx: Context): Promise<void> {
    const runtimePair: readonly [Context, CancelCauseFunc] = withCancelCause(background())
    cancelRuntime = runtimePair[1]
    const provisional: Cron<unknown>[] = []
    await Promise.resolve()
    if (state === "stopping") return finishStop(provisional)
    try {
      throwIfCanceled(startupCtx)
      if (stopRequested()) return finishStop(provisional)
      const created: unknown = capturedFactory(runtimePair[0])
      jobs = collectFactoryJobs(created, provisional)
      if (stopRequested()) return finishStop(provisional)
      validatePausedJobs(jobs)
      if (stopRequested()) return finishStop(provisional)
      throwIfCanceled(startupCtx)
      if (stopRequested()) return finishStop(provisional)
      if (!resumeJobs(jobs, startupCtx, stopRequested)) return finishStop(provisional)
    } catch (value) {
      const primary = contextFailure(startupCtx) ?? normalizeError(value, "cron factory startup")
      ownerStop ??= runtime
      const cleanup = stopJobs(provisional)
      runtimePair[1](primary)
      state = "failed"
      const failure = combineStartupErrors(primary, cleanup)
      settle(failure)
      throw failure
    }

    state = "running"
    return runtime
  }

  return Object.freeze({
    /** Consumes this structural Server on the first startup attempt. */
    start(ctx: Context): Promise<void> {
      if (state !== "idle") return Promise.reject(newAlreadyStartedError())
      state = "starting"
      return startServer(ctx)
    },
    /** Stops future native scheduling; it deliberately does not claim callback drain. */
    stop(ctx: Context): Promise<void> {
      return waitForContext(ctx, beginStop())
    }
  })
}

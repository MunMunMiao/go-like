import { waitForContext, withoutCancel, type Context } from "../context/index"
import { addFailure, isError } from "../internal/errors"
import { closedResourceFailure, resourceTerminal } from "../lifecycle/resource-server"
import type { Server } from "../lifecycle/index"
import { enterRoot } from "../telemetry/internal/instrument"
import type { Telemetry } from "../telemetry/types"

/** One resource whose start has been invoked. `owned` resources receive stop. */
export interface ResourceRun {
  readonly server: Server
  readonly index: number
  readonly start: Promise<void>
  owned: boolean
}

/** Waits directly, or through the caller Context when the phase is bounded. */
export function waitForPhase<T>(ctx: Context, operation: Promise<T>, bounded: boolean): Promise<T> {
  return bounded ? waitForContext(ctx, operation) : Promise.resolve(operation)
}

/** Preserves an Error and wraps every other boundary rejection with a stable message. */
export function boundaryError(value: unknown, operation: string): Error {
  if (isError(value)) return value
  return new Error(`${operation} rejected with a non-Error value`, { cause: value })
}

/** Invokes one server start and publishes its normalized failure at the first observation point. */
export function invokeStart(
  subject: Server,
  ctx: Context,
  index: number,
  onFailure: (error: Error) => void
): Promise<void> {
  let started: Promise<void>
  try {
    started = enterRoot(ctx, () => subject.start(ctx))
  } catch (value) {
    const error = boundaryError(value, `server[${index}] start`)
    onFailure(error)
    return Promise.reject(error)
  }
  return Promise.resolve(started).catch((value: unknown) => {
    const error = boundaryError(value, `server[${index}] start`)
    onFailure(error)
    throw error
  })
}

/** Invokes one server stop and normalizes its rejection. */
export function invokeStop(subject: Server, ctx: Context, index: number): Promise<void> {
  let stopped: Promise<void>
  try {
    stopped = subject.stop(ctx)
  } catch (value) {
    return Promise.reject(boundaryError(value, `server[${index}] stop`))
  }
  return Promise.resolve(stopped).catch((value: unknown) => {
    throw boundaryError(value, `server[${index}] stop`)
  })
}

/**
 * Launches the telemetry bundle inside a root scope.
 * The returned promise is the native terminal. Callers wait for admission separately.
 */
export function launchTelemetry(telemetry: Telemetry, telemetryContext: Context): Promise<void> {
  const running = enterRoot(telemetryContext, () => telemetry.start(telemetryContext))
  void running.catch(() => {})
  return running
}

/**
 * Stops the telemetry bundle on its own budget and then joins its terminal promise.
 * `timeout` is null when the budget is unlimited.
 */
export async function stopTelemetry(
  telemetry: Telemetry,
  terminal: Promise<void> | null,
  budget: Context,
  bounded: boolean,
  errors: Error[]
): Promise<void> {
  try {
    await waitForPhase(budget, telemetry.stop(budget), bounded)
  } catch (value) {
    addFailure(errors, boundaryError(value, "telemetry stop"))
  }
  if (terminal === null) return
  try {
    await waitForPhase(budget, terminal, bounded)
  } catch (value) {
    addFailure(errors, boundaryError(value, "telemetry terminal join"))
  }
}

/**
 * Admits resources in order. A rejected start is not owned.
 * A start that is still pending when the wait ends stays owned and will be stopped.
 */
export async function admitResources(
  resources: readonly Server[],
  resourceContext: Context,
  startContext: Context,
  stopRequested: () => boolean,
  runs: ResourceRun[]
): Promise<void> {
  for (let index = 0; index < resources.length; index += 1) {
    if (stopRequested()) break
    const subject = resources[index]
    if (subject === undefined) continue
    const started = invokeResourceStart(subject, resourceContext, index)
    const run: ResourceRun = { server: subject, index, start: started, owned: true }
    runs.push(run)
    try {
      await waitForContext(startContext, started)
    } catch (value) {
      const rejected = await rejectedStart(started)
      if (rejected) run.owned = false
      throw boundaryError(value, `resource[${index}] start`)
    }
  }
}

/** Stops owned resources in reverse order. A stop failure is recorded and the next resource still stops. */
export async function stopResources(
  runs: readonly ResourceRun[],
  stopContext: Context,
  bounded: boolean,
  errors: Error[]
): Promise<void> {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (run === undefined || !run.owned) continue
    try {
      await waitForPhase(
        stopContext,
        invokeResourceStop(run.server, stopContext, run.index),
        bounded
      )
    } catch (value) {
      addFailure(errors, boundaryError(value, `resource[${run.index}] stop`))
    }
  }
}

/** Invokes resource start inside a root scope. The rejection is normalized once. */
function invokeResourceStart(subject: Server, ctx: Context, index: number): Promise<void> {
  try {
    const started = enterRoot(ctx, () => Promise.resolve(subject.start(ctx)))
    return started.catch((value: unknown) => {
      throw boundaryError(value, `resource[${index}] start`)
    })
  } catch (value) {
    return Promise.reject(boundaryError(value, `resource[${index}] start`))
  }
}

/** Invokes resource stop. The caller context is the stop budget. */
function invokeResourceStop(subject: Server, ctx: Context, index: number): Promise<void> {
  try {
    return Promise.resolve(subject.stop(ctx)).then(
      (value) => value,
      (value: unknown) => rejectedBoundary(value, `resource[${index}] stop`)
    )
  } catch (value) {
    return rejectedBoundary(value, `resource[${index}] stop`)
  }
}

/** Returns a rejected boundary error that already has a rejection handler. */
function rejectedBoundary(value: unknown, operation: string): Promise<never> {
  const rejected = Promise.reject(boundaryError(value, operation))
  void rejected.catch(() => {})
  return rejected
}

/**
 * Reports whether `start` has already rejected.
 * A reaction queued before the probe microtask wins, so a pending start stays owned.
 */
function rejectedStart(started: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    /** Resolves the probe once. */
    const finish = (rejected: boolean): void => {
      if (settled) return
      settled = true
      resolve(rejected)
    }
    started.then(
      () => {
        finish(false)
      },
      () => {
        finish(true)
      }
    )
    queueMicrotask(() => {
      finish(false)
    })
  })
}

/** Watches a `newResourceServer` terminal after admission. Hand-written resources have none. */
export function watchResourceTerminal(
  server: Server,
  index: number,
  stopRequested: () => boolean,
  onFailure: (index: number, error: Error) => void
): void {
  const terminal = resourceTerminal(server)
  if (terminal === undefined) return
  void terminal.then(
    (value) => {
      if (stopRequested()) return
      onFailure(index, isError(value) ? value : closedResourceFailure())
    },
    (reason: unknown) => {
      if (stopRequested()) return
      onFailure(index, boundaryError(reason, "resource terminal"))
    }
  )
}

/** Stops the telemetry tier on a context that is not the caller's possibly-canceled wait. */
export function telemetryStopContext(appContext: Context): Context {
  return withoutCancel(appContext)
}

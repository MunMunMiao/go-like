import type {
  BullMqAlreadyStartedError,
  BullMqWorkerShutdownTimeoutError,
  BullMqUnexpectedExitError
} from "./types"

type BullMqState = "starting" | "running" | "stopping" | "stopped" | "failed"

const alreadyStartedName: BullMqAlreadyStartedError["name"] = "BullMqAlreadyStartedError"
const alreadyStartedCode: BullMqAlreadyStartedError["code"] = "LIKEGO_BULLMQ_ALREADY_STARTED"
const unexpectedExitName: BullMqUnexpectedExitError["name"] = "BullMqUnexpectedExitError"
const unexpectedExitCode: BullMqUnexpectedExitError["code"] = "LIKEGO_BULLMQ_UNEXPECTED_EXIT"
const shutdownTimeoutName: BullMqWorkerShutdownTimeoutError["name"] =
  "BullMqWorkerShutdownTimeoutError"
const shutdownTimeoutCode: BullMqWorkerShutdownTimeoutError["code"] =
  "LIKEGO_BULLMQ_WORKER_SHUTDOWN_TIMEOUT"

/** Preserves official Error identity and normalizes only non-Error boundary values. */
export function normalizeBullMqError(boundary: string, value: unknown): Error {
  if (value instanceof Error) return value
  return Object.freeze(new Error(`${boundary} rejected with a non-Error value`, { cause: value }))
}

/** Creates the immutable one-shot server error. */
export function newBullMqAlreadyStartedError(
  queueName: string,
  status: BullMqState
): BullMqAlreadyStartedError {
  const error = Object.assign(new Error(`BullMQ worker for "${queueName}" has already started`), {
    name: alreadyStartedName,
    code: alreadyStartedCode,
    queueName,
    status
  })
  return Object.freeze(error)
}

/** Creates the immutable passive-terminal worker error. */
export function newBullMqUnexpectedExitError(
  queueName: string,
  exitCause: Error | null
): BullMqUnexpectedExitError {
  const error = Object.assign(
    new Error(`BullMQ worker for "${queueName}" exited unexpectedly`, { cause: exitCause }),
    {
      name: unexpectedExitName,
      code: unexpectedExitCode,
      queueName,
      cause: exitCause
    }
  )
  return Object.freeze(error)
}

/** Creates the immutable provider shutdown timeout error. */
export function newBullMqWorkerShutdownTimeoutError(
  queueName: string,
  timeoutMs: number
): BullMqWorkerShutdownTimeoutError {
  const error = Object.assign(
    new Error(`BullMQ worker for "${queueName}" exceeded shutdown timeout of ${timeoutMs}ms`),
    {
      name: shutdownTimeoutName,
      code: shutdownTimeoutCode,
      queueName,
      timeoutMs
    }
  )
  return Object.freeze(error)
}

/** Returns null, one original Error, or an ordered AggregateError. */
export function combineBullMqErrors(errors: readonly Error[], message: string): Error | null {
  const first = errors[0]
  if (first === undefined) return null
  if (errors.length === 1) return first
  return new AggregateError(errors, message)
}

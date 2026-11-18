import type {
  JobDrainTimeoutError,
  JobPermanentError,
  JobRunnerState,
  JobStateError,
  JobUnknownNameError
} from "./types"

const stateName: JobStateError["name"] = "JobStateError"
const stateCode: JobStateError["code"] = "GO_LIKE_JOB_STATE"
const drainName: JobDrainTimeoutError["name"] = "JobDrainTimeoutError"
const drainCode: JobDrainTimeoutError["code"] = "GO_LIKE_JOB_DRAIN_TIMEOUT"
const unknownName: JobUnknownNameError["name"] = "JobUnknownNameError"
const unknownCode: JobUnknownNameError["code"] = "GO_LIKE_JOB_UNKNOWN_NAME"
const permanentName: JobPermanentError["name"] = "JobPermanentError"
const permanentCode: JobPermanentError["code"] = "GO_LIKE_JOB_PERMANENT"

/** Creates the immutable state error. */
export function newJobStateError(operation: string, state: JobRunnerState): JobStateError {
  const error = new Error(`job ${operation} is not allowed while ${state}`) as JobStateError
  Object.defineProperty(error, "name", { value: stateName })
  Object.defineProperty(error, "code", { value: stateCode })
  Object.defineProperty(error, "operation", { value: operation })
  Object.defineProperty(error, "state", { value: state })
  return Object.freeze(error)
}

/** Creates the immutable drain-timeout error. */
export function newJobDrainTimeoutError(runner: string, timeoutMs: number): JobDrainTimeoutError {
  const error = new Error(
    `job runner ${runner} exceeded drain timeout of ${timeoutMs}ms`
  ) as JobDrainTimeoutError
  Object.defineProperty(error, "name", { value: drainName })
  Object.defineProperty(error, "code", { value: drainCode })
  Object.defineProperty(error, "runner", { value: runner })
  Object.defineProperty(error, "timeoutMs", { value: timeoutMs })
  return Object.freeze(error)
}

/** Creates the immutable unknown-name error. */
export function newJobUnknownNameError(queue: string, jobName: string): JobUnknownNameError {
  const error = new Error(`job ${jobName} has no handler on queue ${queue}`) as JobUnknownNameError
  Object.defineProperty(error, "name", { value: unknownName })
  Object.defineProperty(error, "code", { value: unknownCode })
  Object.defineProperty(error, "queue", { value: queue })
  Object.defineProperty(error, "jobName", { value: jobName })
  return Object.freeze(error)
}

/** Creates a permanent job failure. Handlers throw it to skip remaining attempts. */
export function newPermanentJobError(cause: unknown): JobPermanentError {
  const error = new Error("job failed permanently", { cause }) as JobPermanentError
  Object.defineProperty(error, "name", { value: permanentName })
  Object.defineProperty(error, "code", { value: permanentCode })
  Object.defineProperty(error, "cause", { value: cause })
  return Object.freeze(error)
}

/** Reports a handler failure that must not be retried. */
export function isTerminalJobError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { readonly code?: unknown }).code
  return code === permanentCode || code === unknownCode
}

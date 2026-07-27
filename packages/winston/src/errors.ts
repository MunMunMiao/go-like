import type {
  WinstonAlreadyStartedError,
  WinstonLoggerClosedError,
  WinstonLoggerFinishedError
} from "./types"

type StartedStatus = WinstonAlreadyStartedError["status"]

/** Preserves native Error identity and normalizes only out-of-contract values. */
export function normalizeWinstonError(value: unknown, boundary: string): Error {
  if (value instanceof Error) return value
  return Object.freeze(new Error(`${boundary} emitted a non-Error value`, { cause: value }))
}

/** Creates the immutable one-shot lifecycle error for a consumed Server. */
export function newWinstonAlreadyStartedError(status: StartedStatus): WinstonAlreadyStartedError {
  const error: WinstonAlreadyStartedError = {
    name: "WinstonAlreadyStartedError",
    message: "Winston server has already started",
    code: "LIKEGO_WINSTON_ALREADY_STARTED",
    status
  }
  Object.setPrototypeOf(error, Error.prototype)
  return Object.freeze(error)
}

/** Creates the immutable error for application-initiated end outside owner stop. */
export function newWinstonLoggerFinishedError(): WinstonLoggerFinishedError {
  const error: WinstonLoggerFinishedError = {
    name: "WinstonLoggerFinishedError",
    message: "Winston logger finished before owner stop",
    code: "LIKEGO_WINSTON_LOGGER_FINISHED"
  }
  Object.setPrototypeOf(error, Error.prototype)
  return Object.freeze(error)
}

/** Creates the immutable error for application-initiated close outside owner control. */
export function newWinstonLoggerClosedError(): WinstonLoggerClosedError {
  const error: WinstonLoggerClosedError = {
    name: "WinstonLoggerClosedError",
    message: "Winston logger closed before its finish boundary",
    code: "LIKEGO_WINSTON_LOGGER_CLOSED"
  }
  Object.setPrototypeOf(error, Error.prototype)
  return Object.freeze(error)
}

/** Preserves one failure directly and aggregates distinct failures in observation order. */
export function combineWinstonErrors(failures: readonly Error[]): Error | null {
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  const ordered: Error[] = []
  for (const failure of failures) ordered.push(failure)
  return new AggregateError(ordered, "Winston logger lifecycle failed", { cause: first })
}

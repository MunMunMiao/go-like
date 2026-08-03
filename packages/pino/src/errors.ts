import type {
  PinoAlreadyStartedError,
  PinoDestinationClosedError,
  PinoDrainTimeoutError
} from "./types"

type StartedStatus = PinoAlreadyStartedError["status"]

/** Preserves native Error identity and normalizes only out-of-contract thrown values. */
export function normalizePinoError(value: unknown, boundary: string): Error {
  if (value instanceof Error) return value
  return Object.freeze(new Error(`${boundary} threw a non-Error value`, { cause: value }))
}

/** Creates the immutable one-shot lifecycle error for a consumed Server. */
export function newPinoAlreadyStartedError(status: StartedStatus): PinoAlreadyStartedError {
  const error: PinoAlreadyStartedError = {
    name: "PinoAlreadyStartedError",
    message: "Pino server has already started",
    code: "LIKEGO_PINO_ALREADY_STARTED",
    status
  }
  Object.setPrototypeOf(error, Error.prototype)
  return Object.freeze(error)
}

/** Creates the immutable failure raised when the adapter owner boundary wins. */
export function newPinoDrainTimeoutError(
  timeoutMs: number,
  forceSupported: boolean
): PinoDrainTimeoutError {
  const error: PinoDrainTimeoutError = {
    name: "PinoDrainTimeoutError",
    message: `Pino destination drain exceeded ${timeoutMs}ms`,
    code: "LIKEGO_PINO_DRAIN_TIMEOUT",
    timeoutMs,
    forceSupported
  }
  Object.setPrototypeOf(error, Error.prototype)
  return Object.freeze(error)
}

/** Creates the immutable passive-terminal error for an unexpected native close. */
export function newPinoDestinationClosedError(): PinoDestinationClosedError {
  const error: PinoDestinationClosedError = {
    name: "PinoDestinationClosedError",
    message: "Pino destination closed before owner stop",
    code: "LIKEGO_PINO_DESTINATION_CLOSED"
  }
  Object.setPrototypeOf(error, Error.prototype)
  return Object.freeze(error)
}

/** Preserves one failure directly and aggregates several ordered lifecycle failures. */
export function combinePinoErrors(failures: readonly Error[]): Error | null {
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  const ordered: Error[] = []
  for (const failure of failures) ordered.push(failure)
  return new AggregateError(ordered, "Pino destination lifecycle failed", { cause: first })
}

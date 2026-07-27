import type {
  NoAvailableEndpointError,
  RegistryProtocolError,
  RegistryStateError,
  UnsupportedRegistryCapabilityError,
  WatcherOverflowError,
  WatcherStoppedError
} from "./types"

const registryStateName: RegistryStateError["name"] = "RegistryStateError"
const registryStateCode: RegistryStateError["code"] = "LIKEGO_REGISTRY_STATE"
const watcherStoppedName: WatcherStoppedError["name"] = "WatcherStoppedError"
const watcherStoppedCode: WatcherStoppedError["code"] = "LIKEGO_WATCHER_STOPPED"
const watcherOverflowName: WatcherOverflowError["name"] = "WatcherOverflowError"
const watcherOverflowCode: WatcherOverflowError["code"] = "LIKEGO_WATCHER_OVERFLOW"
const registryProtocolName: RegistryProtocolError["name"] = "RegistryProtocolError"
const registryProtocolCode: RegistryProtocolError["code"] = "LIKEGO_REGISTRY_PROTOCOL"
const unsupportedCapabilityName: UnsupportedRegistryCapabilityError["name"] =
  "UnsupportedRegistryCapabilityError"
const unsupportedCapabilityCode: UnsupportedRegistryCapabilityError["code"] =
  "LIKEGO_UNSUPPORTED_REGISTRY_CAPABILITY"
const noAvailableEndpointName: NoAvailableEndpointError["name"] = "NoAvailableEndpointError"
const noAvailableEndpointCode: NoAvailableEndpointError["code"] = "LIKEGO_NO_AVAILABLE_ENDPOINT"

/** Validates and preserves one public non-empty error detail. */
function detail(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

/** Normalizes an untrusted boundary rejection without retaining a non-Error value. */
export function normalizeBoundaryError(boundary: string, value: unknown): Error {
  if (value instanceof Error) return value
  return Object.freeze(new Error(`${boundary} failed with a non-Error value`))
}

/** Preserves one failure identity or aggregates ordered independent failures. */
export function combineFailures(errors: readonly Error[], message: string): Error {
  const first = errors[0]
  if (errors.length === 1 && first !== undefined) return first
  return Object.freeze(new AggregateError(errors, message))
}

/** Creates the stable immutable error for an operation in an invalid state. */
export function newRegistryStateError(operation: string, state: string): RegistryStateError {
  const validOperation = detail(operation, "Registry operation")
  const validState = detail(state, "Registry state")
  return Object.freeze(
    Object.assign(new Error(`${validOperation} is invalid while Registry state is ${validState}`), {
      name: registryStateName,
      code: registryStateCode,
      operation: validOperation,
      state: validState
    })
  )
}

/** Creates the stable immutable error for a stopped Watcher. */
export function newWatcherStoppedError(): WatcherStoppedError {
  return Object.freeze(
    Object.assign(new Error("registry watcher has stopped"), {
      name: watcherStoppedName,
      code: watcherStoppedCode
    })
  )
}

/** Creates the stable immutable terminal failure for a full Watcher buffer. */
export function newWatcherOverflowError(bufferSize: number): WatcherOverflowError {
  if (!Number.isInteger(bufferSize) || bufferSize < 1 || bufferSize > 4_096) {
    throw new RangeError("watcher bufferSize must be an integer from 1 through 4096")
  }
  return Object.freeze(
    Object.assign(new Error(`registry watcher buffer of ${bufferSize} events overflowed`), {
      name: watcherOverflowName,
      code: watcherOverflowCode,
      bufferSize
    })
  )
}

/** Creates a stable immutable fail-closed Registry protocol error. */
export function newRegistryProtocolError(message: string, cause?: Error): RegistryProtocolError {
  const validMessage = detail(message, "Registry protocol error message")
  const error = cause === undefined ? new Error(validMessage) : new Error(validMessage, { cause })
  return Object.freeze(
    Object.assign(error, {
      name: registryProtocolName,
      code: registryProtocolCode
    })
  )
}

/** Creates a stable immutable provider capability-admission error. */
export function newUnsupportedRegistryCapabilityError(
  capability: string,
  reason: string
): UnsupportedRegistryCapabilityError {
  const validCapability = detail(capability, "Registry capability")
  const validReason = detail(reason, "Registry capability reason")
  return Object.freeze(
    Object.assign(
      new Error(`Registry capability ${validCapability} is unsupported: ${validReason}`),
      {
        name: unsupportedCapabilityName,
        code: unsupportedCapabilityCode,
        capability: validCapability
      }
    )
  )
}

/** Creates the stable immutable selector failure for an empty snapshot. */
export function newNoAvailableEndpointError(): NoAvailableEndpointError {
  return Object.freeze(
    Object.assign(new Error("no service endpoint is available"), {
      name: noAvailableEndpointName,
      code: noAvailableEndpointCode
    })
  )
}

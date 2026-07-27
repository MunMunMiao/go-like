import type {
  ConsulStoreHttpError,
  ConsulStoreOperation,
  ConsulStoreProtocolError,
  ConsulStoreTransportError,
  ConsulStoreUncertainError,
  ConsulStoreUnsupportedCombination,
  ConsulStoreUnsupportedCombinationError
} from "./types"

const httpName: ConsulStoreHttpError["name"] = "ConsulStoreHttpError"
const httpCode: ConsulStoreHttpError["code"] = "LIKEGO_CONSUL_STORE_HTTP"
const transportName: ConsulStoreTransportError["name"] = "ConsulStoreTransportError"
const transportCode: ConsulStoreTransportError["code"] = "LIKEGO_CONSUL_STORE_TRANSPORT"
const protocolName: ConsulStoreProtocolError["name"] = "ConsulStoreProtocolError"
const protocolCode: ConsulStoreProtocolError["code"] = "LIKEGO_CONSUL_STORE_PROTOCOL"
const uncertainName: ConsulStoreUncertainError["name"] = "ConsulStoreUncertainError"
const uncertainCode: ConsulStoreUncertainError["code"] = "LIKEGO_CONSUL_STORE_UNCERTAIN"
const combinationName: ConsulStoreUnsupportedCombinationError["name"] =
  "ConsulStoreUnsupportedCombinationError"
const combinationCode: ConsulStoreUnsupportedCombinationError["code"] =
  "LIKEGO_CONSUL_STORE_UNSUPPORTED_COMBINATION"

/** Narrows a boundary rejection without stringifying arbitrary carrier graphs. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates one immutable status-only Consul Store HTTP error. */
export function newConsulStoreHttpError(
  operation: ConsulStoreOperation,
  status: number
): ConsulStoreHttpError {
  return Object.freeze(
    Object.assign(new Error(`Consul Store ${operation} request failed with HTTP ${status}`), {
      name: httpName,
      code: httpCode,
      operation,
      status
    })
  )
}

/** Creates one immutable Consul Store transport error with ACL-boundary sanitization. */
export function newConsulStoreTransportError(
  operation: ConsulStoreOperation,
  value: unknown,
  secretBoundary: boolean
): ConsulStoreTransportError {
  const cause = secretBoundary
    ? new Error(`Consul Store ${operation} transport rejected at a secret-bearing boundary`)
    : boundaryError(value, `Consul Store ${operation} transport rejected with a non-Error value`)
  return Object.freeze(
    Object.assign(new Error(`Consul Store ${operation} transport failed`, { cause }), {
      name: transportName,
      code: transportCode,
      operation,
      cause
    })
  )
}

/** Creates one immutable body-independent Consul Store protocol error. */
export function newConsulStoreProtocolError(
  operation: ConsulStoreOperation
): ConsulStoreProtocolError {
  return Object.freeze(
    Object.assign(new Error(`Consul Store ${operation} response violated the protocol`), {
      name: protocolName,
      code: protocolCode,
      operation
    })
  )
}

/** Creates one immutable mutation-uncertainty error after failed exact readback. */
export function newConsulStoreUncertainError(
  operation: ConsulStoreUncertainError["operation"],
  value: unknown
): ConsulStoreUncertainError {
  const cause = boundaryError(value, `Consul Store ${operation} outcome was uncertain`)
  return Object.freeze(
    Object.assign(new Error(`Consul Store ${operation} outcome could not be proven`), {
      name: uncertainName,
      code: uncertainCode,
      operation,
      cause
    })
  )
}

/** Creates one immutable Consul-specific unsupported-combination error. */
export function newConsulStoreUnsupportedCombinationError(
  combination: ConsulStoreUnsupportedCombination
): ConsulStoreUnsupportedCombinationError {
  if (combination !== "ttl-cas" && combination !== "cas-existing-ttl") {
    throw new TypeError("Consul Store unsupported combination is invalid")
  }
  return Object.freeze(
    Object.assign(new Error(`Consul Store combination ${combination} is unsupported`), {
      name: combinationName,
      code: combinationCode,
      combination
    })
  )
}

/** Reports whether a failure leaves a mutation outcome uncertain. */
export function isUncertainFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === transportCode || value.code === protocolCode) return true
  return (
    value.code === httpCode &&
    "status" in value &&
    typeof value.status === "number" &&
    (value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500)
  )
}

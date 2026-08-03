import type { ConsulHttpError, ConsulOperation, ConsulTransportError } from "./types"

const httpName: ConsulHttpError["name"] = "ConsulHttpError"
const httpCode: ConsulHttpError["code"] = "LIKEGO_CONSUL_HTTP"
const transportName: ConsulTransportError["name"] = "ConsulTransportError"
const transportCode: ConsulTransportError["code"] = "LIKEGO_CONSUL_TRANSPORT"

/** Narrows an untrusted boundary rejection without retaining arbitrary carrier graphs. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates a status-only Consul HTTP error without reading its response body. */
export function newHttpError(operation: ConsulOperation, status: number): ConsulHttpError {
  return Object.freeze(
    Object.assign(new Error(`Consul ${operation} request failed with HTTP ${status}`), {
      name: httpName,
      code: httpCode,
      operation,
      status
    })
  )
}

/** Creates a transport error and strips the original graph when an ACL token is configured. */
export function newTransportError(
  operation: ConsulOperation,
  value: unknown,
  secretBoundary: boolean
): ConsulTransportError {
  const cause = secretBoundary
    ? new Error(`Consul ${operation} transport rejected at a secret-bearing boundary`)
    : boundaryError(value, `Consul ${operation} transport rejected with a non-Error value`)
  return Object.freeze(
    Object.assign(new Error(`Consul ${operation} transport failed`, { cause }), {
      name: transportName,
      code: transportCode,
      operation,
      cause
    })
  )
}

/** Preserves a primary failure and appends ordered rollback failures. */
export function rollbackFailure(primary: Error, failures: readonly Error[]): Error {
  if (failures.length === 0) return primary
  const errors: Error[] = [primary]
  for (const failure of failures) errors.push(failure)
  return new AggregateError(errors, "Consul mutation failed and rollback was incomplete")
}

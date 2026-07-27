import type { EtcdHttpError, EtcdOperation, EtcdTransportError } from "./types"

const httpName: EtcdHttpError["name"] = "EtcdHttpError"
const httpCode: EtcdHttpError["code"] = "LIKEGO_ETCD_HTTP"
const transportName: EtcdTransportError["name"] = "EtcdTransportError"
const transportCode: EtcdTransportError["code"] = "LIKEGO_ETCD_TRANSPORT"

/** Narrows an untrusted rejection without retaining a non-Error carrier. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates one status-only HTTP error without reading response bytes. */
export function newHttpError(operation: EtcdOperation, status: number): EtcdHttpError {
  return Object.freeze(
    Object.assign(new Error(`etcd ${operation} request failed with HTTP ${status}`), {
      name: httpName,
      code: httpCode,
      operation,
      status
    })
  )
}

/** Creates one Fetch error while stripping secret-bearing rejection graphs. */
export function newTransportError(
  operation: EtcdOperation,
  value: unknown,
  secretBoundary: boolean
): EtcdTransportError {
  const cause = secretBoundary
    ? new Error(`etcd ${operation} transport rejected at a secret-bearing boundary`)
    : boundaryError(value, `etcd ${operation} transport rejected with a non-Error value`)
  return Object.freeze(
    Object.assign(new Error(`etcd ${operation} transport failed`, { cause }), {
      name: transportName,
      code: transportCode,
      operation,
      cause
    })
  )
}

/** Preserves a primary mutation failure before ordered rollback failures. */
export function rollbackFailure(primary: Error, failures: readonly Error[]): Error {
  if (failures.length === 0) return primary
  const errors: Error[] = [primary]
  for (const failure of failures) errors.push(failure)
  return new AggregateError(errors, "etcd mutation failed and rollback was incomplete")
}

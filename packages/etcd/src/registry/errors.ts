import {
  boundaryError,
  newEtcdHttpError,
  newEtcdTransportError,
  type EtcdHttpError,
  type EtcdTransportError
} from "../client/errors"
import type { RegistryWireOperation } from "./types"

export { boundaryError }

/** Creates one status-only HTTP error without reading response bytes. */
export function newHttpError(operation: RegistryWireOperation, status: number): EtcdHttpError {
  return newEtcdHttpError(`registry.${operation}`, status, null)
}

/** Creates one Fetch error while stripping secret-bearing rejection graphs. */
export function newTransportError(
  operation: RegistryWireOperation,
  value: unknown,
  secretBoundary: boolean
): EtcdTransportError {
  return newEtcdTransportError(`registry.${operation}`, value, secretBoundary)
}

/** Preserves a primary mutation failure before ordered rollback failures. */
export function rollbackFailure(primary: Error, failures: readonly Error[]): Error {
  if (failures.length === 0) return primary
  const errors: Error[] = [primary]
  for (const failure of failures) errors.push(failure)
  return new AggregateError(errors, "etcd mutation failed and rollback was incomplete")
}

import {
  etcdHttpCode,
  etcdProtocolCode,
  etcdTransportCode,
  newEtcdHttpError,
  newEtcdProtocolError,
  newEtcdTransportError,
  type EtcdHttpError,
  type EtcdProtocolError,
  type EtcdTransportError
} from "../client/errors"
import type {
  EtcdStoreCleanupError,
  EtcdStoreCompactedError,
  EtcdStoreLeaseLostError,
  EtcdStoreOperation,
  EtcdStoreUncertainError
} from "./types"

const compactedName: EtcdStoreCompactedError["name"] = "EtcdStoreCompactedError"
const compactedCode: EtcdStoreCompactedError["code"] = "GO_LIKE_ETCD_STORE_COMPACTED"
const leaseName: EtcdStoreLeaseLostError["name"] = "EtcdStoreLeaseLostError"
const leaseCode: EtcdStoreLeaseLostError["code"] = "GO_LIKE_ETCD_STORE_LEASE_LOST"
const uncertainName: EtcdStoreUncertainError["name"] = "EtcdStoreUncertainError"
const uncertainCode: EtcdStoreUncertainError["code"] = "GO_LIKE_ETCD_STORE_UNCERTAIN"
const cleanupName: EtcdStoreCleanupError["name"] = "EtcdStoreCleanupError"
const cleanupCode: EtcdStoreCleanupError["code"] = "GO_LIKE_ETCD_STORE_CLEANUP"

/** Converts one unknown safe internal failure without stringifying it. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates one immutable JSON gateway error for a store operation. */
export function newEtcdStoreHttpError(
  operation: EtcdStoreOperation,
  status: number,
  grpcCode: number | null
): EtcdHttpError {
  return newEtcdHttpError(`store.${operation}`, status, grpcCode)
}

/** Creates one immutable borrowed-Fetch error for a store operation. */
export function newEtcdStoreTransportError(
  operation: EtcdStoreOperation,
  value: unknown,
  secretBoundary: boolean
): EtcdTransportError {
  return newEtcdTransportError(`store.${operation}`, value, secretBoundary)
}

/** Creates one immutable response-body-independent protocol error for a store operation. */
export function newEtcdStoreProtocolError(operation: EtcdStoreOperation): EtcdProtocolError {
  return newEtcdProtocolError(`store.${operation}`)
}

/** Creates one stable historical pagination compaction error. */
export function newEtcdStoreCompactedError(revision: string): EtcdStoreCompactedError {
  const error = new Error("etcd Store pagination revision was compacted")
  const details: Pick<EtcdStoreCompactedError, "name" | "code" | "revision"> = {
    name: compactedName,
    code: compactedCode,
    revision
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates one stable lease-loss error for an uncommitted TTL write. */
export function newEtcdStoreLeaseLostError(): EtcdStoreLeaseLostError {
  const error = new Error("etcd Store write lease was lost before commit")
  const details: Pick<EtcdStoreLeaseLostError, "name" | "code" | "operation"> = {
    name: leaseName,
    code: leaseCode,
    operation: "write"
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates one immutable mutation uncertainty after failed exact readback. */
export function newEtcdStoreUncertainError(
  operation: "write" | "delete",
  value: unknown
): EtcdStoreUncertainError {
  const cause = boundaryError(value, `etcd Store ${operation} outcome was uncertain`)
  const error = new Error(`etcd Store ${operation} outcome could not be proven`, { cause })
  const details: Pick<EtcdStoreUncertainError, "name" | "code" | "operation" | "cause"> = {
    name: uncertainName,
    code: uncertainCode,
    operation,
    cause
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates one immutable committed-mutation lease cleanup failure. */
export function newEtcdStoreCleanupError(
  operation: "write" | "delete",
  value: unknown
): EtcdStoreCleanupError {
  const cause = boundaryError(value, `etcd Store ${operation} lease cleanup failed`)
  const error = new Error(`etcd Store ${operation} committed but lease cleanup failed`, { cause })
  const details: Pick<
    EtcdStoreCleanupError,
    "name" | "code" | "operation" | "committed" | "cause"
  > = { name: cleanupName, code: cleanupCode, operation, committed: true, cause }
  return Object.freeze(Object.assign(error, details))
}

/** Reports whether a boundary failure may follow a committed mutation. */
export function isUncertainFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === etcdTransportCode || value.code === etcdProtocolCode) return true
  return (
    value.code === etcdHttpCode &&
    "status" in value &&
    typeof value.status === "number" &&
    (value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500)
  )
}

/** Reports whether etcd identified one missing lease without inspecting its message. */
export function isMissingLease(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === etcdHttpCode &&
    "status" in value &&
    value.status === 404 &&
    "grpcCode" in value &&
    value.grpcCode === 5
  )
}

/** Reports whether etcd identified a removed MVCC history revision. */
export function isCompacted(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === etcdHttpCode &&
    "status" in value &&
    value.status === 400 &&
    "grpcCode" in value &&
    value.grpcCode === 11
  )
}

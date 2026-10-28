import type {
  EtcdStoreCleanupError,
  EtcdStoreCompactedError,
  EtcdStoreHttpError,
  EtcdStoreLeaseLostError,
  EtcdStoreOperation,
  EtcdStoreProtocolError,
  EtcdStoreTransportError,
  EtcdStoreUncertainError
} from "./types"

const httpName: EtcdStoreHttpError["name"] = "EtcdStoreHttpError"
const httpCode: EtcdStoreHttpError["code"] = "GO_LIKE_ETCD_STORE_HTTP"
const transportName: EtcdStoreTransportError["name"] = "EtcdStoreTransportError"
const transportCode: EtcdStoreTransportError["code"] = "GO_LIKE_ETCD_STORE_TRANSPORT"
const protocolName: EtcdStoreProtocolError["name"] = "EtcdStoreProtocolError"
const protocolCode: EtcdStoreProtocolError["code"] = "GO_LIKE_ETCD_STORE_PROTOCOL"
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

/** Creates one immutable status-only JSON gateway error. */
export function newEtcdStoreHttpError(
  operation: EtcdStoreOperation,
  status: number,
  grpcCode: number | null
): EtcdStoreHttpError {
  const error = new Error(`etcd Store ${operation} request failed with HTTP ${status}`)
  const details: Pick<EtcdStoreHttpError, "name" | "code" | "operation" | "status" | "grpcCode"> = {
    name: httpName,
    code: httpCode,
    operation,
    status,
    grpcCode
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates one immutable borrowed-Fetch error without retaining native rejection graphs. */
export function newEtcdStoreTransportError(operation: EtcdStoreOperation): EtcdStoreTransportError {
  const error = new Error(`etcd Store ${operation} transport failed`)
  const details: Pick<EtcdStoreTransportError, "name" | "code" | "operation"> = {
    name: transportName,
    code: transportCode,
    operation
  }
  return Object.freeze(Object.assign(error, details))
}

/** Creates one immutable response-body-independent protocol error. */
export function newEtcdStoreProtocolError(operation: EtcdStoreOperation): EtcdStoreProtocolError {
  const error = new Error(`etcd Store ${operation} response violated the protocol`)
  const details: Pick<EtcdStoreProtocolError, "name" | "code" | "operation"> = {
    name: protocolName,
    code: protocolCode,
    operation
  }
  return Object.freeze(Object.assign(error, details))
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
  if (value.code === transportCode || value.code === protocolCode) return true
  return (
    value.code === httpCode &&
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
    value.code === httpCode &&
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
    value.code === httpCode &&
    "status" in value &&
    value.status === 400 &&
    "grpcCode" in value &&
    value.grpcCode === 11
  )
}

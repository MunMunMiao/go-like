/** etcd error operation names, prefixed by the socket that issued the call. */
export type EtcdOperation =
  | "registry.lease-grant"
  | "registry.lease-keepalive"
  | "registry.lease-revoke"
  | "registry.txn"
  | "registry.range"
  | "registry.watch"
  | "config.range"
  | "config.watch"
  | "store.read"
  | "store.write"
  | "store.write-readback"
  | "store.delete"
  | "store.delete-readback"
  | "store.list"
  | "store.lease-grant"
  | "store.lease-revoke"

/** etcd returned a non-2xx status that the caller did not allow. */
export interface EtcdHttpError extends Error {
  readonly name: "EtcdHttpError"
  readonly code: "GO_LIKE_ETCD_HTTP"
  readonly operation: EtcdOperation
  readonly status: number
  /** Numeric gRPC code from the gateway error body, null when absent (read from at most 64 KiB). */
  readonly grpcCode: number | null
}

/** A request or body read failed while the caller context was still active. */
export interface EtcdTransportError extends Error {
  readonly name: "EtcdTransportError"
  readonly code: "GO_LIKE_ETCD_TRANSPORT"
  readonly operation: EtcdOperation
  readonly cause: Error
}

/** An etcd response was malformed or violated the protocol. */
export interface EtcdProtocolError extends Error {
  readonly name: "EtcdProtocolError"
  readonly code: "GO_LIKE_ETCD_PROTOCOL"
  readonly operation: EtcdOperation
}

const httpName: EtcdHttpError["name"] = "EtcdHttpError"
const httpCode: EtcdHttpError["code"] = "GO_LIKE_ETCD_HTTP"
const transportName: EtcdTransportError["name"] = "EtcdTransportError"
const transportCode: EtcdTransportError["code"] = "GO_LIKE_ETCD_TRANSPORT"
const protocolName: EtcdProtocolError["name"] = "EtcdProtocolError"
const protocolCode: EtcdProtocolError["code"] = "GO_LIKE_ETCD_PROTOCOL"

/** Narrows an untrusted boundary rejection without retaining arbitrary carrier graphs. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates one status-bearing etcd HTTP error. grpcCode is null when the body did not carry one. */
export function newEtcdHttpError(
  operation: EtcdOperation,
  status: number,
  grpcCode: number | null
): EtcdHttpError {
  return Object.freeze(
    Object.assign(new Error(`etcd ${operation} request failed with HTTP ${status}`), {
      name: httpName,
      code: httpCode,
      operation,
      status,
      grpcCode
    })
  )
}

/** Creates a transport error and strips the original graph when a token is configured. */
export function newEtcdTransportError(
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

/** Creates one body-independent etcd protocol error. */
export function newEtcdProtocolError(operation: EtcdOperation): EtcdProtocolError {
  return Object.freeze(
    Object.assign(new Error(`etcd ${operation} response violated the protocol`), {
      name: protocolName,
      code: protocolCode,
      operation
    })
  )
}

export const etcdHttpCode: EtcdHttpError["code"] = httpCode
export const etcdTransportCode: EtcdTransportError["code"] = transportCode
export const etcdProtocolCode: EtcdProtocolError["code"] = protocolCode

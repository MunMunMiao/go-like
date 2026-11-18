/** Consul error operation names, prefixed by the socket that issued the call. */
export type ConsulOperation =
  | "registry.register"
  | "registry.heartbeat"
  | "registry.deregister"
  | "registry.readback"
  | "registry.get"
  | "registry.watch"
  | "config.load"
  | "config.watch"
  | "store.read"
  | "store.write"
  | "store.delete"
  | "store.list"
  | "store.session-create"
  | "store.session-readback"
  | "store.session-destroy"

/** Consul returned a non-2xx status that the caller did not allow. */
export interface ConsulHttpError extends Error {
  readonly name: "ConsulHttpError"
  readonly code: "GO_LIKE_CONSUL_HTTP"
  readonly operation: ConsulOperation
  readonly status: number
}

/** A request or body read failed while the caller context was still active. */
export interface ConsulTransportError extends Error {
  readonly name: "ConsulTransportError"
  readonly code: "GO_LIKE_CONSUL_TRANSPORT"
  readonly operation: ConsulOperation
  readonly cause: Error
}

/** A Consul response was malformed or violated the protocol. */
export interface ConsulProtocolError extends Error {
  readonly name: "ConsulProtocolError"
  readonly code: "GO_LIKE_CONSUL_PROTOCOL"
  readonly operation: ConsulOperation
}

const httpName: ConsulHttpError["name"] = "ConsulHttpError"
const httpCode: ConsulHttpError["code"] = "GO_LIKE_CONSUL_HTTP"
const transportName: ConsulTransportError["name"] = "ConsulTransportError"
const transportCode: ConsulTransportError["code"] = "GO_LIKE_CONSUL_TRANSPORT"
const protocolName: ConsulProtocolError["name"] = "ConsulProtocolError"
const protocolCode: ConsulProtocolError["code"] = "GO_LIKE_CONSUL_PROTOCOL"

/** Narrows an untrusted boundary rejection without retaining arbitrary carrier graphs. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates a status-only Consul HTTP error without reading its response body. */
export function newConsulHttpError(operation: ConsulOperation, status: number): ConsulHttpError {
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
export function newConsulTransportError(
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

/** Creates one body-independent Consul protocol error. */
export function newConsulProtocolError(operation: ConsulOperation): ConsulProtocolError {
  return Object.freeze(
    Object.assign(new Error(`Consul ${operation} response violated the protocol`), {
      name: protocolName,
      code: protocolCode,
      operation
    })
  )
}

export const consulHttpCode: ConsulHttpError["code"] = httpCode
export const consulTransportCode: ConsulTransportError["code"] = transportCode
export const consulProtocolCode: ConsulProtocolError["code"] = protocolCode

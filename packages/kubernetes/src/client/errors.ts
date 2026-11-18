/** Kubernetes error operation names, prefixed by the socket that issued the call. */
export type KubernetesOperation =
  | "registry.create"
  | "registry.delete"
  | "registry.get"
  | "registry.list"
  | "registry.update"
  | "registry.watch"
  | "config.get"
  | "config.list"
  | "config.watch"

/** Registry wire operations before the shared error prefix is applied. */
export type RegistryWireOperation = "create" | "delete" | "get" | "list" | "update" | "watch"

/** Config wire operations before the shared error prefix is applied. */
export type ConfigWireOperation = "get" | "list" | "watch"

/** API server returned a non-2xx status that the caller did not allow. */
export interface KubernetesHttpError extends Error {
  readonly name: "KubernetesHttpError"
  readonly code: "GO_LIKE_KUBERNETES_HTTP"
  readonly operation: KubernetesOperation
  readonly status: number
}

/** A request or body read failed while the caller context was still active. */
export interface KubernetesTransportError extends Error {
  readonly name: "KubernetesTransportError"
  readonly code: "GO_LIKE_KUBERNETES_TRANSPORT"
  readonly operation: KubernetesOperation
  readonly cause: Error
}

/** An API server response was malformed or violated the protocol. */
export interface KubernetesProtocolError extends Error {
  readonly name: "KubernetesProtocolError"
  readonly code: "GO_LIKE_KUBERNETES_PROTOCOL"
  readonly operation: KubernetesOperation
}

const httpName: KubernetesHttpError["name"] = "KubernetesHttpError"
const httpCode: KubernetesHttpError["code"] = "GO_LIKE_KUBERNETES_HTTP"
const transportName: KubernetesTransportError["name"] = "KubernetesTransportError"
const transportCode: KubernetesTransportError["code"] = "GO_LIKE_KUBERNETES_TRANSPORT"
const protocolName: KubernetesProtocolError["name"] = "KubernetesProtocolError"
const protocolCode: KubernetesProtocolError["code"] = "GO_LIKE_KUBERNETES_PROTOCOL"

/** Prefixes a registry wire operation when constructing a shared error. */
export function registryOperation(operation: RegistryWireOperation): KubernetesOperation {
  if (operation === "create") return "registry.create"
  if (operation === "delete") return "registry.delete"
  if (operation === "get") return "registry.get"
  if (operation === "list") return "registry.list"
  if (operation === "update") return "registry.update"
  return "registry.watch"
}

/** Prefixes a config wire operation when constructing a shared error. */
export function configOperation(operation: ConfigWireOperation): KubernetesOperation {
  if (operation === "get") return "config.get"
  if (operation === "list") return "config.list"
  return "config.watch"
}

/** Narrows an untrusted rejection without retaining a non-Error carrier. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates a status-only Kubernetes HTTP error without reading its response body. */
export function newKubernetesHttpError(
  operation: KubernetesOperation,
  status: number
): KubernetesHttpError {
  return Object.freeze(
    Object.assign(new Error(`Kubernetes ${operation} request failed with HTTP ${status}`), {
      name: httpName,
      code: httpCode,
      operation,
      status
    })
  )
}

/** Creates a transport error and strips the original graph when a bearer token is configured. */
export function newKubernetesTransportError(
  operation: KubernetesOperation,
  value: unknown,
  secretBoundary: boolean
): KubernetesTransportError {
  const cause = secretBoundary
    ? new Error(`Kubernetes ${operation} transport rejected at a secret-bearing boundary`)
    : boundaryError(value, `Kubernetes ${operation} transport rejected with a non-Error value`)
  return Object.freeze(
    Object.assign(new Error(`Kubernetes ${operation} transport failed`, { cause }), {
      name: transportName,
      code: transportCode,
      operation,
      cause
    })
  )
}

/** Creates one body-independent Kubernetes protocol error. */
export function newKubernetesProtocolError(
  operation: KubernetesOperation
): KubernetesProtocolError {
  return Object.freeze(
    Object.assign(new Error(`Kubernetes ${operation} response violated the protocol`), {
      name: protocolName,
      code: protocolCode,
      operation
    })
  )
}

export const kubernetesHttpCode: KubernetesHttpError["code"] = httpCode
export const kubernetesTransportCode: KubernetesTransportError["code"] = transportCode
export const kubernetesProtocolCode: KubernetesProtocolError["code"] = protocolCode

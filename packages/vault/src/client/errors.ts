/** Vault error operation names, prefixed by the socket that issued the call. */
export type VaultOperation =
  | "config.read"
  | "store.read"
  | "store.write"
  | "store.delete"
  | "store.list"

/** Vault returned a non-2xx status that the caller did not treat as absence or success. */
export interface VaultHttpError extends Error {
  readonly name: "VaultHttpError"
  readonly code: "GO_LIKE_VAULT_HTTP"
  readonly operation: VaultOperation
  readonly status: number
}

/**
 * A request or body read failed while the caller context was still active.
 * The cause is the original error, or a fixed protected error when the client carries a secret.
 */
export interface VaultTransportError extends Error {
  readonly name: "VaultTransportError"
  readonly code: "GO_LIKE_VAULT_TRANSPORT"
  readonly operation: VaultOperation
  readonly cause: Error
}

/** A Vault response was malformed or violated the protocol. */
export interface VaultProtocolError extends Error {
  readonly name: "VaultProtocolError"
  readonly code: "GO_LIKE_VAULT_PROTOCOL"
  readonly operation: VaultOperation
}

const httpName: VaultHttpError["name"] = "VaultHttpError"
const httpCode: VaultHttpError["code"] = "GO_LIKE_VAULT_HTTP"
const transportName: VaultTransportError["name"] = "VaultTransportError"
const transportCode: VaultTransportError["code"] = "GO_LIKE_VAULT_TRANSPORT"
const protocolName: VaultProtocolError["name"] = "VaultProtocolError"
const protocolCode: VaultProtocolError["code"] = "GO_LIKE_VAULT_PROTOCOL"

/** Narrows an untrusted boundary rejection without retaining arbitrary carrier graphs. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates a status-only Vault HTTP error without reading its response body. */
export function newVaultHttpError(operation: VaultOperation, status: number): VaultHttpError {
  return Object.freeze(
    Object.assign(new Error(`Vault ${operation} request failed with HTTP ${status}`), {
      name: httpName,
      code: httpCode,
      operation,
      status
    })
  )
}

/**
 * Creates a transport error.
 * A secret-bearing client replaces the rejection graph with one fixed cause.
 */
export function newVaultTransportError(
  operation: VaultOperation,
  value: unknown,
  secretBoundary: boolean
): VaultTransportError {
  const cause = secretBoundary
    ? new Error(`Vault ${operation} transport rejected at a protected boundary`)
    : boundaryError(value, `Vault ${operation} transport rejected with a non-Error value`)
  return Object.freeze(
    Object.assign(new Error(`Vault ${operation} transport failed`, { cause }), {
      name: transportName,
      code: transportCode,
      operation,
      cause
    })
  )
}

/** Creates one body-independent Vault protocol error. */
export function newVaultProtocolError(operation: VaultOperation): VaultProtocolError {
  return Object.freeze(
    Object.assign(new Error(`Vault ${operation} response violated the protocol`), {
      name: protocolName,
      code: protocolCode,
      operation
    })
  )
}

export const vaultHttpCode: VaultHttpError["code"] = httpCode
export const vaultTransportCode: VaultTransportError["code"] = transportCode
export const vaultProtocolCode: VaultProtocolError["code"] = protocolCode

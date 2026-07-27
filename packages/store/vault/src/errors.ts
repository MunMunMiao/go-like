import type {
  VaultStoreHttpError,
  VaultStoreOperation,
  VaultStoreProtocolError,
  VaultStoreSnapshotError,
  VaultStoreTransportError,
  VaultStoreUncertainError
} from "./types"

/** Narrows one public Vault operation token. */
function isOperation(value: unknown): value is VaultStoreOperation {
  return value === "read" || value === "write" || value === "delete" || value === "list"
}

/** Narrows one decorated Vault HTTP error. */
function isHttpError(value: Error): value is VaultStoreHttpError {
  return (
    value.name === "VaultStoreHttpError" &&
    "code" in value &&
    value.code === "LIKEGO_VAULT_STORE_HTTP" &&
    "operation" in value &&
    isOperation(value.operation) &&
    "status" in value &&
    typeof value.status === "number"
  )
}

/** Narrows one decorated Vault protocol error. */
function isProtocolError(value: Error): value is VaultStoreProtocolError {
  return (
    value.name === "VaultStoreProtocolError" &&
    "code" in value &&
    value.code === "LIKEGO_VAULT_STORE_PROTOCOL" &&
    "operation" in value &&
    isOperation(value.operation)
  )
}

/** Narrows one decorated Vault transport error. */
function isTransportError(value: Error): value is VaultStoreTransportError {
  return (
    value.name === "VaultStoreTransportError" &&
    "code" in value &&
    value.code === "LIKEGO_VAULT_STORE_TRANSPORT" &&
    "operation" in value &&
    isOperation(value.operation) &&
    "cause" in value &&
    value.cause instanceof Error
  )
}

/** Narrows one decorated Vault uncertain-mutation error. */
function isUncertainError(value: Error): value is VaultStoreUncertainError {
  return (
    value.name === "VaultStoreUncertainError" &&
    "code" in value &&
    value.code === "LIKEGO_VAULT_STORE_UNCERTAIN" &&
    "operation" in value &&
    (value.operation === "write" || value.operation === "delete") &&
    "cause" in value &&
    value.cause instanceof Error
  )
}

/** Narrows one decorated Vault pagination snapshot error. */
function isSnapshotError(value: Error): value is VaultStoreSnapshotError {
  return (
    value.name === "VaultStoreSnapshotError" &&
    "code" in value &&
    value.code === "LIKEGO_VAULT_STORE_SNAPSHOT" &&
    "reason" in value &&
    (value.reason === "invalid-cursor" ||
      value.reason === "expired-cursor" ||
      value.reason === "capacity")
  )
}

/** Converts one foreign rejection into a non-reflecting Error. */
export function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Vault Store operation failed")
}

/** Creates one frozen real HTTP Error without response content. */
export function newHttpError(operation: VaultStoreOperation, status: number): VaultStoreHttpError {
  if (!isOperation(operation) || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("Vault Store HTTP error details are invalid")
  }
  const error = new Error(`Vault Store ${operation} request failed with HTTP ${status}`)
  Object.defineProperties(error, {
    name: { enumerable: true, value: "VaultStoreHttpError" },
    code: { enumerable: true, value: "LIKEGO_VAULT_STORE_HTTP" },
    operation: { enumerable: true, value: operation },
    status: { enumerable: true, value: status }
  })
  if (!isHttpError(error)) throw new TypeError("Vault Store HTTP error decoration failed")
  return Object.freeze(error)
}

/** Creates one frozen real protocol Error without response content. */
export function newProtocolError(operation: VaultStoreOperation): VaultStoreProtocolError {
  if (!isOperation(operation)) throw new TypeError("Vault Store protocol operation is invalid")
  const error = new Error(`Vault Store ${operation} response was malformed`)
  Object.defineProperties(error, {
    name: { enumerable: true, value: "VaultStoreProtocolError" },
    code: { enumerable: true, value: "LIKEGO_VAULT_STORE_PROTOCOL" },
    operation: { enumerable: true, value: operation }
  })
  if (!isProtocolError(error)) throw new TypeError("Vault Store protocol error decoration failed")
  return Object.freeze(error)
}

/** Creates one real transport Error while replacing a secret-bearing rejection graph. */
export function newTransportError(
  operation: VaultStoreOperation,
  value: unknown,
  sensitive: boolean
): VaultStoreTransportError {
  if (!isOperation(operation)) throw new TypeError("Vault Store transport operation is invalid")
  const foreign = normalizeError(value)
  const safeCause = sensitive
    ? new Error("Vault Store Fetch failed with protected headers")
    : foreign
  const error = new Error(`Vault Store ${operation} transport failed`, { cause: safeCause })
  Object.defineProperties(error, {
    name: { enumerable: true, value: "VaultStoreTransportError" },
    code: { enumerable: true, value: "LIKEGO_VAULT_STORE_TRANSPORT" },
    operation: { enumerable: true, value: operation }
  })
  if (!isTransportError(error)) throw new TypeError("Vault Store transport error decoration failed")
  return Object.freeze(error)
}

/** Creates one frozen real error for a mutation that exact readback cannot prove. */
export function newUncertainError(
  operation: "write" | "delete",
  cause: Error
): VaultStoreUncertainError {
  if (operation !== "write" && operation !== "delete") {
    throw new TypeError("Vault Store uncertain operation is invalid")
  }
  if (!(cause instanceof Error)) throw new TypeError("Vault Store uncertain cause is invalid")
  const error = new Error(`Vault Store ${operation} outcome is uncertain`, { cause })
  Object.defineProperties(error, {
    name: { enumerable: true, value: "VaultStoreUncertainError" },
    code: { enumerable: true, value: "LIKEGO_VAULT_STORE_UNCERTAIN" },
    operation: { enumerable: true, value: operation }
  })
  if (!isUncertainError(error)) throw new TypeError("Vault Store uncertain error decoration failed")
  return Object.freeze(error)
}

/** Creates one frozen real pagination snapshot Error. */
export function newSnapshotError(
  reason: VaultStoreSnapshotError["reason"]
): VaultStoreSnapshotError {
  if (reason !== "invalid-cursor" && reason !== "expired-cursor" && reason !== "capacity") {
    throw new TypeError("Vault Store snapshot reason is invalid")
  }
  const error = new Error(`Vault Store pagination snapshot failed: ${reason}`)
  Object.defineProperties(error, {
    name: { enumerable: true, value: "VaultStoreSnapshotError" },
    code: { enumerable: true, value: "LIKEGO_VAULT_STORE_SNAPSHOT" },
    reason: { enumerable: true, value: reason }
  })
  if (!isSnapshotError(error)) throw new TypeError("Vault Store snapshot error decoration failed")
  return Object.freeze(error)
}

/** Reports whether one failure requires exact mutation readback. */
export function isUncertainFailure(value: unknown): boolean {
  if (!(value instanceof Error)) return false
  if (isTransportError(value) || isProtocolError(value)) return true
  return (
    isHttpError(value) &&
    (value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500)
  )
}

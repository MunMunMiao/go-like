import {
  newVaultHttpError,
  newVaultProtocolError,
  newVaultTransportError,
  vaultHttpCode,
  vaultProtocolCode,
  vaultTransportCode,
  type VaultHttpError,
  type VaultProtocolError,
  type VaultTransportError
} from "../client/errors"
import { storeOperation, type VaultStoreWireOperation } from "../client/kv2"
import type { VaultStoreSnapshotError, VaultStoreUncertainError } from "./types"

const uncertainName: VaultStoreUncertainError["name"] = "VaultStoreUncertainError"
const uncertainCode: VaultStoreUncertainError["code"] = "GO_LIKE_VAULT_STORE_UNCERTAIN"
const snapshotName: VaultStoreSnapshotError["name"] = "VaultStoreSnapshotError"
const snapshotCode: VaultStoreSnapshotError["code"] = "GO_LIKE_VAULT_STORE_SNAPSHOT"

/** Narrows one public Vault wire operation token. */
function isOperation(value: unknown): value is VaultStoreWireOperation {
  return value === "read" || value === "write" || value === "delete" || value === "list"
}

/** Narrows one decorated Vault uncertain-mutation error. */
function isUncertainError(value: Error): value is VaultStoreUncertainError {
  return (
    value.name === "VaultStoreUncertainError" &&
    "code" in value &&
    value.code === "GO_LIKE_VAULT_STORE_UNCERTAIN" &&
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
    value.code === "GO_LIKE_VAULT_STORE_SNAPSHOT" &&
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

/** Creates one frozen HTTP error, prefixing the wire operation at the shared boundary. */
export function newHttpError(operation: VaultStoreWireOperation, status: number): VaultHttpError {
  if (!isOperation(operation) || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("Vault Store HTTP error details are invalid")
  }
  return newVaultHttpError(storeOperation(operation), status)
}

/** Creates one frozen protocol error, prefixing the wire operation at the shared boundary. */
export function newProtocolError(operation: VaultStoreWireOperation): VaultProtocolError {
  if (!isOperation(operation)) throw new TypeError("Vault Store protocol operation is invalid")
  return newVaultProtocolError(storeOperation(operation))
}

/** Creates one transport error and strips the rejection graph at a secret-bearing boundary. */
export function newTransportError(
  operation: VaultStoreWireOperation,
  value: unknown,
  sensitive: boolean
): VaultTransportError {
  if (!isOperation(operation)) throw new TypeError("Vault Store transport operation is invalid")
  return newVaultTransportError(storeOperation(operation), value, sensitive)
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
    name: { enumerable: true, value: uncertainName },
    code: { enumerable: true, value: uncertainCode },
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
    name: { enumerable: true, value: snapshotName },
    code: { enumerable: true, value: snapshotCode },
    reason: { enumerable: true, value: reason }
  })
  if (!isSnapshotError(error)) throw new TypeError("Vault Store snapshot error decoration failed")
  return Object.freeze(error)
}

/** Reports whether one failure requires exact mutation readback. */
export function isUncertainFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === vaultTransportCode || value.code === vaultProtocolCode) return true
  return (
    value.code === vaultHttpCode &&
    "status" in value &&
    typeof value.status === "number" &&
    (value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500)
  )
}

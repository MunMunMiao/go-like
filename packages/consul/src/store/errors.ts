import {
  consulHttpCode,
  consulProtocolCode,
  consulTransportCode,
  newConsulProtocolError,
  type ConsulProtocolError
} from "../client/errors"
import type {
  ConsulStoreUncertainError,
  ConsulStoreUnsupportedCombination,
  ConsulStoreUnsupportedCombinationError,
  ConsulStoreWireOperation
} from "./types"

const uncertainName: ConsulStoreUncertainError["name"] = "ConsulStoreUncertainError"
const uncertainCode: ConsulStoreUncertainError["code"] = "GO_LIKE_CONSUL_STORE_UNCERTAIN"
const combinationName: ConsulStoreUnsupportedCombinationError["name"] =
  "ConsulStoreUnsupportedCombinationError"
const combinationCode: ConsulStoreUnsupportedCombinationError["code"] =
  "GO_LIKE_CONSUL_STORE_UNSUPPORTED_COMBINATION"

/** Narrows a boundary rejection without stringifying arbitrary carrier graphs. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Prefixes a store wire operation for the shared protocol error. */
function storeOperation(operation: ConsulStoreWireOperation): `store.${ConsulStoreWireOperation}` {
  if (operation === "read") return "store.read"
  if (operation === "write") return "store.write"
  if (operation === "delete") return "store.delete"
  if (operation === "list") return "store.list"
  if (operation === "session-create") return "store.session-create"
  if (operation === "session-readback") return "store.session-readback"
  return "store.session-destroy"
}

/** Creates one immutable body-independent Consul protocol error for a store operation. */
export function newConsulStoreProtocolError(
  operation: ConsulStoreWireOperation
): ConsulProtocolError {
  return newConsulProtocolError(storeOperation(operation))
}

/** Creates one immutable mutation-uncertainty error after failed exact readback. */
export function newConsulStoreUncertainError(
  operation: ConsulStoreUncertainError["operation"],
  value: unknown
): ConsulStoreUncertainError {
  const cause = boundaryError(value, `Consul Store ${operation} outcome was uncertain`)
  return Object.freeze(
    Object.assign(new Error(`Consul Store ${operation} outcome could not be proven`), {
      name: uncertainName,
      code: uncertainCode,
      operation,
      cause
    })
  )
}

/** Creates one immutable Consul-specific unsupported-combination error. */
export function newConsulStoreUnsupportedCombinationError(
  combination: ConsulStoreUnsupportedCombination
): ConsulStoreUnsupportedCombinationError {
  if (combination !== "ttl-cas" && combination !== "cas-existing-ttl") {
    throw new TypeError("Consul Store unsupported combination is invalid")
  }
  return Object.freeze(
    Object.assign(new Error(`Consul Store combination ${combination} is unsupported`), {
      name: combinationName,
      code: combinationCode,
      combination
    })
  )
}

/** Reports whether a failure leaves a mutation outcome uncertain. */
export function isUncertainFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === consulTransportCode || value.code === consulProtocolCode) return true
  return (
    value.code === consulHttpCode &&
    "status" in value &&
    typeof value.status === "number" &&
    (value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500)
  )
}

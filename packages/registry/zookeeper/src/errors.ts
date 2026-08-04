import type {
  ZookeeperAuthenticationError,
  ZookeeperOperation,
  ZookeeperOperationError
} from "./types"

const operationName: ZookeeperOperationError["name"] = "ZookeeperOperationError"
const operationCode: ZookeeperOperationError["code"] = "GO_LIKE_ZOOKEEPER_OPERATION"
const authenticationName: ZookeeperAuthenticationError["name"] = "ZookeeperAuthenticationError"
const authenticationCode: ZookeeperAuthenticationError["code"] = "GO_LIKE_ZOOKEEPER_AUTHENTICATION"

/** Narrows an untrusted rejection without retaining a non-Error carrier. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates one secret-free native operation error. */
export function newOperationError(
  operation: ZookeeperOperation,
  nativeCode: number | null,
  retryable: boolean
): ZookeeperOperationError {
  return Object.freeze(
    Object.assign(new Error(`ZooKeeper ${operation} operation failed`), {
      name: operationName,
      code: operationCode,
      operation,
      nativeCode,
      retryable
    })
  )
}

/** Creates one stable credential-free authentication terminal. */
export function newAuthenticationError(): ZookeeperAuthenticationError {
  return Object.freeze(
    Object.assign(new Error("ZooKeeper authentication failed"), {
      name: authenticationName,
      code: authenticationCode
    })
  )
}

/** Reports whether one value is a retryable native availability failure. */
export function isRetryable(value: unknown): boolean {
  return (
    value instanceof Error &&
    "code" in value &&
    value.code === operationCode &&
    "retryable" in value &&
    value.retryable === true
  )
}

/** Reports whether one value represents an absent znode. */
export function isNoNode(value: unknown): boolean {
  return (
    value instanceof Error &&
    "code" in value &&
    value.code === operationCode &&
    "nativeCode" in value &&
    value.nativeCode === -101
  )
}

/** Reports whether one znode could not be removed because it still has children. */
export function isNotEmpty(value: unknown): boolean {
  return (
    value instanceof Error &&
    "code" in value &&
    value.code === operationCode &&
    "nativeCode" in value &&
    value.nativeCode === -111
  )
}

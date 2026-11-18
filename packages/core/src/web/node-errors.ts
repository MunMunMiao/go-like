export interface NodeServerAlreadyStartedError extends Error {
  readonly name: "NodeServerAlreadyStartedError"
  readonly code: "GO_LIKE_NODE_SERVER_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

export interface NodeServerForceCloseError extends Error {
  readonly name: "NodeServerForceCloseError"
  readonly code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE"
  readonly timeoutMs: number
  readonly activeConnections: number
}

export interface NodeServerUnexpectedCloseError extends Error {
  readonly name: "NodeServerUnexpectedCloseError"
  readonly code: "GO_LIKE_NODE_SERVER_UNEXPECTED_CLOSE"
}

/**
 * Narrows an unknown thrown value to a native Error across JavaScript realms.
 *
 * @param value - The value observed at an exception or event boundary.
 * @returns True when `value` is an Error recognized by the standard Error constructor.
 */
export function isError(value: unknown): value is Error {
  const isError = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  if (typeof isError !== "function") return value instanceof Error
  return isError(value) === true
}

/**
 * Preserves Error identity and wraps non-Error thrown values with a stable message and cause.
 *
 * @param value - The value to normalize.
 * @param message - The public message used only when wrapping a non-Error value.
 * @returns The original Error or a frozen wrapper whose `cause` is `value`.
 */
export function normalizeError(value: unknown, message: string): Error {
  if (isError(value)) return value
  return Object.freeze(new Error(message, { cause: value }))
}

/**
 * Creates the structural error returned when a one-shot Node Web server is started again.
 *
 * @param status - The lifecycle state observed by the rejected start call.
 * @returns A frozen error with the stable already-started code and status.
 */
export function newAlreadyStartedError(
  status: NodeServerAlreadyStartedError["status"]
): NodeServerAlreadyStartedError {
  const details: Pick<NodeServerAlreadyStartedError, "name" | "code" | "status"> = {
    name: "NodeServerAlreadyStartedError",
    code: "GO_LIKE_NODE_SERVER_ALREADY_STARTED",
    status
  }
  return Object.freeze(Object.assign(new Error("node web server has already started"), details))
}

/**
 * Creates the terminal error admitted when graceful drain exceeds its hard deadline.
 *
 * @param timeoutMs - Configured hard-drain budget in milliseconds.
 * @param activeConnections - Number of tracked sockets when force began.
 * @returns A frozen force-close error that remains the first terminal cause.
 */
export function newForceCloseError(
  timeoutMs: number,
  activeConnections: number
): NodeServerForceCloseError {
  const details: Pick<
    NodeServerForceCloseError,
    "name" | "code" | "timeoutMs" | "activeConnections"
  > = {
    name: "NodeServerForceCloseError",
    code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE",
    timeoutMs,
    activeConnections
  }
  return Object.freeze(
    Object.assign(new Error(`node web server force closed after ${timeoutMs}ms`), details)
  )
}

/**
 * Creates the terminal error admitted when the native host closes without owner shutdown.
 *
 * @returns A frozen unexpected-close error with a stable public code.
 */
export function newUnexpectedCloseError(): NodeServerUnexpectedCloseError {
  const details: Pick<NodeServerUnexpectedCloseError, "name" | "code"> = {
    name: "NodeServerUnexpectedCloseError",
    code: "GO_LIKE_NODE_SERVER_UNEXPECTED_CLOSE"
  }
  return Object.freeze(Object.assign(new Error("node web server closed unexpectedly"), details))
}

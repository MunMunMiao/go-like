/** Identifies one native runtime host in error names, codes, and diagnostics. */
export interface NativeRuntimeTag<Id extends string> {
  readonly id: Id
  readonly name: Capitalize<Id>
  readonly code: Uppercase<Id>
}

export interface NativeServerAlreadyStartedError<Id extends string> extends Error {
  readonly name: `${Capitalize<Id>}ServerAlreadyStartedError`
  readonly code: `GO_LIKE_${Uppercase<Id>}_SERVER_ALREADY_STARTED`
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

export interface NativeServerForceCloseError<Id extends string> extends Error {
  readonly name: `${Capitalize<Id>}ServerForceCloseError`
  readonly code: `GO_LIKE_${Uppercase<Id>}_SERVER_FORCE_CLOSE`
  readonly timeoutMs: number
  readonly activeRequests: number
}

export interface NativeServerUnexpectedCloseError<Id extends string> extends Error {
  readonly name: `${Capitalize<Id>}ServerUnexpectedCloseError`
  readonly code: `GO_LIKE_${Uppercase<Id>}_SERVER_UNEXPECTED_CLOSE`
}

/**
 * Creates the structural error returned when a one-shot native Web server is started again.
 *
 * @param tag - The runtime that owns the server.
 * @param status - The lifecycle state observed by the rejected start call.
 * @returns A frozen error with the stable already-started code and status.
 */
export function newAlreadyStartedError<Id extends string>(
  tag: NativeRuntimeTag<Id>,
  status: NativeServerAlreadyStartedError<Id>["status"]
): NativeServerAlreadyStartedError<Id> {
  const details: Pick<NativeServerAlreadyStartedError<Id>, "name" | "code" | "status"> = {
    name: `${tag.name}ServerAlreadyStartedError`,
    code: `GO_LIKE_${tag.code}_SERVER_ALREADY_STARTED`,
    status
  }
  return Object.freeze(
    Object.assign(new Error(`${tag.id} web server has already started`), details)
  )
}

/**
 * Creates the terminal error admitted when graceful drain exceeds its hard deadline.
 *
 * @param tag - The runtime that owns the server.
 * @param timeoutMs - Configured hard-drain budget in milliseconds.
 * @param activeRequests - Number of in-flight requests when force began.
 * @returns A frozen force-close error that remains the first terminal cause.
 */
export function newForceCloseError<Id extends string>(
  tag: NativeRuntimeTag<Id>,
  timeoutMs: number,
  activeRequests: number
): NativeServerForceCloseError<Id> {
  const details: Pick<
    NativeServerForceCloseError<Id>,
    "name" | "code" | "timeoutMs" | "activeRequests"
  > = {
    name: `${tag.name}ServerForceCloseError`,
    code: `GO_LIKE_${tag.code}_SERVER_FORCE_CLOSE`,
    timeoutMs,
    activeRequests
  }
  return Object.freeze(
    Object.assign(new Error(`${tag.id} web server force closed after ${timeoutMs}ms`), details)
  )
}

/**
 * Creates the terminal error admitted when the native host closes without owner shutdown.
 *
 * @param tag - The runtime that owns the server.
 * @returns A frozen unexpected-close error with a stable public code.
 */
export function newUnexpectedCloseError<Id extends string>(
  tag: NativeRuntimeTag<Id>
): NativeServerUnexpectedCloseError<Id> {
  const details: Pick<NativeServerUnexpectedCloseError<Id>, "name" | "code"> = {
    name: `${tag.name}ServerUnexpectedCloseError`,
    code: `GO_LIKE_${tag.code}_SERVER_UNEXPECTED_CLOSE`
  }
  return Object.freeze(
    Object.assign(new Error(`${tag.id} web server closed unexpectedly`), details)
  )
}

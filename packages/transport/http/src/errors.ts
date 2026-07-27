import { cause, type Context } from "@likego/context"
import { newTransportProtocolError } from "@likego/transport/provider"

import type { HTTPStatusError, HTTPTransportUnexpectedExitError } from "./types"

const MaximumStatusBodyBytes = 65_536
const ContentLengthPattern = /^(?:0|[1-9][0-9]*)$/

/** Recognizes standard Error objects across realms with a local fallback. */
function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return typeof candidate === "function" ? candidate(value) === true : value instanceof Error
}

/** Returns the exact active Context cause used at every HTTP boundary. */
export function contextError(ctx: Context): Error | null {
  const error = ctx.err()
  return error === null ? null : (cause(ctx) ?? error)
}

/** Exposes one once-safe reader cancellation and its synchronous borrowed-call phase. */
export interface HTTPReaderCancellation {
  /** Starts cancellation once and joins its real settlement. */
  readonly cancel: () => Promise<void>
  /** Installs the internal synchronous borrowed-call observer. */
  readonly observeInvoking: (observer: ((active: boolean) => void) | null) => void
}

/** Creates one identity-stable reader cancellation before borrowed code can reenter. */
export function readerCancellation(
  reader: ReadableStreamDefaultReader<Uint8Array>
): HTTPReaderCancellation {
  let cleanup: Promise<void> | null = null
  let invokeObserver: ((active: boolean) => void) | null = null
  return Object.freeze({
    /** Starts reader cancellation once and waits for its real returned work. */
    cancel(): Promise<void> {
      if (cleanup !== null) return cleanup
      let resolveCleanup: (() => void) | null = null
      let rejectCleanup: ((reason: unknown) => void) | null = null
      const sentinel = new Promise<void>(function capture(resolve, reject): void {
        resolveCleanup = resolve
        rejectCleanup = reject
      })
      cleanup = sentinel
      let work: Promise<void>
      try {
        const cancel = reader.cancel
        let returned: Promise<void>
        invokeObserver?.(true)
        try {
          returned = cancel.call(reader)
        } finally {
          invokeObserver?.(false)
        }
        work = Promise.resolve(returned)
      } catch (error) {
        work = Promise.reject(error)
      }
      work.then(
        function cancellationResolved(): void {
          resolveCleanup?.()
        },
        function cancellationRejected(error: unknown): void {
          rejectCleanup?.(error)
        }
      )
      return sentinel
    },
    /** Installs the owner handshake for the synchronous reader.cancel call only. */
    observeInvoking(observer: ((active: boolean) => void) | null): void {
      invokeObserver = observer
    }
  })
}

/** Normalizes one unknown rejection exactly once at an ownership boundary. */
export function normalizeHTTPError(value: unknown, message: string): Error {
  return isError(value) ? value : new Error(message)
}

/** Validates and detaches one standard Web Streams byte read result. */
export function snapshotHTTPBodyChunk(result: unknown, message: string): Uint8Array | null {
  if (typeof result !== "object" || result === null) {
    throw newTransportProtocolError(message)
  }
  let done: unknown
  let value: unknown
  try {
    done = Reflect.get(result, "done")
    if (done === true) return null
    value = Reflect.get(result, "value")
  } catch (error) {
    throw newTransportProtocolError(message, error instanceof Error ? error : undefined)
  }
  if (done !== false || !(value instanceof Uint8Array)) {
    throw newTransportProtocolError(message, value instanceof Error ? value : undefined)
  }
  try {
    return new Uint8Array(value)
  } catch (error) {
    throw newTransportProtocolError(message, error instanceof Error ? error : undefined)
  }
}

/** Rejects an invalid or oversized declared unary HTTP body length. */
export function assertHTTPContentLength(
  headers: Headers,
  maximumBytes: number,
  message: string
): void {
  let header: string | null
  try {
    header = headers.get("content-length")
  } catch (error) {
    throw newTransportProtocolError(message, error instanceof Error ? error : undefined)
  }
  if (header === null) return
  if (!ContentLengthPattern.test(header)) throw newTransportProtocolError(message)
  const declared = Number(header)
  if (!Number.isSafeInteger(declared) || declared > maximumBytes) {
    throw newTransportProtocolError(message)
  }
}

/** Adds one unary HTTP body chunk without crossing the configured message limit. */
export function boundedHTTPBodyLength(
  currentBytes: number,
  chunkBytes: number,
  maximumBytes: number,
  message: string
): number {
  if (chunkBytes > maximumBytes - currentBytes) throw newTransportProtocolError(message)
  return currentBytes + chunkBytes
}

/** Reads and validates one status-body byte chunk at the Web Streams boundary. */
async function readStatusChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<Uint8Array | null> {
  let result: unknown
  try {
    result = await reader.read()
  } catch (error) {
    throw newTransportProtocolError(
      "invalid HTTP status response body",
      error instanceof Error ? error : undefined
    )
  }
  return snapshotHTTPBodyChunk(result, "invalid HTTP status response body")
}

/** Reads at most 64 KiB plus one truncation signal from an owned Response body. */
async function boundedStatusBody(
  response: Response,
  registerCancel: ((cancel: HTTPReaderCancellation | null) => void) | null
): Promise<{
  readonly bytes: Uint8Array
  readonly truncated: boolean
}> {
  if (response.body === null) {
    return Object.freeze({ bytes: new Uint8Array(), truncated: false })
  }
  const reader = response.body.getReader()
  const cancellation = readerCancellation(reader)
  registerCancel?.(cancellation)
  const output = new Uint8Array(MaximumStatusBodyBytes)
  let offset = 0
  let truncated = false
  try {
    while (true) {
      const chunk = await readStatusChunk(reader)
      if (chunk === null) break
      const available = MaximumStatusBodyBytes - offset
      if (available > 0) {
        const length = Math.min(available, chunk.byteLength)
        output.set(chunk.subarray(0, length), offset)
        offset += length
      }
      if (chunk.byteLength > available || offset === MaximumStatusBodyBytes) {
        const next = chunk.byteLength > available ? null : await readStatusChunk(reader)
        truncated = chunk.byteLength > available || next !== null
        if (truncated) {
          try {
            await cancellation.cancel()
          } catch {
            // Status classification remains primary over best-effort truncation cleanup.
          }
        }
        break
      }
    }
  } finally {
    registerCancel?.(null)
    reader.releaseLock()
  }
  return Object.freeze({ bytes: output.slice(0, offset), truncated })
}

/** Creates a frozen bounded status error without retaining the Response. */
export async function newHTTPStatusError(
  response: Response,
  registerCancel: ((cancel: HTTPReaderCancellation | null) => void) | null = null
): Promise<HTTPStatusError> {
  const bounded = await boundedStatusBody(response, registerCancel)
  const retained = new Uint8Array(bounded.bytes)
  const error = new Error(`HTTP response status ${response.status}`)
  const details: Pick<
    HTTPStatusError,
    "name" | "code" | "status" | "statusText" | "body" | "bodyTruncated"
  > = {
    name: "HTTPStatusError",
    code: "LIKEGO_HTTP_STATUS",
    status: response.status,
    statusText: response.statusText,
    body: new Uint8Array(retained),
    bodyTruncated: bounded.truncated
  }
  const statusError = Object.assign(error, details)
  Object.defineProperty(statusError, "body", {
    configurable: false,
    enumerable: true,
    /** Returns detached bounded response bytes for every read. */
    get(): Uint8Array {
      return new Uint8Array(retained)
    }
  })
  return Object.freeze(statusError)
}

/** Creates a stable unexpected terminal error for a host side with no upstream Error. */
export function newHTTPTransportUnexpectedExitError(
  source: "serve" | "host",
  phase: "before-ready" | "running"
): HTTPTransportUnexpectedExitError {
  const error = new Error(`HTTP ${source} ended unexpectedly during ${phase}`)
  const details: Pick<HTTPTransportUnexpectedExitError, "name" | "code" | "source" | "phase"> = {
    name: "HTTPTransportUnexpectedExitError",
    code: "LIKEGO_HTTP_TRANSPORT_UNEXPECTED_EXIT",
    source,
    phase
  }
  return Object.freeze(Object.assign(error, details))
}

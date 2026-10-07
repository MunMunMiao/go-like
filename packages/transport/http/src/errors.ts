import { cause, type Context } from "@go-like/context"
import { newTransportProtocolError } from "@go-like/transport/provider"

import type { HTTPTransportUnexpectedExitError } from "./types"

const ContentLengthPattern = /^(?:0|[1-9][0-9]*)$/

/** Recognizes standard Error objects across realms with a local fallback. */
export function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return typeof candidate === "function" ? candidate(value) === true : value instanceof Error
}

/** Returns the exact active Context cause used at every HTTP boundary. */
export function contextError(ctx: Context): Error | null {
  const error = ctx.err()
  return error === null ? null : (cause(ctx) ?? error)
}

/** Normalizes one unknown rejection exactly once at an ownership boundary. */
export function normalizeHTTPError(value: unknown, message: string): Error {
  return isError(value) ? value : new Error(message, { cause: value })
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

/** Creates a stable unexpected terminal error for a host side with no upstream Error. */
export function newHTTPTransportUnexpectedExitError(
  source: "serve" | "host",
  phase: "before-ready" | "running"
): HTTPTransportUnexpectedExitError {
  const error = new Error(`HTTP ${source} ended unexpectedly during ${phase}`)
  const details: Pick<HTTPTransportUnexpectedExitError, "name" | "code" | "source" | "phase"> = {
    name: "HTTPTransportUnexpectedExitError",
    code: "GO_LIKE_HTTP_TRANSPORT_UNEXPECTED_EXIT",
    source,
    phase
  }
  return Object.freeze(Object.assign(error, details))
}

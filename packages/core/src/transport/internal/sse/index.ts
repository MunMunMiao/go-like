import {
  createLineParser,
  createMessageParser,
  readStreamBytes,
  SSEParserLimitError,
  type EventStreamMessage,
  type LineParserOptions,
  type MessageParserOptions
} from "./parser"

const encoder = new TextEncoder()

/** Default per-event byte ceiling used when a transport does not publish its own. */
export const defaultSSEMaxMessageBytes = 4 * 1024 * 1024

/** Media type of a server-streaming RPC response. */
export const eventStreamContentType = "text/event-stream"

/** Encodes one SSE comment, including its terminating blank line. */
export function encodeSSEComment(comment = ""): Uint8Array {
  if (comment.includes("\r") || comment.includes("\n")) {
    throw new TypeError("SSE comment must not contain a line break")
  }
  return encoder.encode(`:${comment}\n\n`)
}

/** Encodes one SSE event. RPC data stays on a single line. */
export function encodeSSEEvent(data: string, event?: string): Uint8Array {
  if (data.includes("\r") || data.includes("\n")) {
    throw new TypeError("SSE RPC event data must be one line")
  }
  if (event !== undefined && (event.length === 0 || event.includes("\r") || event.includes("\n"))) {
    throw new TypeError("SSE event name must be a non-empty line-safe string")
  }
  return encoder.encode(`${event === undefined ? "" : `event: ${event}\n`}data: ${data}\n\n`)
}

/** Encodes one JSON-valued SSE event. */
export function encodeSSEJsonEvent(value: unknown, event?: string): Uint8Array {
  return encodeSSEEvent(JSON.stringify(value), event)
}

export { createLineParser, createMessageParser, readStreamBytes, SSEParserLimitError }
export type { EventStreamMessage, LineParserOptions, MessageParserOptions }

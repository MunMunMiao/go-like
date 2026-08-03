import type { Message } from "@likego/transport"
import {
  newTransportProtocolError,
  snapshotMessage,
  type TransportProtocolError
} from "@likego/transport/provider"

const ManagedHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
])

/** Identifies one normalized wire header entry. */
export type HTTPHeaderEntry = readonly [string, string]

/** Normalizes one header boundary failure into a protocol error. */
function headerError(message: string, cause: unknown): TransportProtocolError {
  return cause instanceof Error
    ? newTransportProtocolError(message, cause)
    : newTransportProtocolError(message)
}

/** Creates Fetch-managed request Headers from one defensive Message snapshot. */
export function requestHeaders(message: Message): {
  readonly message: Message
  readonly headers: Headers
} {
  let snapshot: Message
  try {
    snapshot = snapshotMessage(message)
  } catch (error) {
    throw headerError("invalid HTTP request Message", error)
  }
  const headers = new Headers()
  try {
    for (const entry of Object.entries(snapshot.header)) {
      if (ManagedHeaders.has(entry[0].toLowerCase())) {
        throw newTransportProtocolError(`HTTP request header is Fetch-managed: ${entry[0]}`)
      }
      headers.set(entry[0], entry[1])
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "LIKEGO_TRANSPORT_PROTOCOL") {
      throw error
    }
    throw headerError("invalid HTTP request header", error)
  }
  return Object.freeze({ message: snapshot, headers })
}

/** Copies one standard Headers collection into a frozen lower-cased record. */
export function snapshotResponseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const entries: [string, string][] = []
  try {
    headers.forEach(function collect(value, key): void {
      entries.push([key, value])
    })
  } catch (error) {
    throw headerError("invalid HTTP response headers", error)
  }
  return Object.freeze(Object.fromEntries(entries))
}

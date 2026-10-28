import type { Context } from "@go-like/context"
import { newMetadata, type Metadata } from "@go-like/metadata"
import { newServerContext, type TransportInfo } from "@go-like/transport"

const EmptyMetadata = newMetadata()

/** Projects standard Headers for observation without turning observation into a wire gate. */
function headerMetadata(headers: Headers): Metadata {
  try {
    const grouped = new Map<string, string[]>()
    for (const [key, value] of headers.entries()) {
      const values = grouped.get(key)
      if (values === undefined) grouped.set(key, [value])
      else values.push(value)
    }
    return newMetadata(Object.fromEntries(grouped))
  } catch {
    return EmptyMetadata
  }
}

/** Returns the request pathname without one leading slash. */
function operation(url: string): string {
  const path = new URL(url).pathname
  return path.startsWith("/") ? path.slice(1) : path
}

/** Adds truthful HTTP server transport facts when they satisfy the public observation contract. */
export function withHTTPServerTransportInfo(
  ctx: Context,
  endpoint: string,
  request: Request,
  response: () => Response | null,
  peerIdentity: string | null
): Context {
  // Snapshot the dispatch-time headers; project them to Metadata only when observed.
  const dispatchHeaders = new Headers(request.headers)
  let requestMetadata: Metadata | null = null
  const info: TransportInfo = Object.freeze({
    /** Returns the provider-neutral protocol kind. */
    kind(): string {
      return "http"
    },
    /** Returns the actual bound listener endpoint. */
    endpoint(): string {
      return endpoint
    },
    /** Returns the pathname operation, without a leading slash. */
    operation(): string {
      return operation(request.url)
    },
    /** Returns the request headers visible at dispatch. */
    requestHeaders(): Metadata {
      requestMetadata ??= headerMetadata(dispatchHeaders)
      return requestMetadata
    },
    /** Returns response headers produced so far, if any. */
    replyHeaders(): Metadata {
      const current = response()
      return current === null ? EmptyMetadata : headerMetadata(current.headers)
    },
    /** Returns the verified URI SAN captured for this connection, or null. */
    peerIdentity(): string | null {
      return peerIdentity
    }
  })
  try {
    return newServerContext(ctx, info)
  } catch {
    return ctx
  }
}

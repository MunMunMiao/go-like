import type { Context } from "@go-like/context"
import { newMetadata, type Metadata } from "@go-like/metadata"
import { newServerContext, type TransportInfo } from "@go-like/transport"

const emptyMetadata = newMetadata()

/** Projects standard Headers for observation without turning observation into a protocol gate. */
function headerMetadata(headers: Headers): Metadata {
  const grouped = new Map<string, string[]>()
  for (const [key, value] of headers.entries()) {
    const values = grouped.get(key)
    if (values === undefined) grouped.set(key, [value])
    else values.push(value)
  }
  return newMetadata(Object.fromEntries(grouped))
}

/** Derives the internal operation from the request pathname without a leading slash. */
function operation(url: string): string {
  const pathname = new URL(url).pathname
  return pathname.startsWith("/") ? pathname.slice(1) : pathname
}

/** Carries truthful server-side memory transport facts without exposing mutable provider state. */
export function withMemoryServerTransportInfo(
  ctx: Context,
  endpoint: string,
  request: Request,
  reply: () => Response | null
): Context {
  try {
    // Snapshot the dispatch-time headers; project them to Metadata only when observed.
    const dispatchHeaders = new Headers(request.headers)
    let requestMetadata: Metadata | null = null
    const requestOperation = operation(request.url)
    const info: TransportInfo = Object.freeze({
      /** Returns the stable provider kind. */
      kind(): string {
        return "memory"
      },
      /** Returns the actual bound process-local address. */
      endpoint(): string {
        return endpoint
      },
      /** Returns the operation carried by the request pathname. */
      operation(): string {
        return requestOperation
      },
      /** Returns the detached request header observation. */
      requestHeaders(): Metadata {
        requestMetadata ??= headerMetadata(dispatchHeaders)
        return requestMetadata
      },
      /** Returns the reply headers visible after the handler produces a Response. */
      replyHeaders(): Metadata {
        const current = reply()
        return current === null ? emptyMetadata : headerMetadata(current.headers)
      },
      /** Memory exchanges have no authenticated peer. */
      peerIdentity(): string | null {
        return null
      }
    })
    return newServerContext(ctx, info)
  } catch {
    return ctx
  }
}

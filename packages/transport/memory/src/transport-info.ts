import type { Context } from "@likego/context"
import { newMetadata, type Metadata } from "@likego/metadata"
import { newServerContext, type Message, type TransportInfo } from "@likego/transport"
import { endpoint as endpointHeader, request as serviceHeader } from "@likego/transport/headers"

const emptyMetadata = newMetadata()

/** Projects one Message header without turning observability into a protocol gate. */
function headerMetadata(header: Readonly<Record<string, string>>): Metadata {
  const grouped = new Map<string, string[]>()
  for (const [key, value] of Object.entries(header)) {
    const normalized = key.toLowerCase()
    const values = grouped.get(normalized)
    if (values === undefined) grouped.set(normalized, [value])
    else values.push(value)
  }
  return newMetadata(Object.fromEntries(grouped))
}

/** Reads an unambiguous case-insensitive routing header. */
function routingHeader(header: Readonly<Record<string, string>>, name: string): string | null {
  const expected = name.toLowerCase()
  let found: string | null = null
  for (const [key, value] of Object.entries(header)) {
    if (key.toLowerCase() !== expected) continue
    if (found !== null) return null
    found = value
  }
  return found
}

/** Derives the internal operation carried by the LikeGo routing headers. */
function operation(header: Readonly<Record<string, string>>): string {
  const service = routingHeader(header, serviceHeader)
  const endpoint = routingHeader(header, endpointHeader)
  return service === null || endpoint === null ? "" : `${service}/${endpoint}`
}

/** Carries truthful server-side memory transport facts without exposing mutable provider state. */
export function withMemoryServerTransportInfo(
  ctx: Context,
  endpoint: string,
  request: Message,
  reply: () => Message | null
): Context {
  try {
    const requestMetadata = headerMetadata(request.header)
    const requestOperation = operation(request.header)
    const info: TransportInfo = Object.freeze({
      /** Returns the stable provider kind. */
      kind(): string {
        return "memory"
      },
      /** Returns the actual bound process-local address. */
      endpoint(): string {
        return endpoint
      },
      /** Returns the operation carried on this exchange. */
      operation(): string {
        return requestOperation
      },
      /** Returns the detached request header observation. */
      requestHeaders(): Metadata {
        return requestMetadata
      },
      /** Returns the reply headers emitted so far. */
      replyHeaders(): Metadata {
        try {
          const current = reply()
          return current === null ? emptyMetadata : headerMetadata(current.header)
        } catch {
          return emptyMetadata
        }
      }
    })
    return newServerContext(ctx, info)
  } catch {
    return ctx
  }
}

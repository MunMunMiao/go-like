import type { Context } from "@likego/context"
import { newMetadata, type Metadata } from "@likego/metadata"
import { newServerContext, type TransportInfo } from "@likego/transport"
import { endpoint as endpointHeader, request as serviceHeader } from "@likego/transport/headers"

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

/** Reads the internal service operation carried by the HTTP routing headers. */
function operation(headers: Headers): string {
  try {
    const service = headers.get(serviceHeader)
    const endpoint = headers.get(endpointHeader)
    return service === null || endpoint === null ? "" : `${service}/${endpoint}`
  } catch {
    return ""
  }
}

/** Adds truthful HTTP server transport facts when they satisfy the public observation contract. */
export function withHTTPServerTransportInfo(
  ctx: Context,
  endpoint: string,
  request: Request,
  response: () => Response | null
): Context {
  const requestMetadata = headerMetadata(request.headers)
  const info: TransportInfo = Object.freeze({
    /** Returns the provider-neutral protocol kind. */
    kind(): string {
      return "http"
    },
    /** Returns the actual bound listener endpoint. */
    endpoint(): string {
      return endpoint
    },
    /** Returns the internal service operation carried on this request. */
    operation(): string {
      return operation(request.headers)
    },
    /** Returns the request headers visible at dispatch. */
    requestHeaders(): Metadata {
      return requestMetadata
    },
    /** Returns response headers produced so far, if any. */
    replyHeaders(): Metadata {
      const current = response()
      return current === null ? EmptyMetadata : headerMetadata(current.headers)
    }
  })
  try {
    return newServerContext(ctx, info)
  } catch {
    return ctx
  }
}

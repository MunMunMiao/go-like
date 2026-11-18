import type { Fetch } from "@go-like/core/fetch"

/** Immutable connection captured once by newKubernetesClient. */
export interface Connection {
  readonly fetch: Fetch
  readonly origin: string
  readonly token: string | undefined
}

/** Validates one optional bearer token without reflecting its bytes. */
function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new TypeError("Kubernetes token must be a non-empty HTTP header value")
  }
  try {
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${value}`)
  } catch {
    throw new TypeError("Kubernetes token must be a valid HTTP header value")
  }
  return value
}

/** Canonicalizes one credentials-free and path-free HTTP(S) API origin. */
export function kubernetesOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("Kubernetes address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Kubernetes address must be a valid HTTP or HTTPS origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Kubernetes address must use HTTP or HTTPS")
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("?") ||
    value.includes("#") ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new TypeError(
      "Kubernetes address must be an origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Captures fetch, origin, and token once, before any I/O. */
export function captureConnection(value: {
  readonly fetch: Fetch
  readonly address: string
  readonly token?: string
}): Connection {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Kubernetes client options must be an object")
  }
  const fetch = value.fetch
  const address = value.address
  const token = value.token
  if (typeof fetch !== "function")
    throw new TypeError("Kubernetes Fetch capability must be callable")
  return Object.freeze({
    fetch,
    origin: kubernetesOrigin(address),
    token: bearerToken(token)
  })
}

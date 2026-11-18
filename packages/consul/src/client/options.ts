import type { Fetch } from "@go-like/core/fetch"

/** Immutable connection captured once by newConsulClient. */
export interface Connection {
  readonly fetch: Fetch
  readonly origin: string
  readonly token: string | undefined
  readonly datacenter: string | undefined
  readonly namespace: string | undefined
}

/** Validates one optional non-empty Consul scope without normalization. */
function optionalScope(value: string | undefined, name: string): string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`Consul ${name} must be a non-empty string`)
  }
  return value
}

/** Validates one ACL token as an HTTP header without reflecting its bytes. */
function aclToken(value: string | undefined): string | undefined {
  optionalScope(value, "token")
  if (value === undefined) return undefined
  try {
    const headers = new Headers()
    headers.set("X-Consul-Token", value)
  } catch {
    throw new TypeError("Consul token must be a valid HTTP header value")
  }
  return value
}

/** Canonicalizes one credentials-free, path-free HTTP(S) origin. */
export function consulOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("Consul address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Consul address must be a valid HTTP or HTTPS origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Consul address must use HTTP or HTTPS")
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(
      "Consul address must be an origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Captures fetch, origin, token, and scope once, before any I/O. */
export function captureConnection(value: {
  readonly fetch: Fetch
  readonly address: string
  readonly token?: string
  readonly datacenter?: string
  readonly namespace?: string
}): Connection {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Consul client options must be an object")
  }
  const fetch = value.fetch
  const address = value.address
  const token = value.token
  const datacenter = value.datacenter
  const namespace = value.namespace
  if (typeof fetch !== "function") throw new TypeError("Consul Fetch capability must be callable")
  return Object.freeze({
    fetch,
    origin: consulOrigin(address),
    token: aclToken(token),
    datacenter: optionalScope(datacenter, "datacenter"),
    namespace: optionalScope(namespace, "namespace")
  })
}
